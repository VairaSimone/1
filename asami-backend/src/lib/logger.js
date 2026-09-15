const pino = require("pino");
const { env } = require("../config/env");

module.exports = pino({
  level: env.LOG_LEVEL,
  base: { service: "asami-backend" },
  timestamp: pino.stdTimeFunctions.isoTime
});
