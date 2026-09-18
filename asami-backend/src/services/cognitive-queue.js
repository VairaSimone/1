const queues = new Map();

function isRetryableError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toUpperCase();
  return [
    "OPTIMISTIC_LOCK",
    "ER_LOCK_DEADLOCK",
    "ER_LOCK_WAIT_TIMEOUT",
    "PROTOCOL_CONNECTION_LOST",
    "ECONNRESET",
    "ETIMEDOUT"
  ].some(token => code.includes(token) || message.includes(token));
}

async function runWithRetry(task, { retries = 3, baseDelayMs = 10 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) throw error;
      const delay = baseDelayMs * (2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("Cognitive task failed without an error");
}

function enqueue(entityId, task, options = {}) {
  const key = String(entityId || "global");
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => runWithRetry(task, options))
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });

  queues.set(key, next);
  return next;
}

function pendingCount(entityId = null) {
  if (entityId !== null && entityId !== undefined) return queues.has(String(entityId)) ? 1 : 0;
  return queues.size;
}

module.exports = { enqueue, runWithRetry, isRetryableError, pendingCount };
