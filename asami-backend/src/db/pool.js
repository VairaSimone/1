const mysql = require("mysql2/promise");
const { env } = require("../config/env");

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

async function ping() {
  const [rows] = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
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

module.exports = { pool, ping, withTransaction, close };
