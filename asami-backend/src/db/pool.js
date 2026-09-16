const mysql = require("mysql2/promise");
const { env } = require("../config/env");

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
pool.query = (sql, values) => originalPoolQuery(sql, normalizeMysqlValues(values));

async function ping() {
  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  const originalConnectionQuery = conn.query.bind(conn);
  conn.query = (sql, values) => originalConnectionQuery(sql, normalizeMysqlValues(values));
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

module.exports = { pool, ping, withTransaction, close, normalizeSimulationTimestamp, normalizeMysqlValues };
