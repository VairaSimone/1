const { pool } = require("../db/pool");
const { env } = require("../config/env");

let initialized = false;
let providerBlockedUntil = 0;

async function ensureGeminiUsageTable() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_usage (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      period_type VARCHAR(10) NOT NULL,
      period_key VARCHAR(20) NOT NULL,
      requests INT UNSIGNED NOT NULL DEFAULT 0,
      input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      estimated_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
      reserved_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
      created_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_gemini_usage_period (period_type, period_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  initialized = true;
}

function periodKeys(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  return { day, month };
}

function estimateInputTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function estimateCostUsd(inputTokens, outputTokens) {
  return (Number(inputTokens) / 1_000_000) * env.GEMINI_INPUT_PRICE_USD_PER_1M +
    (Number(outputTokens) / 1_000_000) * env.GEMINI_OUTPUT_PRICE_USD_PER_1M;
}

function dailyPacedLimitUsd(now = new Date()) {
  const dailyLimit = Number(env.GEMINI_DAILY_BUDGET_USD);
  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) return 0;
  const graceMinutes = Math.max(0, Number(env.GEMINI_DAILY_PACING_GRACE_MINUTES) || 0);
  const elapsedMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const fraction = Math.min(1, (elapsedMinutes + graceMinutes) / 1440);
  return dailyLimit * fraction;
}

function rowKey(type, key) {
  return `${type}:${key}`;
}

function blockProvider(delayMs = 60_000) {
  providerBlockedUntil = Math.max(providerBlockedUntil, Date.now() + Math.max(10_000, Number(delayMs) || 60_000));
}

function providerBlockRemainingMs() {
  return Math.max(0, providerBlockedUntil - Date.now());
}

async function getUsage() {
  await ensureGeminiUsageTable();
  const { day, month } = periodKeys();
  const [rows] = await pool.query(`
    SELECT period_type, period_key, requests, input_tokens, output_tokens,
           estimated_usd, reserved_usd
    FROM gemini_usage
    WHERE (period_type='DAY' AND period_key=?) OR (period_type='MONTH' AND period_key=?)
  `, [day, month]);
  const byKey = new Map(rows.map(r => [rowKey(r.period_type, r.period_key), r]));
  const d = byKey.get(rowKey("DAY", day));
  const m = byKey.get(rowKey("MONTH", month));
  return { day: d || emptyUsage("DAY", day), month: m || emptyUsage("MONTH", month) };
}

function emptyUsage(period_type, period_key) {
  return { period_type, period_key, requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, reserved_usd: 0 };
}

async function reserve({ prompt, outputTokenCeiling, kind }) {
  await ensureGeminiUsageTable();
  const blockedMs = providerBlockRemainingMs();
  if (blockedMs > 0) return { allowed: false, reason: "PROVIDER_RATE_LIMIT", retryAfterMs: blockedMs };
  const now = new Date();
  const { day, month } = periodKeys(now);
  const inputTokens = estimateInputTokens(prompt);
  const estimatedUsd = estimateCostUsd(inputTokens, outputTokenCeiling);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [type, key] of [["DAY", day], ["MONTH", month]]) {
      await conn.query(`INSERT INTO gemini_usage(period_type,period_key) VALUES(?,?) ON DUPLICATE KEY UPDATE period_key=VALUES(period_key)`, [type, key]);
    }
    const [[dayRow]] = await conn.query(`SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE period_type='DAY' AND period_key=? FOR UPDATE`, [day]);
    const [[monthRow]] = await conn.query(`SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE period_type='MONTH' AND period_key=? FOR UPDATE`, [month]);
    const dailyLimit = Number(env.GEMINI_DAILY_BUDGET_USD);
    const monthlyLimit = Number(env.GEMINI_MONTHLY_BUDGET_USD);
    const pacedDailyLimit = Math.min(dailyLimit, dailyPacedLimitUsd(now));
    const dailyRequests = Number(env.GEMINI_DAILY_MAX_REQUESTS);
    const monthlyRequests = Number(env.GEMINI_MONTHLY_MAX_REQUESTS);
    const dailyCommitted = Number(dayRow.estimated_usd) + Number(dayRow.reserved_usd);
    const monthlyCommitted = Number(monthRow.estimated_usd) + Number(monthRow.reserved_usd);
    const canSpend = dailyCommitted + estimatedUsd <= pacedDailyLimit + 1e-9 && monthlyCommitted + estimatedUsd <= monthlyLimit + 1e-9 && Number(dayRow.requests) < dailyRequests && Number(monthRow.requests) < monthlyRequests;
    if (!canSpend) {
      await conn.rollback();
      const dailyBlocked = dailyCommitted + estimatedUsd > pacedDailyLimit + 1e-9 || Number(dayRow.requests) >= dailyRequests;
      return { allowed: false, reason: dailyBlocked ? "DAILY_BUDGET" : "MONTHLY_BUDGET", estimatedUsd, pacedDailyLimit };
    }
    await conn.query(`UPDATE gemini_usage SET reserved_usd=reserved_usd+?,requests=requests+1 WHERE period_type='DAY' AND period_key=?`, [estimatedUsd, day]);
    await conn.query(`UPDATE gemini_usage SET reserved_usd=reserved_usd+? WHERE period_type='MONTH' AND period_key=?`, [estimatedUsd, month]);
    await conn.commit();
    return { allowed: true, inputTokens, estimatedUsd, day, month, kind };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally { conn.release(); }
}

async function finalize(reservation, usageMetadata) {
  if (!reservation?.allowed) return;
  const { day, month, estimatedUsd } = reservation;
  const inputTokens = Number(usageMetadata?.promptTokenCount || reservation.inputTokens || 0);
  const outputTokens = Number(usageMetadata?.candidatesTokenCount || 0) + Number(usageMetadata?.thoughtsTokenCount || 0);
  const actualUsd = estimateCostUsd(inputTokens, outputTokens);
  const deltaReserved = actualUsd - Number(estimatedUsd);
  await pool.query(`UPDATE gemini_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, estimated_usd=estimated_usd+?, reserved_usd=GREATEST(0,reserved_usd+?) WHERE period_type='DAY' AND period_key=?`, [inputTokens, outputTokens, actualUsd, deltaReserved, day]);
  await pool.query(`UPDATE gemini_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, estimated_usd=estimated_usd+?, reserved_usd=GREATEST(0,reserved_usd+?) WHERE period_type='MONTH' AND period_key=?`, [inputTokens, outputTokens, actualUsd, deltaReserved, month]);
}

async function release(reservation) {
  if (!reservation?.allowed) return;
  const { day, month, estimatedUsd } = reservation;
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE period_type='DAY' AND period_key=?`, [estimatedUsd, day]);
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE period_type='MONTH' AND period_key=?`, [estimatedUsd, month]);
}

async function restoreRejectedRequest(reservation) {
  if (!reservation?.allowed) return;
  const { day, month } = reservation;
  await pool.query(`UPDATE gemini_usage SET requests=IF(requests > 0, requests - 1, 0) WHERE period_type='DAY' AND period_key=?`, [day]);
  await pool.query(`UPDATE gemini_usage SET requests=IF(requests > 0, requests - 1, 0) WHERE period_type='MONTH' AND period_key=?`, [month]);
}

module.exports = { ensureGeminiUsageTable, reserve, finalize, release, restoreRejectedRequest, getUsage, blockProvider, providerBlockRemainingMs, estimateInputTokens, estimateCostUsd, dailyPacedLimitUsd };
