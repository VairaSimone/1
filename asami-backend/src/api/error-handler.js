const crypto = require("crypto");
const logger = require("../lib/logger");

function errorHandler(err, req, res, next) {
  const errorId = crypto.randomUUID();
  const status = err.code === "NOT_FOUND" ? 404
    : err.code === "OPTIMISTIC_LOCK" ? 409
    : err.code === "OPERATION_IN_PROGRESS" ? 409
    : err.name === "ZodError" ? 400
    : Number.isInteger(err.statusCode) ? err.statusCode
    : 500;

  const safeDetails = err.name === "ZodError"
    ? err.issues
    : err.code === "ER_DUP_ENTRY"
      ? { database: "duplicate_entry" }
      : undefined;

  logger.error(logger.contextError({
    errorId,
    request: {
      method: req.method,
      path: req.path,
      requestId: req.id || req.headers["x-request-id"] || null
    },
    statusCode: status,
    errorCode: err.code || null
  }, err, "request failed"));

  const response = {
    errorId,
    error: status >= 500 ? "Internal server error" : (err.message || "Request failed"),
    code: err.code || err.name || "ERROR",
    statusCode: status
  };

  if (safeDetails !== undefined) response.details = safeDetails;
  if (process.env.NODE_ENV !== "production" && err.stack) response.debug = { stack: err.stack };

  res.status(status).json(response);
}

module.exports = { errorHandler };
