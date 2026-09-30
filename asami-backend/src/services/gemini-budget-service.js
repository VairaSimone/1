const { pool } = require("../db/pool");
const { env } = require("../config/env");

let initialized = false;
let providerBlockedUntil = 0;
let providerBlockReason = null;

async function ensureGeminiUsageTable() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_usage (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      kind VARCHAR(20) NOT NULL DEFAULT 'AUTONOMY',
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
      UNIQUE KEY uq_gemini_usage_kind_period (kind, period_type, period_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [[column]] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='gemini_usage' AND COLUMN_NAME='kind'
  `);
  if (!Number(column?.count)) {
    await pool.query("ALTER TABLE gemini_usage ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'AUTONOMY' AFTER id");
  }

  const [legacyIndexes] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='gemini_usage' AND INDEX_NAME='uq_gemini_usage_period'
  `);
  if (Number(legacyIndexes?.[0]?.count)) {
    await pool.query("ALTER TABLE gemini_usage DROP INDEX uq_gemini_usage_period");
  }

  const [kindIndexes] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='gemini_usage' AND INDEX_NAME='uq_gemini_usage_kind_period'
  `);
  if (!Number(kindIndexes?.[0]?.count)) {
    await pool.query("ALTER TABLE gemini_usage ADD UNIQUE KEY uq_gemini_usage_kind_period (kind, period_type, period_key)");
  }

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

function blockProvider(delayMs = 60_000, reason = "PROVIDER_RATE_LIMIT") {
  const safeDelay = Math.max(10_000, Number(delayMs) || 60_000);
  const nextBlockedUntil = Date.now() + safeDelay;
  if (nextBlockedUntil >= providerBlockedUntil) {
    providerBlockedUntil = nextBlockedUntil;
    providerBlockReason = reason;
  }
}

function providerBlockRemainingMs() {
  const remaining = Math.max(0, providerBlockedUntil - Date.now());
  if (!remaining) providerBlockReason = null;
  return remaining;
}

function providerBlockStatus() {
  const remainingMs = providerBlockRemainingMs();
  return { remainingMs, reason: remainingMs > 0 ? providerBlockReason : null };
}

async function getUsage() {
  await ensureGeminiUsageTable();
  const { day, month } = periodKeys();
  const [rows] = await pool.query(`
    SELECT kind, period_type, period_key, requests, input_tokens, output_tokens,
           estimated_usd, reserved_usd
    FROM gemini_usage
    WHERE (period_type='DAY' AND period_key=?) OR (period_type='MONTH' AND period_key=?)
  `, [day, month]);

  const emptyDay = emptyUsage("DAY", day);
  const emptyMonth = emptyUsage("MONTH", month);
  const detail = {
    autonomy: {
      day: rows.find(r => r.kind === "AUTONOMY" && r.period_type === "DAY") || emptyUsage("DAY", day, "AUTONOMY"),
      month: rows.find(r => r.kind === "AUTONOMY" && r.period_type === "MONTH") || emptyUsage("MONTH", month, "AUTONOMY")
    },
    dialogue: {
      day: rows.find(r => r.kind === "DIALOGUE" && r.period_type === "DAY") || emptyUsage("DAY", day, "DIALOGUE"),
      month: rows.find(r => r.kind === "DIALOGUE" && r.period_type === "MONTH") || emptyUsage("MONTH", month, "DIALOGUE")
    }
  };

  for (const row of rows) {
    const target = row.period_type === "DAY" ? emptyDay : emptyMonth;
    target.requests += Number(row.requests || 0);
    target.input_tokens += Number(row.input_tokens || 0);
    target.output_tokens += Number(row.output_tokens || 0);
    target.estimated_usd = Number(target.estimated_usd || 0) + Number(row.estimated_usd || 0);
    target.reserved_usd = Number(target.reserved_usd || 0) + Number(row.reserved_usd || 0);
  }

  return { day: emptyDay, month: emptyMonth, autonomy: detail.autonomy, dialogue: detail.dialogue };
}
function emptyUsage(period_type, period_key, kind = null) {
  return { kind, period_type, period_key, requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, reserved_usd: 0 };
}

async function reserve({ prompt, outputTokenCeiling, kind }) {
  await ensureGeminiUsageTable();
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  const now = new Date();
  const { day, month } = periodKeys(now);
  const inputTokens = estimateInputTokens(prompt);
  const estimatedUsd = estimateCostUsd(inputTokens, outputTokenCeiling);
  const dailyLimit = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_DAILY_BUDGET_USD : env.GEMINI_AUTONOMY_DAILY_BUDGET_USD);
  const monthlyLimit = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_MONTHLY_BUDGET_USD : env.GEMINI_AUTONOMY_MONTHLY_BUDGET_USD);
  const dailyRequests = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_DAILY_MAX_REQUESTS : env.GEMINI_AUTONOMY_DAILY_MAX_REQUESTS);
  const monthlyRequests = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_MONTHLY_MAX_REQUESTS : env.GEMINI_AUTONOMY_MONTHLY_MAX_REQUESTS);
  const pacedDailyLimit = Math.min(dailyLimit, dailyPacedLimitUsd(now) * (dailyLimit / Math.max(0.000001, Number(env.GEMINI_DAILY_BUDGET_USD))));
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    for (const [type, key] of [["DAY", day], ["MONTH", month]]) {
      await conn.query(
        `INSERT INTO gemini_usage(kind,period_type,period_key) VALUES(?,?,?) ON DUPLICATE KEY UPDATE period_key=VALUES(period_key)`,
        [budgetKind, type, key]
      );
    }

    const [[dayRow]] = await conn.query(
      `SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE kind=? AND period_type='DAY' AND period_key=? FOR UPDATE`,
      [budgetKind, day]
    );
    const [[monthRow]] = await conn.query(
      `SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE kind=? AND period_type='MONTH' AND period_key=? FOR UPDATE`,
      [budgetKind, month]
    );

    const dailyCommitted = Number(dayRow?.estimated_usd || 0) + Number(dayRow?.reserved_usd || 0);
    const monthlyCommitted = Number(monthRow?.estimated_usd || 0) + Number(monthRow?.reserved_usd || 0);
    const canSpend =
      dailyCommitted + estimatedUsd <= pacedDailyLimit + 1e-9 &&
      monthlyCommitted + estimatedUsd <= monthlyLimit + 1e-9 &&
      Number(dayRow?.requests || 0) < dailyRequests &&
      Number(monthRow?.requests || 0) < monthlyRequests;

    if (!canSpend) {
      await conn.rollback();
      const dailyBlocked = dailyCommitted + estimatedUsd > pacedDailyLimit + 1e-9 || Number(dayRow?.requests || 0) >= dailyRequests;
      return {
        allowed: false,
        reason: dailyBlocked ? "DAILY_BUDGET" : "MONTHLY_BUDGET",
        estimatedUsd,
        pacedDailyLimit
      };
    }

    await conn.query(
      `UPDATE gemini_usage SET reserved_usd=reserved_usd+?,requests=requests+1 WHERE kind=? AND period_type='DAY' AND period_key=?`,
      [estimatedUsd, budgetKind, day]
    );
    await conn.query(
      `UPDATE gemini_usage SET reserved_usd=reserved_usd+?,requests=requests+1 WHERE kind=? AND period_type='MONTH' AND period_key=?`,
      [estimatedUsd, budgetKind, month]
    );
    await conn.commit();
    return { allowed: true, inputTokens, estimatedUsd, day, month, kind };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}
async function finalize(reservation, usageMetadata) {
  if (!reservation?.allowed) return;
  const { day, month, estimatedUsd, kind } = reservation;
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  const inputTokens = Number(usageMetadata?.promptTokenCount || reservation.inputTokens || 0);
  const outputTokens = Number(usageMetadata?.candidatesTokenCount || 0) + Number(usageMetadata?.thoughtsTokenCount || 0);
  const actualUsd = estimateCostUsd(inputTokens, outputTokens);
  const deltaReserved = actualUsd - Number(estimatedUsd);
  await pool.query(`UPDATE gemini_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, estimated_usd=estimated_usd+?, reserved_usd=GREATEST(0,reserved_usd+?) WHERE kind=? AND period_type='DAY' AND period_key=?`, [inputTokens, outputTokens, actualUsd, deltaReserved, budgetKind, day]);
  await pool.query(`UPDATE gemini_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?, estimated_usd=estimated_usd+?, reserved_usd=GREATEST(0,reserved_usd+?) WHERE kind=? AND period_type='MONTH' AND period_key=?`, [inputTokens, outputTokens, actualUsd, deltaReserved, budgetKind, month]);
}

async function release(reservation) {
  if (!reservation?.allowed) return;
  const { day, month, estimatedUsd, kind } = reservation;
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE kind=? AND period_type='DAY' AND period_key=?`, [estimatedUsd, budgetKind, day]);
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE kind=? AND period_type='MONTH' AND period_key=?`, [estimatedUsd, budgetKind, month]);
}

async function restoreRejectedRequest(reservation) {
  if (!reservation?.allowed) return;
  const { day, month, kind } = reservation;
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  await pool.query(
    `UPDATE gemini_usage SET requests=IF(requests > 0, requests - 1, 0)
     WHERE kind=? AND period_type='DAY' AND period_key=?`,
    [budgetKind, day]
  );
  await pool.query(
    `UPDATE gemini_usage SET requests=IF(requests > 0, requests - 1, 0)
     WHERE kind=? AND period_type='MONTH' AND period_key=?`,
    [budgetKind, month]
  );
}
module.exports = { ensureGeminiUsageTable, reserve, finalize, release, restoreRejectedRequest, getUsage, blockProvider, providerBlockRemainingMs, providerBlockStatus, estimateInputTokens, estimateCostUsd, dailyPacedLimitUsd };
