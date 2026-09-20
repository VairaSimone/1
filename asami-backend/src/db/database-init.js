const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { env } = require("../config/env");
const logger = require("../lib/logger");

const DATABASE_DIR = path.resolve(__dirname, "../../database");
const SCHEMA_PARTS = Array.from({ length: 19 }, (_, index) =>
  path.join(DATABASE_DIR, `canonical-schema.b64.${String(index + 1).padStart(2, "0")}`)
);
const EXPECTED_SCHEMA_SHA256 = "b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b";
const EXPECTED_SCHEMA_GZIP_SHA256 = "8ce8d37aa78c6a1fba38a2fa333ba7553e927366fb545d92a879585dbc351174";
const INIT_LOCK_NAME = "asami:schema-init";
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

function isTransientDatabaseError(err) {
  return TRANSIENT_DB_ERRORS.has(String(err?.code || "").toUpperCase());
}

function retryDelayMs(attempt) {
  const base = Math.max(25, Number(env.DB_RETRY_BASE_MS) || 250);
  const maximum = Math.max(base, Number(env.DB_RETRY_MAX_MS) || 5000);
  const exponential = Math.min(maximum, base * (2 ** Math.max(0, attempt)));
  return Math.min(maximum, Math.round(exponential + exponential * 0.2 * Math.random()));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_$-]+$/.test(value)) {
    throw new Error(`Invalid MySQL database name: ${value}`);
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

function loadSchemaSql() {
  const encoded = SCHEMA_PARTS.map((filePath) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Database schema snapshot part not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, "utf8").trim();
  }).join("");

  const compressed = Buffer.from(encoded, "base64");
  const gzipSha256 = crypto.createHash("sha256").update(compressed).digest("hex");
  if (gzipSha256 !== EXPECTED_SCHEMA_GZIP_SHA256) {
    throw new Error(`Database schema gzip integrity check failed: expected ${EXPECTED_SCHEMA_GZIP_SHA256}, got ${gzipSha256}`);
  }

  const dump = zlib.gunzipSync(compressed);
  const schemaSha256 = crypto.createHash("sha256").update(dump).digest("hex");
  if (schemaSha256 !== EXPECTED_SCHEMA_SHA256) {
    throw new Error(`Database schema integrity check failed: expected ${EXPECTED_SCHEMA_SHA256}, got ${schemaSha256}`);
  }

  const sql = dump.toString("utf8");
  const databaseName = quoteIdentifier(env.DB_NAME);
  const createPattern = /CREATE DATABASE(\s+IF NOT EXISTS\s+)`asami`/;
  if (!createPattern.test(sql) || !/^USE `asami`;/m.test(sql)) {
    throw new Error("Invalid Asami schema snapshot: expected CREATE DATABASE/USE for `asami`");
  }

  return sql
    .replace(createPattern, (_, spacing) => `CREATE DATABASE${spacing}${databaseName}`)
    .replace(/^USE `asami`;/m, `USE ${databaseName};`);
}

async function ensureDatabase() {
  const connection = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
    multipleStatements: true,
    timezone: "Z"
  });

  let lockAcquired = false;
  try {
    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [INIT_LOCK_NAME]);
    lockAcquired = lockRows[0]?.acquired === 1;
    if (!lockAcquired) throw new Error("Could not acquire database initialization lock within 30 seconds");

    const [rows] = await connection.query(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
      [env.DB_NAME]
    );
    if (rows.length > 0) return false;

    await connection.query(loadSchemaSql());
    logger.info({ database: env.DB_NAME }, "database created from canonical schema snapshot");
    return true;
  } finally {
    if (lockAcquired) {
      try { await connection.query("SELECT RELEASE_LOCK(?)", [INIT_LOCK_NAME]); } catch {}
    }
    await connection.end();
  }
}

async function ensureDatabaseWithRetry({ attempts = env.DB_RETRY_ATTEMPTS } = {}) {
  const totalAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError = null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      return await ensureDatabase();
    } catch (err) {
      lastError = err;
      if (!isTransientDatabaseError(err) || attempt >= totalAttempts - 1) throw err;
      const retryInMs = retryDelayMs(attempt);
      logger.warn({
        attempt: attempt + 1,
        maxAttempts: totalAttempts,
        retryInMs,
        code: err.code
      }, "database initialization connection failed; retrying");
      await sleep(retryInMs);
    }
  }
  throw lastError || new Error("Database initialization failed");
}

module.exports = { ensureDatabase, ensureDatabaseWithRetry, EXPECTED_SCHEMA_SHA256 };
