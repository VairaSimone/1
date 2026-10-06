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

async function getInnoDBAllocatedSizeBytes(db = pool) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(allocated_size), 0) AS bytes
     FROM information_schema.innodb_tablespaces
     WHERE name LIKE CONCAT(?, '/%')`,
    [env.DB_NAME]
  );
  return Number(rows[0]?.bytes || 0);
}

async function getBinaryLogSizeBytes(db = pool) {
  const [statusRows] = await db.query("SHOW VARIABLES LIKE 'log_bin'");
  const enabled = String(statusRows[0]?.Value || "").trim().toUpperCase() === "ON";
  if (!enabled) return 0;

  const [rows] = await db.query("SHOW BINARY LOGS");
  return rows.reduce((total, row) => total + Math.max(0, Number(row.File_size || 0)), 0);
}

async function getDatabaseSizeBreakdown(db = pool) {
  const [innodbAllocatedBytes, binaryLogBytes] = await Promise.all([
    getInnoDBAllocatedSizeBytes(db),
    getBinaryLogSizeBytes(db)
  ]);
  return {
    innodbAllocatedBytes,
    binaryLogBytes,
    sizeBytes: innodbAllocatedBytes + binaryLogBytes
  };
}

async function getDatabaseSizeBytes(db = pool) {
  const breakdown = await getDatabaseSizeBreakdown(db);
  return breakdown.sizeBytes;
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
      reached: false,
      storage: {
        innodbAllocatedBytes: 0,
        binaryLogBytes: 0
      }
    };
  }

  const breakdown = await getDatabaseSizeBreakdown(db);
  return {
    enabled: true,
    sizeBytes: breakdown.sizeBytes,
    limitBytes,
    sizeMb: breakdown.sizeBytes / BYTES_PER_MB,
    limitMb: limitBytes / BYTES_PER_MB,
    reached: isDatabaseSizeLimitReached(breakdown.sizeBytes, limitBytes),
    storage: breakdown
  };
}

module.exports = {
  BYTES_PER_MB,
  megabytesToBytes,
  getDatabaseSizeLimitBytes,
  isDatabaseSizeLimitReached,
  getInnoDBAllocatedSizeBytes,
  getBinaryLogSizeBytes,
  getDatabaseSizeBreakdown,
  getDatabaseSizeBytes,
  checkDatabaseSizeLimit
};
