const { pool } = require("../db/pool");
const logger = require("../lib/logger");

const TERMINAL_DECISION_STATUSES = new Set(["EXECUTED", "FAILED", "CANCELLED"]);
const lastRunAt = new Map();
const running = new Set();

function positiveInt(value, fallback, minimum) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(minimum, Math.floor(n)) : fallback;
}

const POLICY = Object.freeze({
  enabled: !["0", "false", "no", "off"].includes(String(process.env.RETENTION_ENABLED || "true").trim().toLowerCase()),
  intervalMs: positiveInt(process.env.RETENTION_CHECK_INTERVAL_MS, 15 * 60 * 1000, 60 * 1000),
  decisionContextDays: positiveInt(process.env.RETENTION_DECISION_CONTEXT_DAYS, 2, 1),
  decisionOptionsDays: positiveInt(process.env.RETENTION_DECISION_OPTIONS_DAYS, 3, 2),
  cognitiveArtifactDays: positiveInt(process.env.RETENTION_COGNITIVE_ARTIFACT_DAYS, 30, 14),
  batchSize: Math.min(2000, positiveInt(process.env.RETENTION_BATCH_SIZE, 500, 50)),
  maxDeletesPerTable: Math.min(10000, positiveInt(process.env.RETENTION_MAX_DELETES_PER_TABLE, 2000, 100)),
  dryRun: ["1", "true", "yes", "on"].includes(String(process.env.RETENTION_DRY_RUN || "false").trim().toLowerCase())
});

function isTerminalDecisionStatus(status) {
  return TERMINAL_DECISION_STATUSES.has(String(status || "").trim().toUpperCase());
}

function cutoffExpression(days) {
  return "DATE_SUB(?, INTERVAL " + Math.max(1, Math.floor(days)) + " DAY)";
}

async function acquireLock(simulationId) {
  const conn = await pool.getConnection();
  const lockName = ("asami_retention:" + simulationId).slice(0, 64);
  try {
    const [rows] = await conn.query("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    if (Number(rows[0]?.acquired) !== 1) {
      conn.release();
      return null;
    }
    return { conn, lockName };
  } catch (err) {
    conn.release();
    throw err;
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  try {
    await lock.conn.query("SELECT RELEASE_LOCK(?)", [lock.lockName]);
  } catch {}
  lock.conn.release();
}

async function compactOldDecisionContexts(conn, simulationId, simulationTime) {
  const cutoff = cutoffExpression(POLICY.decisionContextDays);
  const sql =
    "UPDATE decisions " +
    "SET context=JSON_OBJECT(" +
      "'schemaVersion',3," +
      "'archived',true," +
      "'status',status," +
      "'selectedOptionId',IF(selected_option_id IS NULL,NULL,BIN_TO_UUID(selected_option_id))" +
    ") " +
    "WHERE simulation_id=UUID_TO_BIN(?) " +
    "AND status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND simulation_time < " + cutoff + " " +
    "AND context IS NOT NULL " +
    "AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(context,'$.archived')),'false') <> 'true')";
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM decisions " +
      "WHERE simulation_id=UUID_TO_BIN(?) " +
      "AND status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND simulation_time < " + cutoff + " " +
      "AND context IS NOT NULL " +
      "AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(context,'$.archived')),'false') <> 'true')";
    const [rows] = await conn.query(countSql, [simulationId, simulationTime]);
    return { candidates: Number(rows[0]?.candidates || 0), updated: 0, dryRun: true };
  }
  const [result] = await conn.query(sql, [simulationId, simulationTime]);
  return { candidates: Number(result.affectedRows || 0), updated: Number(result.affectedRows || 0) };
}

async function deleteUnselectedDecisionOptions(conn, simulationId, simulationTime) {
  const cutoff = cutoffExpression(POLICY.decisionOptionsDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(dopt.id) AS id FROM decision_options dopt " +
    "JOIN decisions d ON d.id=dopt.decision_id " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.selected_option_id IS NOT NULL " +
    "AND dopt.id <> d.selected_option_id " +
    "AND d.simulation_time < " + cutoff + " " +
    "LIMIT " + limit;
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM decision_options dopt " +
      "JOIN decisions d ON d.id=dopt.decision_id " +
      "WHERE d.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.selected_option_id IS NOT NULL " +
      "AND dopt.id <> d.selected_option_id " +
      "AND d.simulation_time < " + cutoff;
    const [rows] = await conn.query(countSql, [simulationId, simulationTime]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes) {
    const [rows] = await conn.query(selectSql, [simulationId, simulationTime]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM decision_options WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  return { deleted };
}

async function deleteResolvedExpectations(conn, simulationId, simulationTime) {
  const cutoff = cutoffExpression(POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(ce.id) AS id FROM cognitive_expectations ce " +
    "JOIN decisions d ON d.id=ce.decision_id " +
    "WHERE ce.simulation_id=UUID_TO_BIN(?) " +
    "AND ce.status='RESOLVED' " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < " + cutoff + " " +
    "AND ce.resolved_simulation_at < " + cutoff + " " +
    "LIMIT " + limit;
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM cognitive_expectations ce " +
      "JOIN decisions d ON d.id=ce.decision_id " +
      "WHERE ce.simulation_id=UUID_TO_BIN(?) " +
      "AND ce.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < " + cutoff + " " +
      "AND ce.resolved_simulation_at < " + cutoff;
    const [rows] = await conn.query(countSql, [simulationId, simulationTime]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes) {
    const [rows] = await conn.query(selectSql, [simulationId, simulationTime]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM cognitive_expectations WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  return { deleted };
}

async function deleteResolvedCounterfactuals(conn, simulationId, simulationTime) {
  const cutoff = cutoffExpression(POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(cf.id) AS id FROM counterfactuals cf " +
    "JOIN decisions d ON d.id=cf.decision_id " +
    "WHERE cf.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < " + cutoff + " " +
    "LIMIT " + limit;
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactuals cf " +
      "JOIN decisions d ON d.id=cf.decision_id " +
      "WHERE cf.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < " + cutoff;
    const [rows] = await conn.query(countSql, [simulationId, simulationTime]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes) {
    const [rows] = await conn.query(selectSql, [simulationId, simulationTime]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM counterfactuals WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  return { deleted };
}

async function deleteResolvedCounterfactualWorlds(conn, simulationId, simulationTime) {
  const cutoff = cutoffExpression(POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(cw.id) AS id FROM counterfactual_worlds cw " +
    "JOIN decisions d ON d.id=cw.decision_id " +
    "WHERE cw.simulation_id=UUID_TO_BIN(?) " +
    "AND cw.status='RESOLVED' " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < " + cutoff + " " +
    "AND cw.resolved_simulation_at < " + cutoff + " " +
    "LIMIT " + limit;
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactual_worlds cw " +
      "JOIN decisions d ON d.id=cw.decision_id " +
      "WHERE cw.simulation_id=UUID_TO_BIN(?) " +
      "AND cw.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < " + cutoff + " " +
      "AND cw.resolved_simulation_at < " + cutoff;
    const [rows] = await conn.query(countSql, [simulationId, simulationTime]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes) {
    const [rows] = await conn.query(selectSql, [simulationId, simulationTime]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM counterfactual_worlds WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  return { deleted };
}

async function runSafeRetention(simulationId, simulationTime) {
  if (!POLICY.enabled || !simulationId || !simulationTime) return { skipped: true, reason: "disabled" };
  const lock = await acquireLock(simulationId);
  if (!lock) return { skipped: true, reason: "lock_busy" };
  try {
    const context = await compactOldDecisionContexts(lock.conn, simulationId, simulationTime);
    const options = await deleteUnselectedDecisionOptions(lock.conn, simulationId, simulationTime);
    const expectations = await deleteResolvedExpectations(lock.conn, simulationId, simulationTime);
    const counterfactuals = await deleteResolvedCounterfactuals(lock.conn, simulationId, simulationTime);
    const worlds = await deleteResolvedCounterfactualWorlds(lock.conn, simulationId, simulationTime);
    const summary = {
      simulationId,
      simulationTime,
      dryRun: POLICY.dryRun,
      decisionContextsCompacted: Number(context.updated || 0),
      decisionOptionsDeleted: Number(options.deleted || 0),
      expectationsDeleted: Number(expectations.deleted || 0),
      counterfactualsDeleted: Number(counterfactuals.deleted || 0),
      counterfactualWorldsDeleted: Number(worlds.deleted || 0),
      decisionContextCandidates: Number(context.candidates || 0),
      decisionOptionCandidates: Number(options.candidates || 0),
      expectationCandidates: Number(expectations.candidates || 0),
      counterfactualCandidates: Number(counterfactuals.candidates || 0),
      counterfactualWorldCandidates: Number(worlds.candidates || 0)
    };
    if (summary.decisionContextsCompacted || summary.decisionOptionsDeleted || summary.expectationsDeleted || summary.counterfactualsDeleted || summary.counterfactualWorldsDeleted || POLICY.dryRun) {
      logger.info(summary, "safe retention cycle completed");
    }
    return summary;
  } finally {
    await releaseLock(lock);
  }
}

async function maybeRunSafeRetention(simulationId, simulationTime) {
  if (!POLICY.enabled || !simulationId || !simulationTime) return { skipped: true, reason: "disabled" };
  const now = Date.now();
  const last = lastRunAt.get(simulationId);
  if (last !== undefined && now - last < POLICY.intervalMs) return { skipped: true, reason: "interval" };
  if (running.has(simulationId)) return { skipped: true, reason: "running" };
  running.add(simulationId);
  lastRunAt.set(simulationId, now);
  try {
    return await runSafeRetention(simulationId, simulationTime);
  } catch (err) {
    logger.error({ simulationId, simulationTime, err }, "safe retention cycle failed");
    return { skipped: true, reason: "error" };
  } finally {
    running.delete(simulationId);
  }
}

function getRetentionPolicy() {
  return { ...POLICY, terminalDecisionStatuses: [...TERMINAL_DECISION_STATUSES] };
}

module.exports = {
  getRetentionPolicy,
  isTerminalDecisionStatus,
  runSafeRetention,
  maybeRunSafeRetention
};
