const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const mysql = require("mysql2/promise");
const { env } = require("../config/env");
const logger = require("../lib/logger");

const SCHEMA_PARTS = [
  "schema.sql.gz.b64.001",
  "schema.sql.gz.b64.002",
  "schema.sql.gz.b64.003",
  "schema.sql.gz.b64.004",
  "schema.sql.gz.b64.005"
].map((name) => path.resolve(__dirname, "../../database", name));

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_$-]+$/.test(value)) {
    throw new Error(`Invalid MySQL database name: ${value}`);
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

function buildSchemaSql() {
  const encoded = SCHEMA_PARTS.map((filePath) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Database schema snapshot part not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, "utf8").trim();
  }).join("");

  const dump = zlib.gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  const databaseName = quoteIdentifier(env.DB_NAME);
  const createPattern = /CREATE DATABASE(\s+IF NOT EXISTS\s+)`asami`/;
  if (!createPattern.test(dump) || !/^USE `asami`;/m.test(dump)) {
    throw new Error("Invalid Asami schema snapshot: expected CREATE DATABASE/USE for `asami`");
  }

  return dump
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

  try {
    const [rows] = await connection.query(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
      [env.DB_NAME]
    );
    if (rows.length > 0) return false;

    await connection.query(buildSchemaSql());
    logger.info({ database: env.DB_NAME }, "database created from schema snapshot");
    return true;
  } finally {
    await connection.end();
  }
}

module.exports = { ensureDatabase };
