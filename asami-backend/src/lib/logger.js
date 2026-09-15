const pino = require("pino");
const { env } = require("../config/env");

function normalizeError(err) {
  if (!err) return null;
  return {
    type: err.type || err.name || "Error",
    code: err.code || null,
    message: err.message || String(err),
    stack: err.stack || null,
    statusCode: err.statusCode || err.status || null,
    errno: err.errno || null,
    sqlState: err.sqlState || null,
    sqlMessage: err.sqlMessage || null
  };
}

function contextError(context, err, message = "operation failed") {
  return {
    ...context,
    err: normalizeError(err),
    msg: message
  };
}

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "asami-backend" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "request.headers.authorization",
      "headers.authorization",
      "password",
      "token",
      "apiKey",
      "GEMINI_API_KEY"
    ],
    censor: "[REDACTED]"
  },
  serializers: {
    err: normalizeError
  }
});

logger.normalizeError = normalizeError;
logger.contextError = contextError;

module.exports = logger;
