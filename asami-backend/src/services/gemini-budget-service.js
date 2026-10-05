const { pool } = require("../db/pool");
const { env } = require("../config/env");

let initialized = false;
let providerBlockedUntil = 0;
let providerBlockReason = null;
const budgetBlockedUntil = new Map();

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_simulation_usage (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      simulation_id VARCHAR(64) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      simulation_day VARCHAR(10) NOT NULL,
      requests INT UNSIGNED NOT NULL DEFAULT 0,
      input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
      estimated_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
      actual_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
      reserved_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
      created_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_gemini_simulation_usage (simulation_id,kind,simulation_day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_decision_telemetry (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      simulation_id VARCHAR(64) NOT NULL,
      entity_id VARCHAR(64) NULL,
      decision_id VARCHAR(64) NULL,
      kind VARCHAR(20) NOT NULL,
      outcome VARCHAR(32) NOT NULL,
      reason VARCHAR(120) NULL,
      model VARCHAR(100) NULL,
      simulation_day VARCHAR(10) NOT NULL,
      simulation_at DATETIME(3) NOT NULL,
      created_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_gemini_decision_telemetry_decision (decision_id),
      KEY idx_gemini_decision_telemetry_sim_day (simulation_id,simulation_day),
      KEY idx_gemini_decision_telemetry_sim_entity (simulation_id,entity_id),
      KEY idx_gemini_decision_telemetry_sim_time (simulation_id,simulation_at)
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

function wallClockDailyPacedLimitUsd(now = new Date()) {
  const dailyLimit = Number(env.GEMINI_DAILY_BUDGET_USD);
  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) return 0;
  const graceMinutes = Math.max(0, Number(env.GEMINI_DAILY_PACING_GRACE_MINUTES) || 0);
  const elapsedMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const fraction = Math.min(1, (elapsedMinutes + graceMinutes) / 1440);
  return dailyLimit * fraction;
}

const dailyPacedLimitUsd=wallClockDailyPacedLimitUsd;

function simulationDayKey(value) {
  const raw=String(value||"").trim();
  if(/^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(raw))return raw.slice(0,10);
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):null;
}

function rowKey(type, key) {
  return `${type}:${key}`;
}
function localBudgetBlockStatus(kind="AUTONOMY"){
  const budgetKind=String(kind||"").toUpperCase()==="DIALOGUE"?"DIALOGUE":"AUTONOMY";
  const remainingMs=Math.max(0,Number(budgetBlockedUntil.get(budgetKind)||0)-Date.now());
  return {blocked:remainingMs>0,remainingMs};
}
function isLocallyBlocked(kind="AUTONOMY"){
  return localBudgetBlockStatus(kind).blocked;
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

async function reserve({ prompt, outputTokenCeiling, kind, simulationId=null, entityId=null, simulationTime=null }) {
  await ensureGeminiUsageTable();
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  const cachedBlockMs = Math.max(0, Number(budgetBlockedUntil.get(budgetKind) || 0) - Date.now());
  if (cachedBlockMs > 0) {
    return { allowed: false, reason: "DAILY_BUDGET", retryAfterMs: cachedBlockMs };
  }
  const now = new Date();
  const { day, month } = periodKeys(now);
  const inputTokens = estimateInputTokens(prompt);
  const estimatedUsd = estimateCostUsd(inputTokens, outputTokenCeiling);
  const dailyLimit = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_DAILY_BUDGET_USD : env.GEMINI_AUTONOMY_DAILY_BUDGET_USD);
  const monthlyLimit = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_MONTHLY_BUDGET_USD : env.GEMINI_AUTONOMY_MONTHLY_BUDGET_USD);
  const dailyRequests = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_DAILY_MAX_REQUESTS : env.GEMINI_AUTONOMY_DAILY_MAX_REQUESTS);
  const monthlyRequests = Number(budgetKind === "DIALOGUE" ? env.GEMINI_DIALOGUE_MONTHLY_MAX_REQUESTS : env.GEMINI_AUTONOMY_MONTHLY_MAX_REQUESTS);
  const autonomyPacingEnabled = Boolean(env.GEMINI_AUTONOMY_DAILY_PACING_ENABLED);
  const pacedDailyLimit = budgetKind === "DIALOGUE"
    ? dailyLimit
    : autonomyPacingEnabled
      ? Math.min(
          dailyLimit,
          wallClockDailyPacedLimitUsd(now) *
            (dailyLimit / Math.max(0.000001, Number(env.GEMINI_DAILY_BUDGET_USD)))
        )
      : dailyLimit;
  const simulationDay=simulationDayKey(simulationTime);
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
      let retryAfterMs = 0;
      if (dailyBlocked) {
        if(autonomyPacingEnabled || budgetKind === "DIALOGUE"){
          const dailyLimitForPacing = Math.max(0.000001, dailyLimit);
          const requiredFraction = Math.min(1, (dailyCommitted + estimatedUsd) / dailyLimitForPacing);
          const graceMinutes = Math.max(0, Number(env.GEMINI_DAILY_PACING_GRACE_MINUTES) || 0);
          const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
          const requiredMinutes = Math.max(0, requiredFraction * 1440 - graceMinutes);
          retryAfterMs = Math.max(1000, Math.ceil(Math.max(0, requiredMinutes - nowMinutes) * 60000));
        }else{
          retryAfterMs = Math.max(1000, 24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000)));
        }
        budgetBlockedUntil.set(budgetKind, Date.now() + retryAfterMs);
      } else {
        retryAfterMs = Math.max(1000, 24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000)));
        budgetBlockedUntil.set(budgetKind, Date.now() + retryAfterMs);
      }
      return {
        allowed: false,
        reason: dailyBlocked ? "DAILY_BUDGET" : "MONTHLY_BUDGET",
        retryAfterMs,
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
    if(simulationId&&simulationDay){
      await conn.query(
        `INSERT INTO gemini_simulation_usage(simulation_id,kind,simulation_day,requests,reserved_usd)
         VALUES(?,?,?,1,?)
         ON DUPLICATE KEY UPDATE requests=requests+1,reserved_usd=reserved_usd+VALUES(reserved_usd)`,
        [String(simulationId),budgetKind,simulationDay,estimatedUsd]
      );
    }
    await conn.commit();
    budgetBlockedUntil.delete(budgetKind);
    return { allowed: true, inputTokens, estimatedUsd, day, month, kind, simulationId, entityId, simulationDay };
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
  if(reservation.simulationId&&reservation.simulationDay){
    await pool.query(
      `UPDATE gemini_simulation_usage
       SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,actual_usd=actual_usd+?,reserved_usd=GREATEST(0,reserved_usd+?)
       WHERE simulation_id=? AND kind=? AND simulation_day=?`,
      [inputTokens,outputTokens,actualUsd,deltaReserved,String(reservation.simulationId),budgetKind,reservation.simulationDay]
    );
  }
}

async function release(reservation) {
  if (!reservation?.allowed) return;
  const { day, month, estimatedUsd, kind } = reservation;
  const budgetKind = kind === "dialogue" ? "DIALOGUE" : "AUTONOMY";
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE kind=? AND period_type='DAY' AND period_key=?`, [estimatedUsd, budgetKind, day]);
  await pool.query(`UPDATE gemini_usage SET reserved_usd=GREATEST(0,reserved_usd-?) WHERE kind=? AND period_type='MONTH' AND period_key=?`, [estimatedUsd, budgetKind, month]);
  if(reservation.simulationId&&reservation.simulationDay){
    await pool.query(
      `UPDATE gemini_simulation_usage SET reserved_usd=GREATEST(0,reserved_usd-?)
       WHERE simulation_id=? AND kind=? AND simulation_day=?`,
      [estimatedUsd,String(reservation.simulationId),budgetKind,reservation.simulationDay]
    );
  }
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
  if(reservation.simulationId&&reservation.simulationDay){
    await pool.query(
      `UPDATE gemini_simulation_usage SET requests=IF(requests>0,requests-1,0)
       WHERE simulation_id=? AND kind=? AND simulation_day=?`,
      [String(reservation.simulationId),budgetKind,reservation.simulationDay]
    );
  }
}

async function recordDecisionOutcome({simulationId,entityId=null,decisionId=null,kind="autonomy",outcome,reason=null,model=null,simulationTime}={}){
  if(!simulationId||!outcome)return false;
  await ensureGeminiUsageTable();
  const simulationDay=simulationDayKey(simulationTime);
  if(!simulationDay)return false;
  await pool.query(
    `INSERT INTO gemini_decision_telemetry
       (simulation_id,entity_id,decision_id,kind,outcome,reason,model,simulation_day,simulation_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       entity_id=VALUES(entity_id),kind=VALUES(kind),outcome=VALUES(outcome),
       reason=VALUES(reason),model=VALUES(model),simulation_day=VALUES(simulation_day),
       simulation_at=VALUES(simulation_at)`,
    [String(simulationId),entityId?String(entityId):null,decisionId?String(decisionId):null,
     String(kind||"autonomy").toUpperCase(),String(outcome),reason?String(reason).slice(0,120):null,
     model?String(model).slice(0,100):null,simulationDay,simulationTime]
  );
  return true;
}

async function getSimulationDecisionCoverage(simulationId){
  if(!simulationId)return null;
  await ensureGeminiUsageTable();
  const [rows]=await pool.query(
    `SELECT entity_id AS entityId,kind,outcome,reason,model,simulation_day AS simulationDay,simulation_at AS simulationAt
     FROM gemini_decision_telemetry WHERE simulation_id=? ORDER BY simulation_at ASC LIMIT 100000`,
    [String(simulationId)]
  );
  const totals={totalDecisions:rows.length,aiDecisions:0,deterministicDecisions:0,aiFallbacks:0,aiUnavailable:0};
  const byDay=new Map(),byActor=new Map();
  const add=(bucket,row)=>{
    bucket.total=Number(bucket.total||0)+1;
    if(row.outcome==="AI_DECISION")bucket.aiDecisions=Number(bucket.aiDecisions||0)+1;
    else if(row.outcome==="DETERMINISTIC_DECISION")bucket.deterministicDecisions=Number(bucket.deterministicDecisions||0)+1;
    else if(row.outcome==="AI_FALLBACK")bucket.aiFallbacks=Number(bucket.aiFallbacks||0)+1;
    else if(row.outcome==="AI_UNAVAILABLE")bucket.aiUnavailable=Number(bucket.aiUnavailable||0)+1;
  };
  for(const row of rows){
    if(row.outcome==="AI_DECISION")totals.aiDecisions++;
    else if(row.outcome==="DETERMINISTIC_DECISION")totals.deterministicDecisions++;
    else if(row.outcome==="AI_FALLBACK")totals.aiFallbacks++;
    else if(row.outcome==="AI_UNAVAILABLE")totals.aiUnavailable++;
    const day=byDay.get(row.simulationDay)||{simulationDay:row.simulationDay};
    add(day,row);byDay.set(row.simulationDay,day);
    const actorKey=String(row.entityId||"UNKNOWN");
    const actor=byActor.get(actorKey)||{entityId:row.entityId};
    add(actor,row);byActor.set(actorKey,actor);
  }
  let degradedModeHours=0;
  for(let i=rows.length-1;i>0&&rows[i].outcome!=="AI_DECISION";i--){
    const current=new Date(rows[i].simulationAt).getTime();
    const previous=new Date(rows[i-1].simulationAt).getTime();
    if(Number.isFinite(current)&&Number.isFinite(previous))degradedModeHours+=Math.max(0,(current-previous)/3600000);
  }
  const [usageRows]=await pool.query(
    `SELECT kind,SUM(requests) AS requests,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
            SUM(estimated_usd) AS estimatedUsd,SUM(actual_usd) AS actualUsd
     FROM gemini_simulation_usage WHERE simulation_id=? GROUP BY kind`,
    [String(simulationId)]
  );
  return{
    simulationId:String(simulationId),
    coverage:{
      ...totals,
      aiCoveragePercent:totals.totalDecisions?Number((totals.aiDecisions/totals.totalDecisions*100).toFixed(2)):0,
      degradedModeHours:Number(degradedModeHours.toFixed(2))
    },
    bySimulationDay:[...byDay.values()],
    byActor:[...byActor.values()],
    llmBudget:{
      requests:usageRows.reduce((sum,row)=>sum+Number(row.requests||0),0),
      inputTokens:usageRows.reduce((sum,row)=>sum+Number(row.inputTokens||0),0),
      outputTokens:usageRows.reduce((sum,row)=>sum+Number(row.outputTokens||0),0),
      estimatedUsd:Number(usageRows.reduce((sum,row)=>sum+Number(row.estimatedUsd||0),0).toFixed(6)),
      actualUsd:Number(usageRows.reduce((sum,row)=>sum+Number(row.actualUsd||0),0).toFixed(6)),
      byKind:usageRows.map(row=>({
        kind:row.kind,
        requests:Number(row.requests||0),
        inputTokens:Number(row.inputTokens||0),
        outputTokens:Number(row.outputTokens||0),
        estimatedUsd:Number(row.estimatedUsd||0),
        actualUsd:Number(row.actualUsd||0)
      }))
    }
  };
}

module.exports = { ensureGeminiUsageTable, reserve, finalize, release, restoreRejectedRequest, recordDecisionOutcome, getSimulationDecisionCoverage, getUsage, blockProvider, providerBlockRemainingMs, providerBlockStatus, localBudgetBlockStatus, isLocallyBlocked, estimateInputTokens, estimateCostUsd, dailyPacedLimitUsd, wallClockDailyPacedLimitUsd, simulationDayKey };
