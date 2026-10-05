const { pool } = require("../db/pool");
const { env } = require("../config/env");

const BYTES_PER_MB = 1024 * 1024;

function megabytesToBytes(megabytes) {
  const value = Number(megabytes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * BYTES_PER_MB);
}

function getDatabaseSizeLimitBytes() {
  return megabytesToBytes(env.DB_MAX_SIZE_MB);
}

function isDatabaseSizeLimitReached(sizeBytes, limitBytes = getDatabaseSizeLimitBytes()) {
  const size = Number(sizeBytes);
  const limit = Number(limitBytes);
  return Number.isFinite(size) && Number.isFinite(limit) && limit > 0 && size >= limit;
}

async function getDatabaseSizeBytes(db = pool) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes
     FROM information_schema.tables
     WHERE table_schema = DATABASE()`
  );
  return Number(rows[0]?.bytes || 0);
}

async function checkDatabaseSizeLimit(db = pool) {
  const limitBytes = getDatabaseSizeLimitBytes();
  if (limitBytes <= 0) {
    return {
      enabled: false,
      sizeBytes: 0,
      limitBytes: 0,
      sizeMb: 0,
      limitMb: 0,
      reached: false
    };
  }

  const sizeBytes = await getDatabaseSizeBytes(db);
  return {
    enabled: true,
    sizeBytes,
    limitBytes,
    sizeMb: sizeBytes / BYTES_PER_MB,
    limitMb: limitBytes / BYTES_PER_MB,
    reached: isDatabaseSizeLimitReached(sizeBytes, limitBytes)
  };
}

module.exports = {
  BYTES_PER_MB,
  megabytesToBytes,
  getDatabaseSizeLimitBytes,
  isDatabaseSizeLimitReached,
  getDatabaseSizeBytes,
  checkDatabaseSizeLimit
};
