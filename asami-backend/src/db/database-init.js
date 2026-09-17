const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { env } = require("../config/env");
const logger = require("../lib/logger");

const SCHEMA_PATH = path.resolve(__dirname, "../../database/schema.sql.gz");
const EXPECTED_SCHEMA_SHA256 = "b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b";
const INIT_LOCK_NAME = "asami:schema-init";

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_$-]+$/.test(value)) {
    throw new Error(`Invalid MySQL database name: ${value}`);
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

function loadSchemaSql() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`Database schema snapshot not found: ${SCHEMA_PATH}`);
  }

  const dump = zlib.gunzipSync(fs.readFileSync(SCHEMA_PATH));
  const actualSha256 = crypto.createHash("sha256").update(dump).digest("hex");
  if (actualSha256 !== EXPECTED_SCHEMA_SHA256) {
    throw new Error(`Database schema snapshot integrity check failed: expected ${EXPECTED_SCHEMA_SHA256}, got ${actualSha256}`);
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

module.exports = { ensureDatabase, EXPECTED_SCHEMA_SHA256 };
