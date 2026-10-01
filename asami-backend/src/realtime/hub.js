const logger = require("../lib/logger");

class RealtimeHub {
  constructor() {
    this.clients = new Set();
  }
  attach(ws, simulationId) {
    const client = { ws, simulationId };
    this.clients.add(client);

    const logSocketError = (err) => {
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

  publish(simulationId, type, payload) {
    const message = JSON.stringify({
      type,
      simulationId,
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
          logger.warnThrottled(
            `realtime:websocket-send:${simulationId}:${type}`,
            60000,
            { err, simulationId, type },
            "websocket send failed"
          );
          this.clients.delete(client);
        });
      } catch (err) {
        logger.warnThrottled(
          `realtime:websocket-send:${simulationId}:${type}`,
          60000,
          { err, simulationId, type },
          "websocket send failed"
        );
        this.clients.delete(client);
      }
    }
  }
}

module.exports = { RealtimeHub };
