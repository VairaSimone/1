const mysql = require("mysql2/promise");
const { env } = require("../config/env");

const TRANSIENT_DB_ERRORS = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH"
]);
const databaseHealth = {
  status: "UNKNOWN",
  lastTransitionAt: 0,
  lastErrorCode: null,
  consecutiveFailures: 0
};

function isTransientDatabaseError(err) {
  return TRANSIENT_DB_ERRORS.has(String(err?.code || "").toUpperCase());
}

function markDatabaseHealthy() {
  if (databaseHealth.status !== "HEALTHY") {
    databaseHealth.lastTransitionAt = Date.now();
  }
  databaseHealth.status = "HEALTHY";
  databaseHealth.lastErrorCode = null;
  databaseHealth.consecutiveFailures = 0;
}

function markDatabaseDegraded(err = null) {
  const code = String(err?.code || "").toUpperCase() || "UNKNOWN_DB_ERROR";
  databaseHealth.status = "DEGRADED";
  databaseHealth.lastTransitionAt = Date.now();
  databaseHealth.lastErrorCode = code;
  databaseHealth.consecutiveFailures += 1;
}

function getDatabaseHealth() {
  return { ...databaseHealth };
}

function retryDelayMs(attempt) {
  const base = Math.max(25, Number(env.DB_RETRY_BASE_MS) || 250);
  const maximum = Math.max(base, Number(env.DB_RETRY_MAX_MS) || 5000);
  const exponential = Math.min(maximum, base * (2 ** Math.max(0, attempt)));
  const jitter = exponential * 0.2 * Math.random();
  return Math.min(maximum, Math.round(exponential + jitter));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeSimulationTimestamp(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return value;
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return value;
  const pad = n => String(n).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;
}

function normalizeMysqlValues(values) {
  if (Array.isArray(values)) return values.map(normalizeMysqlTimestampDeep);
  if (values && typeof values === "object") {
    const normalized = { ...values };
    for (const key of Object.keys(normalized)) normalized[key] = normalizeMysqlTimestampDeep(normalized[key]);
    return normalized;
  }
  return normalizeSimulationTimestamp(values);
}

function normalizeMysqlTimestampDeep(value) {
  return Array.isArray(value)
    ? value.map(normalizeMysqlTimestampDeep)
    : value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)
      ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeMysqlTimestampDeep(nested)]))
      : normalizeSimulationTimestamp(value);
}

const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_POOL_SIZE,
  queueLimit: 0,
  connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
  namedPlaceholders: false,
  timezone: "Z",
  dateStrings: false
});

const originalPoolQuery = pool.query.bind(pool);
pool.query = async (sql, values) => {
  try {
    const result = await originalPoolQuery(sql, normalizeMysqlValues(values));
    markDatabaseHealthy();
    return result;
  } catch (err) {
    if (isTransientDatabaseError(err)) markDatabaseDegraded(err);
    throw err;
  }
};

const originalGetConnection = pool.getConnection.bind(pool);
pool.getConnection = async () => {
  try {
    const conn = await originalGetConnection();
    const originalConnectionQuery = conn.query.bind(conn);
    conn.query = async (sql, values) => {
      try {
        const result = await originalConnectionQuery(sql, normalizeMysqlValues(values));
        markDatabaseHealthy();
        return result;
      } catch (err) {
        if (isTransientDatabaseError(err)) markDatabaseDegraded(err);
        throw err;
      }
    };
    markDatabaseHealthy();
    return conn;
  } catch (err) {
    if (isTransientDatabaseError(err)) markDatabaseDegraded(err);
    throw err;
  }
};

async function ping() {
  const [rows] = await pool.query("SELECT 1 AS ok");
  const healthy = rows[0]?.ok === 1;
  if (healthy) markDatabaseHealthy();
  return healthy;
}

async function pingWithRetry({ attempts = env.DB_RETRY_ATTEMPTS, throwNonTransient = true } = {}) {
  const totalAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      if (await ping()) return true;
    } catch (err) {
      if (!isTransientDatabaseError(err) && throwNonTransient) throw err;
      if (isTransientDatabaseError(err)) markDatabaseDegraded(err);
    }
    if (attempt < totalAttempts - 1) await sleep(retryDelayMs(attempt));
  }
  return false;
}

async function getConnectionWithRetry({ attempts = env.DB_RETRY_ATTEMPTS } = {}) {
  const totalAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError = null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      return await pool.getConnection();
    } catch (err) {
      lastError = err;
      if (!isTransientDatabaseError(err) || attempt >= totalAttempts - 1) throw err;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError || new Error("Database connection acquisition failed");
}

async function withTransaction(fn) {
  const conn = await getConnectionWithRetry();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  ping,
  pingWithRetry,
  withTransaction,
  close,
  normalizeSimulationTimestamp,
  normalizeMysqlValues,
  isTransientDatabaseError,
  getDatabaseHealth,
  getConnectionWithRetry
};
