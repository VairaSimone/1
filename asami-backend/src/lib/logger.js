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

const throttledLogState = new Map();

function throttledLog(level, key, intervalMs, object, message) {
  const now = Date.now();
  const normalizedKey = String(key || message || level);
  const interval = Math.max(1000, Number(intervalMs) || 60000);
  const previous = throttledLogState.get(normalizedKey);

  if (previous && now - previous.lastLoggedAt < interval) {
    previous.suppressed += 1;
    return false;
  }

  const suppressed = previous?.suppressed || 0;
  throttledLogState.set(normalizedKey, { lastLoggedAt: now, suppressed: 0 });

  const payload = suppressed > 0
    ? {
        ...(object && typeof object === "object" ? object : {}),
        suppressedCount: suppressed
      }
    : object;

  logger[level](payload, suppressed > 0
    ? `${message} (repeated logs suppressed)`
    : message
  );
  return true;
}

logger.normalizeError = normalizeError;
logger.contextError = contextError;

logger.infoThrottled = (key, intervalMs, object, message) =>
  throttledLog("info", key, intervalMs, object, message);
logger.warnThrottled = (key, intervalMs, object, message) =>
  throttledLog("warn", key, intervalMs, object, message);
logger.debugThrottled = (key, intervalMs, object, message) =>
  throttledLog("debug", key, intervalMs, object, message);
logger.clearThrottleState = () => throttledLogState.clear();

module.exports = logger;
