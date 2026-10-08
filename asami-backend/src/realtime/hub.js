const logger = require("../lib/logger");
const EXPECTED_DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "ECANCELED",
  "EPIPE",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_SOCKET_CLOSED",
  "ABORT_ERR"
]);

function socketFailureCode(error) {
  return String(error?.code || error?.name || "").trim().toUpperCase();
}

function isExpectedDisconnect(error, ws) {
  const code = socketFailureCode(error);
  return EXPECTED_DISCONNECT_CODES.has(code) || !ws || ws.readyState !== 1;
}

class RealtimeHub {
  constructor() {
    this.clients = new Set();
    this.sequenceBySimulation = new Map();
    this.simulationVersionBySimulation = new Map();
  }
  attach(ws, simulationId) {
    const client = { ws, simulationId };
    this.clients.add(client);

    const logSocketError = (err) => {
      this.clients.delete(client);
      if (isExpectedDisconnect(err, ws)) {
        logger.debug(
          { simulationId, code: socketFailureCode(err) || null },
          "websocket client disconnected"
        );
        return;
      }
      logger.warnThrottled(
        `realtime:websocket-error:${simulationId}`,
        60000,
        { err, simulationId },
        "websocket connection error"
      );
    };

    ws.on("error", logSocketError);
    ws.on("close", () => this.clients.delete(client));
    return () => {
      this.clients.delete(client);
      try { ws.removeListener("error", logSocketError); } catch {}
    };
  }

  setSimulationVersion(simulationId, version) {
    const numeric = Number(version);
    if (!Number.isFinite(numeric)) return;
    this.simulationVersionBySimulation.set(simulationId, numeric);
  }

  getSequence(simulationId) {
    return Number(this.sequenceBySimulation.get(simulationId) || 0);
  }

  publish(simulationId, type, payload) {
    const sequence=(this.sequenceBySimulation.get(simulationId)||0)+1;
    this.sequenceBySimulation.set(simulationId,sequence);
    const payloadVersion = payload && typeof payload === "object" ? Number(payload.simulationVersion) : Number.NaN;
    if (Number.isFinite(payloadVersion)) this.setSimulationVersion(simulationId,payloadVersion);
    const simulationVersion=this.simulationVersionBySimulation.get(simulationId) ?? null;
    const message = JSON.stringify({
      type,
      simulationId,
      sequence,
      eventSequence:sequence,
      simulationVersion,
      occurredAt: new Date().toISOString(),
      payload
    });

    for (const client of this.clients) {
      if (client.simulationId !== simulationId) continue;

      if (client.ws.readyState !== 1) {
        if (client.ws.readyState === 2 || client.ws.readyState === 3) {
          this.clients.delete(client);
        }
        continue;
      }

      try {
        client.ws.send(message, (err) => {
          if (!err) return;
          this.clients.delete(client);
          if (isExpectedDisconnect(err, client.ws)) {
            logger.debug(
              { simulationId, type, code: socketFailureCode(err) || null },
              "websocket client disconnected during realtime delivery"
            );
            return;
          }
          logger.warnThrottled(
            `realtime:websocket-send:${simulationId}:${type}`,
            60000,
            { err, simulationId, type },
            "websocket send failed"
          );
        });
      } catch (err) {
        this.clients.delete(client);
        if (isExpectedDisconnect(err, client.ws)) {
          logger.debug(
            { simulationId, type, code: socketFailureCode(err) || null },
            "websocket client disconnected during realtime delivery"
          );
          continue;
        }
        logger.warnThrottled(
          `realtime:websocket-send:${simulationId}:${type}`,
          60000,
          { err, simulationId, type },
          "websocket send failed"
        );
      }
    }
  }
}

module.exports = { RealtimeHub };
