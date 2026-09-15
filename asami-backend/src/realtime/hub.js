const logger = require("../lib/logger");

class RealtimeHub {
  constructor() {
    this.clients = new Set();
  }
  attach(ws, simulationId) {
    const client = { ws, simulationId };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    return () => this.clients.delete(client);
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
      try {
        if (client.ws.readyState === 1) client.ws.send(message);
      } catch (err) {
        logger.warn({ err, simulationId, type }, "websocket send failed");
      }
    }
  }
}

module.exports = { RealtimeHub };
