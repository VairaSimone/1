const { pool, normalizeSimulationTimestamp } = require("../db/pool");
const observability = require("./simulation-observability");
const { recordMemoryStatusDistribution } = require("./memory-service");
const logger = require("../lib/logger");
const { withEventWriteLock } = require("./event-service");
const { compactActionResult, compactActionTarget, compactActionParameters, compactPlanStepResult, compactDecisionActualOutcome } = require("./storage-compaction");

function uuidBinaryParam(value) {
  if (Buffer.isBuffer(value)) return value;
  const normalized = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error("Invalid simulation UUID for retention telemetry");
  }
  return Buffer.from(normalized.replaceAll("-", ""), "hex");
}

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return fallback;}}


const TERMINAL_DECISION_STATUSES = new Set(["EXECUTED", "FAILED", "CANCELLED"]);
const TERMINAL_ACTION_STATUSES = new Set(["COMPLETED", "CANCELLED", "INTERRUPTED", "FAILED"]);
const lastRunAt = new Map();
const lastRunSimulationAt = new Map();
const running = new Set();
const retentionDeadlineAt = new Map();
const adaptiveStateBySimulation = new Map();
let retentionTelemetryReady = null;

function positiveInt(value, fallback, minimum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(minimum, Math.floor(n)) : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(maximum, Math.max(minimum, n)) : fallback;
}

function normalizeArchiveJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (value && typeof value === "object") {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return {
        schemaVersion: 1,
        _invalidJson: true,
        _rawContext: String(value)
      };
    }
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {
        schemaVersion: 1,
        _invalidJson: true,
        _rawContext: value
      };
    }
  }
  return {
    schemaVersion: 1,
    _invalidJson: true,
    _rawContext: String(value ?? "")
  };
}

function serializeArchiveJson(value) {
  const normalized = normalizeArchiveJson(value);
  try {
    return JSON.stringify(normalized);
  } catch {
    return JSON.stringify({
      schemaVersion: 1,
      _invalidJson: true,
      _rawContext: String(value ?? "")
    });
  }
}

function simulationTimestampMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : NaN;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  const normalized = normalizeSimulationTimestamp(value);
  if (typeof normalized !== "string") return NaN;
  const date = new Date(normalized.replace(" ", "T") + "Z");
  return Number.isFinite(date.getTime()) ? date.getTime() : NaN;
}

function getAdaptiveRetentionProfile(overloadStreak = 0) {
  const streak = Math.max(0, Math.floor(Number(overloadStreak) || 0));
  const baseBudget = POLICY.timeBudgetMs;
  const baseInterval = POLICY.simulationIntervalHours;
  if (streak >= 9) {
    return {
      level: 3,
      timeBudgetMs: Math.min(30000, Math.max(baseBudget, 30000)),
      simulationIntervalHours: Math.max(0.25, baseInterval / 4)
    };
  }
  if (streak >= 6) {
    return {
      level: 2,
      timeBudgetMs: Math.min(30000, Math.max(baseBudget, 22500)),
      simulationIntervalHours: Math.max(0.25, baseInterval / 3)
    };
  }
  if (streak >= 3) {
    return {
      level: 1,
      timeBudgetMs: Math.min(30000, Math.max(baseBudget, 15000)),
      simulationIntervalHours: Math.max(0.5, baseInterval / 2)
    };
  }
  return {
    level: 0,
    timeBudgetMs: baseBudget,
    simulationIntervalHours: baseInterval
  };
}

async function ensureRetentionTelemetryTable() {
  if (retentionTelemetryReady) return retentionTelemetryReady;
  retentionTelemetryReady = pool.query(
    "CREATE TABLE IF NOT EXISTS retention_cycle_metrics (" +
    "id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT," +
    "simulation_id BINARY(16) NOT NULL," +
    "simulation_at DATETIME(3) NOT NULL," +
    "observed_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
    "backlog_before BIGINT UNSIGNED NOT NULL DEFAULT 0," +
    "backlog_after BIGINT UNSIGNED NOT NULL DEFAULT 0," +
    "produced_rows BIGINT UNSIGNED NOT NULL DEFAULT 0," +
    "deleted_rows BIGINT UNSIGNED NOT NULL DEFAULT 0," +
    "produced_rows_per_sim_day DECIMAL(18,3) NOT NULL DEFAULT 0," +
    "deleted_rows_per_sim_day DECIMAL(18,3) NOT NULL DEFAULT 0," +
    "retention_debt_age_hours DECIMAL(18,3) NOT NULL DEFAULT 0," +
    "overload_streak INT UNSIGNED NOT NULL DEFAULT 0," +
    "adaptive_level TINYINT UNSIGNED NOT NULL DEFAULT 0," +
    "adaptive_time_budget_ms INT UNSIGNED NOT NULL DEFAULT 0," +
    "adaptive_simulation_interval_hours DECIMAL(10,3) NOT NULL DEFAULT 1," +
    "PRIMARY KEY (id)," +
    "UNIQUE KEY uq_retention_cycle (simulation_id,simulation_at)," +
    "KEY idx_retention_cycle_sim_real (simulation_id,observed_real_at)" +
    ") ENGINE=InnoDB"
  ).catch(error => {
    retentionTelemetryReady = null;
    throw error;
  });
  return retentionTelemetryReady;
}

async function loadRetentionTelemetryState(simulationId) {
  try {
    await ensureRetentionTelemetryTable();
    const [rows] = await pool.query(
      "SELECT id,simulation_at AS simulationAt,backlog_after AS backlogAfter,overload_streak AS overloadStreak " +
      "FROM retention_cycle_metrics WHERE simulation_id=UUID_TO_BIN(?) ORDER BY id DESC LIMIT 1",
      [simulationId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      simulationAt: row.simulationAt,
      simulationMs: simulationTimestampMs(row.simulationAt),
      backlogAfter: Number(row.backlogAfter || 0),
      overloadStreak: Number(row.overloadStreak || 0)
    };
  } catch (error) {
    logger.warnThrottled(
      "retention:telemetry:read",
      300000,
      { simulationId, error: String(error?.message || error) },
      "retention telemetry state unavailable; using base worker profile"
    );
    return null;
  }
}

function retentionBacklogTotalFromSummary(summary={}) {
  return [
    "needHistoryBacklog","emotionHistoryBacklog","simulationTickBacklog","eventBacklog",
    "actionBacklog","actionDecisionSummaryBacklog","planStepResultBacklog","memoryArchiveBacklog",
    "memoryDedupeBacklog","memoryDeleteBacklog","relationshipHistoryBacklog","expectationBacklog",
    "counterfactualBacklog","counterfactualWorldBacklog","decisionContextArchiveBacklog",
    "intentionsDeleted","decisionOptionCandidates","traitHistoryCandidates",
    "geminiDecisionTelemetryCandidates","decisions"
  ].reduce((sum,key)=>sum+Math.max(0,Number(summary[key]||0)),0);
}

async function getOldestRetentionDebtAt(conn, simulationId, simulationTime) {
  const simulationIdBinary = uuidBinaryParam(simulationId);
  const needCutoff=cutoffDateTime(simulationTime,POLICY.needHistoryDays);
  const emotionCutoff=cutoffDateTime(simulationTime,POLICY.emotionHistoryDays);
  const relationshipCutoff=cutoffDateTime(simulationTime,POLICY.relationshipHistoryDays);
  const actionCutoff=cutoffDateTime(simulationTime,POLICY.actionDays);
  const eventCutoff=cutoffDateTime(simulationTime,POLICY.eventDays);
  const importantEventCutoff=cutoffDateTime(simulationTime,POLICY.importantEventDays);
  const tickCutoff=cutoffDateTime(simulationTime,POLICY.simulationTickDays);
  const contextCutoff=cutoffDateTime(simulationTime,POLICY.decisionContextDays);
  const contextArchiveCutoff=cutoffDateTime(simulationTime,POLICY.decisionContextArchiveDays);
  const intentionCutoff=cutoffDateTime(simulationTime,POLICY.intentionDays);
  const optionCutoff=cutoffDateTime(simulationTime,POLICY.decisionOptionDays);
  const traitCutoff=cutoffDateTime(simulationTime,POLICY.traitHistoryDays);
  const geminiCutoff=cutoffDateTime(simulationTime,POLICY.geminiDecisionTelemetryDays);
  const decisionCutoff=cutoffDateTime(simulationTime,POLICY.decisionDays);
  const cognitiveCutoff=cutoffDateTime(simulationTime,POLICY.cognitiveArtifactDays);
  const memoryArchiveCutoff=cutoffDateTime(simulationTime,POLICY.memoryArchiveDays);
  const memoryDeleteCutoff=cutoffDateTime(simulationTime,POLICY.memoryDeleteDays);
  const importantThreshold=POLICY.eventImportanceKeepThreshold;

  const [rows]=await conn.query(
    "SELECT MIN(candidate_at) AS oldest_at FROM ("+
      "SELECT h.simulation_time AS candidate_at FROM entity_need_history h JOIN entities e ON e.id=h.entity_id WHERE e.simulation_id=? AND h.simulation_time < ? "+
      "UNION ALL SELECT h.simulation_time FROM entity_emotion_history h JOIN entities e ON e.id=h.entity_id WHERE e.simulation_id=? AND h.simulation_time < ? "+
      "UNION ALL SELECT rh.simulation_time FROM relationship_history rh JOIN relationships r ON r.id=rh.relationship_id WHERE rh.simulation_id=? AND rh.simulation_time < ? AND r.status IN ('ACTIVE','ENDED') "+
      "UNION ALL SELECT e.simulation_at FROM events e WHERE e.simulation_id=? AND ((e.importance < ? AND e.simulation_at < ?) OR e.simulation_at < ?) "+
      "UNION ALL SELECT a.completed_simulation_at FROM actions a WHERE a.simulation_id=? AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED') AND a.completed_simulation_at IS NOT NULL AND a.completed_simulation_at < ? AND (a.decision_id IS NULL OR EXISTS (SELECT 1 FROM decisions d WHERE d.id=a.decision_id AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_action_id=a.id) "+
      "UNION ALL SELECT a.completed_simulation_at FROM actions a JOIN decisions d ON d.id=a.decision_id WHERE a.simulation_id=? AND a.decision_id IS NOT NULL AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED') AND a.completed_simulation_at IS NOT NULL AND a.completed_simulation_at < ? AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NULL "+
      "UNION ALL SELECT t.simulation_time FROM simulation_ticks t WHERE t.simulation_id=? AND t.status IN ('COMPLETED','FAILED','SKIPPED') AND t.simulation_time < ? "+
      "UNION ALL SELECT dca.simulation_time FROM decision_context_archive dca WHERE dca.simulation_id=? AND dca.simulation_time < ? "+
      "UNION ALL SELECT d.simulation_time FROM decisions d WHERE d.simulation_id=? AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? AND d.context IS NOT NULL AND COALESCE(IF(JSON_VALID(d.context),JSON_UNQUOTE(JSON_EXTRACT(d.context,'$.operational')),'false'),'false') <> 'true' "+
      "UNION ALL SELECT p.created_simulation_at FROM plan_steps ps JOIN plans p ON p.id=ps.plan_id WHERE p.simulation_id=? AND p.created_simulation_at < ? AND ps.status IN ('COMPLETED','FAILED','CANCELLED') AND ps.result IS NOT NULL "+
      "UNION ALL SELECT i.created_simulation_at FROM intentions i WHERE i.simulation_id=? AND i.status IN ('COMPLETED','CANCELLED') AND i.created_simulation_at < ? AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.source_intention_id=i.id) "+
      "UNION ALL SELECT d.simulation_time FROM decision_options dopt JOIN decisions d ON d.id=dopt.decision_id WHERE d.simulation_id=? AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? "+
      "UNION ALL SELECT ce.created_simulation_at FROM cognitive_expectations ce JOIN decisions d ON d.id=ce.decision_id WHERE ce.simulation_id=? AND ce.status='RESOLVED' AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? AND ce.resolved_simulation_at < ? "+
      "UNION ALL SELECT cf.created_simulation_at FROM counterfactuals cf JOIN decisions d ON d.id=cf.decision_id WHERE cf.simulation_id=? AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? "+
      "UNION ALL SELECT cw.created_simulation_at FROM counterfactual_worlds cw JOIN decisions d ON d.id=cw.decision_id WHERE cw.simulation_id=? AND cw.status='RESOLVED' AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? AND cw.resolved_simulation_at < ? "+
      "UNION ALL SELECT th.changed_simulation_at FROM entity_trait_history th JOIN entities e ON e.id=th.entity_id WHERE e.simulation_id=? AND th.changed_simulation_at < ? "+
      "UNION ALL SELECT gdt.simulation_at FROM gemini_decision_telemetry gdt WHERE gdt.simulation_id=? AND gdt.simulation_at < ? "+
      "UNION ALL SELECT m.created_simulation_at FROM memories m WHERE m.simulation_id=? AND m.memory_type='EPISODIC' AND m.status IN ('ACTIVE','FADING') AND m.created_simulation_at < ? AND m.importance < ? AND (m.last_recalled_simulation_at IS NULL OR m.last_recalled_simulation_at < ?) AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'') <> 'resource_failure' "+
      "UNION ALL SELECT m.created_simulation_at FROM memories m WHERE m.simulation_id=? AND m.status='ACTIVE' AND m.memory_dedupe_key IS NOT NULL AND m.created_simulation_at < ? AND m.importance<=0.55 AND m.emotional_intensity<=0.30 "+
      "UNION ALL SELECT COALESCE(m.forgotten_simulation_at,m.created_simulation_at) FROM memories m WHERE m.simulation_id=? AND m.status IN ('ARCHIVED','FORGOTTEN') AND COALESCE(m.forgotten_simulation_at,m.created_simulation_at) < ? AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_memory_id=m.id) "+
      "UNION ALL SELECT d.simulation_time FROM decisions d WHERE d.simulation_id=? AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time < ? AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM intentions i WHERE i.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM decision_options dopt WHERE dopt.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM counterfactuals cf WHERE cf.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id) AND NOT EXISTS (SELECT 1 FROM decision_context_archive dca WHERE dca.decision_id=d.id)"+
    ") debt",
    [
      simulationIdBinary,needCutoff,
      simulationIdBinary,emotionCutoff,
      simulationIdBinary,relationshipCutoff,
      simulationIdBinary,importantThreshold,eventCutoff,importantEventCutoff,
      simulationIdBinary,actionCutoff,
      simulationIdBinary,actionCutoff,
      simulationIdBinary,tickCutoff,
      simulationIdBinary,contextArchiveCutoff,
      simulationIdBinary,contextCutoff,
      simulationIdBinary,actionCutoff,
      simulationIdBinary,intentionCutoff,
      simulationIdBinary,optionCutoff,
      simulationIdBinary,cognitiveCutoff,cognitiveCutoff,
      simulationIdBinary,cognitiveCutoff,
      simulationIdBinary,cognitiveCutoff,cognitiveCutoff,
      simulationIdBinary,traitCutoff,
      String(simulationId),geminiCutoff,
      simulationIdBinary,memoryArchiveCutoff,POLICY.memoryArchiveImportanceMax,memoryArchiveCutoff,
      simulationIdBinary,memoryDeleteCutoff,
      simulationIdBinary,memoryDeleteCutoff,
      simulationIdBinary,decisionCutoff
    ]
  );
  return rows[0]?.oldest_at||null;
}

async function persistRetentionTelemetry(conn, simulationId, simulationTime, summary, resolvedRows, previousState, adaptiveProfile) {
  try {
    await ensureRetentionTelemetryTable();
    const currentMs = simulationTimestampMs(simulationTime);
    const previousMs = Number(previousState?.simulationMs);
    const deltaDays = Number.isFinite(currentMs) && Number.isFinite(previousMs) && currentMs > previousMs
      ? (currentMs - previousMs) / 86400000
      : 0;
    const backlogBefore = Math.max(0, Number(summary.retentionBacklogTotal || 0) + Math.max(0, Number(resolvedRows || 0)));
    const previousBacklog = Math.max(0, Number(previousState?.backlogAfter || 0));
    const producedRows = previousState
      ? Math.max(0, backlogBefore - previousBacklog)
      : 0;
    const deletedRows = Math.max(0, Number(resolvedRows || 0));
    const producedPerSimDay = deltaDays > 0 ? producedRows / deltaDays : 0;
    const deletedPerSimDay = deltaDays > 0 ? deletedRows / deltaDays : 0;
    const overloadStreak = previousState && producedRows > deletedRows
      ? Number(previousState.overloadStreak || 0) + 1
      : 0;
    const oldestAt = Number(summary.retentionBacklogTotal || 0) > 0
      ? await getOldestRetentionDebtAt(
          conn,
          simulationId,
          simulationTime
        )
      : null;
    const oldestMs = oldestAt ? simulationTimestampMs(oldestAt) : NaN;
    const debtAgeHours = Number.isFinite(currentMs) && Number.isFinite(oldestMs) && currentMs >= oldestMs
      ? (currentMs - oldestMs) / 3600000
      : 0;
    await pool.query(
      "INSERT INTO retention_cycle_metrics " +
      "(simulation_id,simulation_at,backlog_before,backlog_after,produced_rows,deleted_rows,produced_rows_per_sim_day,deleted_rows_per_sim_day,retention_debt_age_hours,overload_streak,adaptive_level,adaptive_time_budget_ms,adaptive_simulation_interval_hours) " +
      "VALUES(UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON DUPLICATE KEY UPDATE " +
      "backlog_before=VALUES(backlog_before),backlog_after=VALUES(backlog_after),produced_rows=VALUES(produced_rows),deleted_rows=VALUES(deleted_rows)," +
      "produced_rows_per_sim_day=VALUES(produced_rows_per_sim_day),deleted_rows_per_sim_day=VALUES(deleted_rows_per_sim_day)," +
      "retention_debt_age_hours=VALUES(retention_debt_age_hours),overload_streak=VALUES(overload_streak),adaptive_level=VALUES(adaptive_level)," +
      "adaptive_time_budget_ms=VALUES(adaptive_time_budget_ms),adaptive_simulation_interval_hours=VALUES(adaptive_simulation_interval_hours),observed_real_at=CURRENT_TIMESTAMP(3)",
      [
        simulationId,
        simulationTime,
        backlogBefore,
        Number(summary.retentionBacklogTotal || 0),
        producedRows,
        deletedRows,
        producedPerSimDay,
        deletedPerSimDay,
        debtAgeHours,
        overloadStreak,
        adaptiveProfile.level,
        adaptiveProfile.timeBudgetMs,
        adaptiveProfile.simulationIntervalHours
      ]
    );
    adaptiveStateBySimulation.set(simulationId, { overloadStreak, simulationMs: currentMs, backlogAfter: Number(summary.retentionBacklogTotal || 0) });
    return {
      backlogBefore,
      producedRows,
      deletedRows,
      producedRowsPerSimDay: producedPerSimDay,
      deletedRowsPerSimDay: deletedPerSimDay,
      retentionDebtAgeHours: debtAgeHours,
      overloadStreak,
      adaptiveLevel: adaptiveProfile.level,
      adaptiveTimeBudgetMs: adaptiveProfile.timeBudgetMs,
      adaptiveSimulationIntervalHours: adaptiveProfile.simulationIntervalHours,
      retentionDebt: Number(summary.retentionBacklogTotal || 0),
      oldestRetentionDebtSimulationAt: oldestAt
    };
  } catch (error) {
    logger.warnThrottled(
      "retention:telemetry:write",
      300000,
      { simulationId, error: String(error?.message || error) },
      "retention telemetry write failed; cleanup continues"
    );
    return {
      backlogBefore: Math.max(0, Number(summary.retentionBacklogTotal || 0) + Math.max(0, Number(resolvedRows || 0))),
      producedRows: 0,
      deletedRows: Math.max(0, Number(resolvedRows || 0)),
      producedRowsPerSimDay: 0,
      deletedRowsPerSimDay: 0,
      retentionDebtAgeHours: 0,
      overloadStreak: Number(previousState?.overloadStreak || 0),
      adaptiveLevel: adaptiveProfile.level,
      adaptiveTimeBudgetMs: adaptiveProfile.timeBudgetMs,
      adaptiveSimulationIntervalHours: adaptiveProfile.simulationIntervalHours,
      retentionDebt: Number(summary.retentionBacklogTotal || 0),
      oldestRetentionDebtSimulationAt: null
    };
  }
}

const POLICY = Object.freeze({
  enabled: !["0", "false", "no", "off"].includes(String(process.env.RETENTION_ENABLED || "true").trim().toLowerCase()),
  intervalMs: positiveInt(process.env.RETENTION_CHECK_INTERVAL_MS, 15 * 60 * 1000, 60 * 1000),
  simulationIntervalHours: positiveInt(process.env.RETENTION_CHECK_SIMULATION_HOURS, 1, 1),
  decisionContextDays: positiveInt(process.env.RETENTION_DECISION_CONTEXT_DAYS, 2, 1),
  decisionContextArchiveDays: positiveInt(process.env.RETENTION_DECISION_CONTEXT_ARCHIVE_DAYS, 2, 2),
  decisionOptionsDays: positiveInt(process.env.RETENTION_DECISION_OPTIONS_DAYS, 3, 2),
  cognitiveArtifactDays: positiveInt(process.env.RETENTION_COGNITIVE_ARTIFACT_DAYS, 14, 7),
  needHistoryDays: positiveInt(process.env.RETENTION_NEED_HISTORY_DAYS, 3, 1),
  emotionHistoryDays: positiveInt(process.env.RETENTION_EMOTION_HISTORY_DAYS, 3, 1),
  actionDays: positiveInt(process.env.RETENTION_ACTION_DAYS, 7, 1),
  simulationTickDays: positiveInt(process.env.RETENTION_SIMULATION_TICK_DAYS, 2, 1),
  intentionDays: positiveInt(process.env.RETENTION_INTENTION_DAYS, 7, 1),
  decisionDays: positiveInt(process.env.RETENTION_DECISION_DAYS, 30, 7),
  decisionOptionDays: positiveInt(process.env.RETENTION_DECISION_OPTION_DAYS, 7, 3),
  traitHistoryDays: positiveInt(process.env.RETENTION_TRAIT_HISTORY_DAYS, 30, 7),
  geminiDecisionTelemetryDays: positiveInt(process.env.RETENTION_GEMINI_DECISION_TELEMETRY_DAYS, 30, 7),
  eventDays: positiveInt(process.env.RETENTION_EVENT_DAYS, 7, 1),
  importantEventDays: positiveInt(process.env.RETENTION_IMPORTANT_EVENT_DAYS, 30, 7),
  memoryArchiveDays: positiveInt(process.env.RETENTION_MEMORY_ARCHIVE_DAYS, 21, 7),
  memoryDeleteDays: positiveInt(process.env.RETENTION_MEMORY_DELETE_DAYS, 14, 1),
  memoryArchiveImportanceMax: boundedNumber(process.env.RETENTION_MEMORY_ARCHIVE_IMPORTANCE_MAX, 0.82, 0, 1),
  memoryPermanentImportance: boundedNumber(process.env.RETENTION_MEMORY_PERMANENT_IMPORTANCE, 0.82, 0, 1),
  maxEpisodicMemoriesPerActor: Math.min(10000, positiveInt(process.env.RETENTION_MAX_EPISODIC_MEMORIES_PER_ACTOR, 1200, 100)),
  maxCognitiveExpectationsPerActor: Math.min(10000, positiveInt(process.env.RETENTION_MAX_COGNITIVE_EXPECTATIONS_PER_ACTOR, 1200, 100)),
  maxCounterfactualsPerActor: Math.min(20000, positiveInt(process.env.RETENTION_MAX_COUNTERFACTUALS_PER_ACTOR, 2500, 100)),
  maxCounterfactualWorldsPerActor: Math.min(20000, positiveInt(process.env.RETENTION_MAX_COUNTERFACTUAL_WORLDS_PER_ACTOR, 3000, 100)),
  relationshipHistoryDays: positiveInt(process.env.RETENTION_RELATIONSHIP_HISTORY_DAYS, 45, 7),
  cognitiveStateDetailDays: positiveInt(process.env.RETENTION_COGNITIVE_STATE_DETAIL_DAYS, 7, 1),
  societyWealthDetailDays: positiveInt(process.env.RETENTION_SOCIETY_WEALTH_DETAIL_DAYS, 7, 1),
  societyTradeDetailDays: positiveInt(process.env.RETENTION_SOCIETY_TRADE_DETAIL_DAYS, 14, 1),
  societyProductionDetailDays: positiveInt(process.env.RETENTION_SOCIETY_PRODUCTION_DETAIL_DAYS, 14, 1),
  snapshotDetailDays: positiveInt(process.env.RETENTION_SNAPSHOT_DETAIL_DAYS, 7, 1),
  eventImportanceKeepThreshold: boundedNumber(process.env.RETENTION_EVENT_IMPORTANCE_KEEP_THRESHOLD, 0.8, 0, 1),
  batchSize: Math.min(5000, positiveInt(process.env.RETENTION_BATCH_SIZE, 3000, 250)),
  maxDeletesPerTable: Math.min(20000, positiveInt(process.env.RETENTION_MAX_DELETES_PER_TABLE, 12000, 500)),
  timeBudgetMs: Math.min(30000, positiveInt(process.env.RETENTION_TIME_BUDGET_MS, 7500, 250)),
  dryRun: ["1", "true", "yes", "on"].includes(String(process.env.RETENTION_DRY_RUN || "false").trim().toLowerCase())
});

function retentionBudgetAvailable(simulationId){
  const deadline=retentionDeadlineAt.get(simulationId);
  return deadline===undefined || Date.now()<deadline;
}

function retentionBudgetRemainingMs(simulationId){
  const deadline=retentionDeadlineAt.get(simulationId);
  return deadline===undefined?Number.POSITIVE_INFINITY:Math.max(0,deadline-Date.now());
}

function isTerminalDecisionStatus(status) {
  return TERMINAL_DECISION_STATUSES.has(String(status || "").trim().toUpperCase());
}

function isTerminalActionStatus(status) {
  return TERMINAL_ACTION_STATUSES.has(String(status || "").trim().toUpperCase());
}

function cutoffDateTime(simulationTime, days) {
  const normalized = normalizeSimulationTimestamp(simulationTime);
  if (typeof normalized !== "string") throw new TypeError("simulationTime must be a string");
  const date = new Date(normalized.replace(" ", "T") + "Z");
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid simulationTime");
  date.setUTCDate(date.getUTCDate() - Math.max(1, Math.floor(days)));
  const pad = n => String(n).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;
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

async function deleteSelectedRows(conn, {
  selectSql,
  selectParams,
  countSql,
  countParams = selectParams,
  deleteTable,
  resultKey,
  deleteKeyColumn="id"
}) {
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, countParams);
    return { [resultKey]: 0, candidates: Number(rows[0]?.candidates || 0), remainingCandidates: Number(rows[0]?.candidates || 0), dryRun: true };
  }

  const simulationId=selectParams?.[0];
  let deleted = 0;
  let stoppedByBudget = false;
  while (deleted < POLICY.maxDeletesPerTable) {
    if (!retentionBudgetAvailable(simulationId)) {
      stoppedByBudget=true;
      break;
    }
    const [rows] = await conn.query(selectSql, selectParams);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    if (!ids.length) break;
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query(
      "DELETE FROM " + deleteTable + " WHERE " + deleteKeyColumn + " IN (" + placeholders + ")",
      ids
    );
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }

  const [backlog] = await conn.query(countSql, countParams);
  return {
    [resultKey]: deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: stoppedByBudget || retentionBudgetRemainingMs(simulationId)<=0
  };
}

async function deleteHistoryDirectBatch(conn,table,simulationId,cutoff,maxDeletes){
  const safeTables=new Set(["entity_need_history","entity_emotion_history"]);
  if(!safeTables.has(table))throw new Error("Unsupported history table");
  let deleted=0;
  while(deleted<maxDeletes&&retentionBudgetAvailable(simulationId)){
    const limit=Math.min(POLICY.batchSize,maxDeletes-deleted);
    const [result]=await conn.query(
      "DELETE FROM "+table+" WHERE id IN (SELECT id FROM (SELECT h.id FROM "+table+" h JOIN entities e ON e.id=h.entity_id WHERE e.simulation_id=UUID_TO_BIN(?) AND h.simulation_time < ? ORDER BY h.simulation_time ASC LIMIT "+limit+") doomed)",
      [simulationId,cutoff]
    );
    const affected=Number(result.affectedRows||0);
    deleted+=affected;
    if(affected<limit)break;
  }
  const [backlog]=await conn.query(
    "SELECT COUNT(*) AS candidates FROM "+table+" h JOIN entities e ON e.id=h.entity_id WHERE e.simulation_id=UUID_TO_BIN(?) AND h.simulation_time < ?",
    [simulationId,cutoff]
  );
  return {deleted,remainingCandidates:Number(backlog[0]?.candidates||0),budgetExhausted:retentionBudgetRemainingMs(simulationId)<=0};
}

async function deleteOldNeedHistory(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.needHistoryDays);
  return deleteHistoryDirectBatch(conn,"entity_need_history",simulationId,cutoff,POLICY.maxDeletesPerTable);
}

async function deleteOldEmotionHistory(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.emotionHistoryDays);
  return deleteHistoryDirectBatch(conn,"entity_emotion_history",simulationId,cutoff,POLICY.maxDeletesPerTable);
}

async function archiveExcessEpisodicMemories(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.memoryArchiveDays);
  const permanentImportance=POLICY.memoryPermanentImportance;
  const maxPerActor=POLICY.maxEpisodicMemoriesPerActor;
  const selectSql=
    "SELECT id FROM ("+
    "SELECT m.id,ROW_NUMBER() OVER(PARTITION BY m.entity_id ORDER BY m.importance DESC,m.strength DESC,m.created_simulation_at DESC) AS rn "+
    "FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?) AND m.memory_type='EPISODIC' "+
    "AND m.status IN ('ACTIVE','FADING') AND m.created_simulation_at>=? "+
    "AND m.importance < ? "+
    "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'') NOT IN ('resource_failure','goal_progress')"+
    ") ranked WHERE ranked.rn>? LIMIT "+POLICY.batchSize;
  if(POLICY.dryRun){
    const [rows]=await conn.query(
      "SELECT COUNT(*) AS candidates FROM ("+
      "SELECT m.id,ROW_NUMBER() OVER(PARTITION BY m.entity_id ORDER BY m.importance DESC,m.strength DESC,m.created_simulation_at DESC) AS rn "+
      "FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?) AND m.memory_type='EPISODIC' AND m.status IN ('ACTIVE','FADING') "+
      "AND m.created_simulation_at>=? AND m.importance < ? "+
      "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'') NOT IN ('resource_failure','goal_progress')"+
      ") ranked WHERE ranked.rn>?",
      [simulationId,cutoff,permanentImportance,maxPerActor]
    );
    const candidates=Number(rows[0]?.candidates||0);
    return{candidates,archived:0,remainingCandidates:candidates,dryRun:true};
  }
  let archived=0;
  while(archived<POLICY.maxDeletesPerTable&&retentionBudgetAvailable(simulationId)){
    const limit=Math.min(POLICY.batchSize,POLICY.maxDeletesPerTable-archived);
    const [rows]=await conn.query(selectSql,[simulationId,cutoff,permanentImportance,maxPerActor]);
    if(!rows.length)break;
    const ids=rows.map(row=>row.id).filter(Boolean);
    if(!ids.length)break;
    const placeholders=ids.map(()=> "UUID_TO_BIN(?)").join(",");
    const [result]=await conn.query(
      "UPDATE memories SET status='ARCHIVED',forgotten_simulation_at=?,version=version+1 WHERE id IN ("+placeholders+") AND status IN ('ACTIVE','FADING')",
      [simulationTime,...ids]
    );
    const affected=Number(result.affectedRows||0);
    archived+=affected;
    if(affected<rows.length)break;
  }
  return{archived};
}

async function deleteActorCognitiveArtifacts(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.cognitiveArtifactDays);
  const targets=[
    {table:"cognitive_expectations",max:POLICY.maxCognitiveExpectationsPerActor,timeColumn:"created_simulation_at",where:"status='RESOLVED'"},
    {table:"counterfactuals",max:POLICY.maxCounterfactualsPerActor,timeColumn:"created_simulation_at",where:"EXISTS (SELECT 1 FROM decisions d WHERE d.id=counterfactuals.decision_id AND d.status IN ('EXECUTED','FAILED','CANCELLED'))"},
    {table:"counterfactual_worlds",max:POLICY.maxCounterfactualWorldsPerActor,timeColumn:"created_simulation_at",where:"status='RESOLVED'"}
  ];
  const totals={expectations:0,counterfactuals:0,counterfactualWorlds:0};
  for(const target of targets){
    if(!retentionBudgetAvailable(simulationId))break;
    const [result]=await conn.query(
      "DELETE t FROM "+target.table+" t JOIN (SELECT id FROM (SELECT x.id,ROW_NUMBER() OVER(PARTITION BY x.entity_id ORDER BY x."+target.timeColumn+" DESC) AS rn FROM "+target.table+" x WHERE x.simulation_id=UUID_TO_BIN(?) AND "+target.where.replaceAll("counterfactuals","x")+" AND x."+target.timeColumn+"<?) ranked WHERE ranked.rn>? LIMIT "+POLICY.batchSize+") doomed ON doomed.id=t.id",
      [simulationId,cutoff,target.max]
    );
    const affected=Number(result.affectedRows||0);
    if(target.table==="cognitive_expectations")totals.expectations=affected;
    else if(target.table==="counterfactuals")totals.counterfactuals=affected;
    else totals.counterfactualWorlds=affected;
  }
  return totals;
}

async function compactOldPlanStepResults(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.actionDays);
  const [rows]=await conn.query(
    "SELECT BIN_TO_UUID(ps.id) AS id,ps.result " +
    "FROM plan_steps ps JOIN plans p ON p.id=ps.plan_id " +
    "WHERE p.simulation_id=UUID_TO_BIN(?) AND p.created_simulation_at<? " +
    "AND ps.status IN ('COMPLETED','FAILED','CANCELLED') " +
    "AND ps.result IS NOT NULL ORDER BY ps.id ASC LIMIT "+POLICY.batchSize,
    [simulationId,cutoff]
  );
  if(POLICY.dryRun)return{candidates:rows.length,updated:0,remainingCandidates:rows.length,dryRun:true};
  let updated=0;
  for(const row of rows){
    if(!retentionBudgetAvailable(simulationId))break;
    const compacted=compactPlanStepResult(row.result);
    if(JSON.stringify(parseJson(row.result,null))===JSON.stringify(compacted))continue;
    const [result]=await conn.query(
      "UPDATE plan_steps SET result=?,version=version+1 WHERE id=UUID_TO_BIN(?)",
      [JSON.stringify(compacted),row.id]
    );
    updated+=Number(result.affectedRows||0);
  }
  const [backlog]=await conn.query(
    "SELECT COUNT(*) AS candidates FROM plan_steps ps JOIN plans p ON p.id=ps.plan_id " +
    "WHERE p.simulation_id=UUID_TO_BIN(?) AND p.created_simulation_at<? " +
    "AND ps.status IN ('COMPLETED','FAILED','CANCELLED') AND ps.result IS NOT NULL",
    [simulationId,cutoff]
  );
  return{candidates:rows.length,updated,remainingCandidates:Number(backlog[0]?.candidates||0)};
}

async function compactExistingDecisionActionSummaries(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.actionDays);
  const [rows]=await conn.query(
    "SELECT BIN_TO_UUID(id) AS id,actual_outcome AS actualOutcome FROM decisions " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND simulation_time<? AND actual_outcome IS NOT NULL " +
    "AND JSON_CONTAINS_PATH(actual_outcome,'one','$.actionSummary') " +
    "ORDER BY simulation_time ASC LIMIT "+POLICY.batchSize,
    [simulationId,cutoff]
  );
  if(POLICY.dryRun)return{candidates:rows.length,updated:0,remainingCandidates:rows.length,dryRun:true};
  let updated=0;
  for(const row of rows){
    if(!retentionBudgetAvailable(simulationId))break;
    const compacted=compactDecisionActualOutcome(row.actualOutcome);
    if(JSON.stringify(parseJson(row.actualOutcome,null))===JSON.stringify(compacted))continue;
    const [result]=await conn.query(
      "UPDATE decisions SET actual_outcome=? WHERE id=UUID_TO_BIN(?)",
      [JSON.stringify(compacted),row.id]
    );
    updated+=Number(result.affectedRows||0);
  }
  const [backlog]=await conn.query(
    "SELECT COUNT(*) AS candidates FROM decisions " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND simulation_time<? AND actual_outcome IS NOT NULL " +
    "AND JSON_CONTAINS_PATH(actual_outcome,'one','$.actionSummary')",
    [simulationId,cutoff]
  );
  return{candidates:rows.length,updated,remainingCandidates:Number(backlog[0]?.candidates||0)};
}

async function deduplicateCounterfactualWorldBaselines(conn,simulationId,simulationTime){
  if(POLICY.dryRun)return{candidates:0,updated:0,remainingCandidates:0,dryRun:true};
  let updated=0;
  let candidates=0;
  let budgetExhausted=false;
  while(updated<Math.min(POLICY.maxDeletesPerTable,POLICY.batchSize) && retentionBudgetAvailable(simulationId)){
    const limit=Math.min(POLICY.batchSize,POLICY.maxDeletesPerTable-updated);
    const [rows]=await conn.query(
      "SELECT id FROM (" +
        "SELECT id,ROW_NUMBER() OVER(PARTITION BY decision_id ORDER BY selected DESC,id ASC) AS rn " +
        "FROM counterfactual_worlds " +
        "WHERE simulation_id=UUID_TO_BIN(?) AND baseline_state IS NOT NULL" +
      ") ranked WHERE ranked.rn>1 LIMIT "+limit,
      [simulationId]
    );
    if(!rows.length)break;
    candidates+=rows.length;
    const ids=rows.map(row=>row.id).filter(Boolean);
    if(!ids.length)break;
    const placeholders=ids.map(()=> "UUID_TO_BIN(?)").join(",");
    const [result]=await conn.query(
      "UPDATE counterfactual_worlds " +
      "SET baseline_state=NULL,version=version+1 " +
      "WHERE simulation_id=UUID_TO_BIN(?) AND id IN ("+placeholders+")",
      [simulationId,...ids]
    );
    const affected=Number(result.affectedRows||0);
    updated+=affected;
    if(affected<ids.length)break;
    if(!retentionBudgetAvailable(simulationId))budgetExhausted=true;
  }
  const [backlog]=await conn.query(
    "SELECT COUNT(*) AS candidates FROM (" +
      "SELECT id,ROW_NUMBER() OVER(PARTITION BY decision_id ORDER BY selected DESC,id ASC) AS rn " +
      "FROM counterfactual_worlds " +
      "WHERE simulation_id=UUID_TO_BIN(?) AND baseline_state IS NOT NULL" +
    ") ranked WHERE ranked.rn>1",
    [simulationId]
  );
  return{
    candidates,
    updated,
    remainingCandidates:Number(backlog[0]?.candidates||0),
    budgetExhausted:budgetExhausted || retentionBudgetRemainingMs(simulationId)<=0
  };
}

async function deleteOldRelationshipHistory(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.relationshipHistoryDays);
  const selectSql="SELECT BIN_TO_UUID(rh.id) AS id FROM relationship_history rh JOIN relationships r ON r.id=rh.relationship_id WHERE rh.simulation_id=UUID_TO_BIN(?) AND rh.simulation_time<? AND r.status IN ('ACTIVE','ENDED') ORDER BY rh.simulation_time ASC LIMIT "+POLICY.batchSize;
  const countSql="SELECT COUNT(*) AS candidates FROM relationship_history rh WHERE rh.simulation_id=UUID_TO_BIN(?) AND rh.simulation_time<?";
  return deleteSelectedRows(conn,{selectSql,selectParams:[simulationId,cutoff],countSql,countParams:[simulationId,cutoff],deleteTable:"relationship_history",resultKey:"deleted"});
}

async function backfillMemoryDedupeKeys(conn,simulationId){
  if(!retentionBudgetAvailable(simulationId))return 0;
  const limit=POLICY.batchSize;
  const [result]=await conn.query(
    "UPDATE memories SET memory_dedupe_key=SHA2(CONCAT_WS('|',entity_id,COALESCE(location_id,''),LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType')),'')),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome')),''),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decision.goalId')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.goalId')),''),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.planId')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decision.planId')), '')),256) WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND memory_dedupe_key IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='action_outcome' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome'))='SUCCESS' AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType')),''))<>'talking' AND importance<=0.55 AND emotional_intensity<=0.30 LIMIT "+limit,
    [simulationId]
  );
  return Number(result.affectedRows||0);
}

async function compactDuplicateMemories(conn,simulationId,simulationTime){
  const cutoff=cutoffDateTime(simulationTime,POLICY.memoryDeleteDays);
  let deleted=0;
  while(deleted<POLICY.maxDeletesPerTable&&retentionBudgetAvailable(simulationId)){
    const limit=Math.min(POLICY.batchSize,POLICY.maxDeletesPerTable-deleted);
    const [result]=await conn.query(
      "DELETE m FROM memories m JOIN (SELECT id FROM (SELECT m2.id,ROW_NUMBER() OVER(PARTITION BY m2.memory_dedupe_key ORDER BY m2.importance DESC,m2.strength DESC,m2.created_simulation_at DESC) AS rn FROM memories m2 WHERE m2.simulation_id=UUID_TO_BIN(?) AND m2.status='ACTIVE' AND m2.memory_dedupe_key IS NOT NULL AND m2.created_simulation_at < ? AND m2.importance<=0.55 AND m2.emotional_intensity<=0.30) ranked WHERE ranked.rn>1 LIMIT "+limit+") doomed ON doomed.id=m.id",
      [simulationId,cutoff]
    );
    const affected=Number(result.affectedRows||0);
    deleted+=affected;
    if(affected<limit)break;
  }
  const [backlog]=await conn.query(
    "SELECT COALESCE(SUM(cnt-1),0) AS candidates FROM (SELECT COUNT(*) AS cnt FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND memory_dedupe_key IS NOT NULL AND created_simulation_at < ? AND importance<=0.55 AND emotional_intensity<=0.30 GROUP BY memory_dedupe_key HAVING COUNT(*)>1) duplicate_groups",
    [simulationId,cutoff]
  );
  return {deleted,remainingCandidates:Number(backlog[0]?.candidates||0)};
}
async function archiveStaleMemories(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.memoryArchiveDays);
  const importanceMax = POLICY.memoryArchiveImportanceMax;
  const selectSql =
    "SELECT BIN_TO_UUID(m.id) AS id FROM memories m " +
    "WHERE m.simulation_id=UUID_TO_BIN(?) " +
    "AND m.memory_type='EPISODIC' " +
    "AND m.status IN ('ACTIVE','FADING') " +
    "AND m.created_simulation_at < ? " +
    "AND m.importance < ? " +
    "AND (m.last_recalled_simulation_at IS NULL OR m.last_recalled_simulation_at < ?) " +
    "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'') <> 'resource_failure' " +
    "ORDER BY m.created_simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM memories m " +
    "WHERE m.simulation_id=UUID_TO_BIN(?) " +
    "AND m.memory_type='EPISODIC' " +
    "AND m.status IN ('ACTIVE','FADING') " +
    "AND m.created_simulation_at < ? " +
    "AND m.importance < ? " +
    "AND (m.last_recalled_simulation_at IS NULL OR m.last_recalled_simulation_at < ?) " +
    "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'') <> 'resource_failure'";
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff, importanceMax, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), archived: 0, dryRun: true };
  }
  let archived = 0;
  while (archived < POLICY.maxDeletesPerTable && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff, importanceMax, cutoff]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    if (!ids.length) break;
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query(
      "UPDATE memories SET status='ARCHIVED',forgotten_simulation_at=?,version=version+1 WHERE id IN (" +
      placeholders + ") AND status IN ('ACTIVE','FADING')",
      [simulationTime, ...ids]
    );
    const affected = Number(result.affectedRows || 0);
    archived += affected;
    if (affected < rows.length) break;
  }
  return { archived };
}

async function deleteOldMemories(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.memoryDeleteDays);
  const selectSql =
    "SELECT BIN_TO_UUID(m.id) AS id FROM memories m " +
    "WHERE m.simulation_id=UUID_TO_BIN(?) " +
    "AND m.status IN ('ARCHIVED','FORGOTTEN') " +
    "AND COALESCE(m.forgotten_simulation_at,m.created_simulation_at) < ? " +
    "AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_memory_id=m.id) " +
    "ORDER BY COALESCE(m.forgotten_simulation_at,m.created_simulation_at) ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM memories m " +
    "WHERE m.simulation_id=UUID_TO_BIN(?) " +
    "AND m.status IN ('ARCHIVED','FORGOTTEN') " +
    "AND COALESCE(m.forgotten_simulation_at,m.created_simulation_at) < ? " +
    "AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_memory_id=m.id)";
  return deleteSelectedRows(conn, {
    selectSql,
    selectParams: [simulationId, cutoff],
    countSql,
    deleteTable: "memories",
    resultKey: "deleted"
  });
}

async function compactOldDecisionContexts(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.decisionContextDays);
  const archiveCandidatesSql =
    "SELECT BIN_TO_UUID(d.id) AS decisionId,BIN_TO_UUID(d.entity_id) AS entityId,d.simulation_id AS simulationId,d.simulation_time AS simulationTime,BIN_TO_UUID(d.selected_option_id) AS selectedOptionId,d.context " +
    "FROM decisions d " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND d.context IS NOT NULL " +
    "AND COALESCE(" +
    "IF(" +
    "JSON_VALID(d.context)," +
    "JSON_UNQUOTE(JSON_EXTRACT(d.context,'$.operational'))," +
    "'false'" +
    ")," +
    "'false'" +
    ") <> 'true'";

  if (POLICY.dryRun) {
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS candidates FROM (" + archiveCandidatesSql + ") legacy_context",
      [simulationId, cutoff]
    );
    return {candidates:Number(rows[0]?.candidates||0),archived:0,updated:0,dryRun:true};
  }

  const [rows] = await conn.query(
    archiveCandidatesSql + " ORDER BY d.simulation_time ASC LIMIT " + POLICY.batchSize,
    [simulationId, cutoff]
  );

  let archived=0;
  const archivedDecisionContexts = [];
  for(const row of rows){
    if(!retentionBudgetAvailable(simulationId))break;
    const archiveContext = normalizeArchiveJson(row.context);
    await conn.query(
      `INSERT INTO decision_context_archive
       (decision_id,simulation_id,entity_id,simulation_time,context)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)
       ON DUPLICATE KEY UPDATE decision_id=decision_id`,
      [
        row.decisionId,
        simulationId,
        row.entityId,
        row.simulationTime,
        serializeArchiveJson(archiveContext)
      ]
    );
    archivedDecisionContexts.push({
      decisionId: row.decisionId,
      selectedOptionId: row.selectedOptionId || null,
      context: archiveContext
    });
    archived+=1;
  }

  if(archivedDecisionContexts.length){
    for(const item of archivedDecisionContexts){
      if(!retentionBudgetAvailable(simulationId))break;
      const context = item.context && typeof item.context === "object" ? item.context : {};
      const operationalContext = {
        schemaVersion: 4,
        operational: true,
        archived: true,
        chosenAction: context.chosenAction ?? null,
        selectedOptionId: item.selectedOptionId || null
      };
      await conn.query(
        "UPDATE decisions SET context=? WHERE id=UUID_TO_BIN(?)",
        [JSON.stringify(operationalContext), item.decisionId]
      );
    }
  }

  const [remaining] = await conn.query(
    "SELECT COUNT(*) AS candidates FROM decisions d " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND d.context IS NOT NULL " +
    "AND COALESCE(" +
    "IF(" +
    "JSON_VALID(d.context)," +
    "JSON_UNQUOTE(JSON_EXTRACT(d.context,'$.operational'))," +
    "'false'" +
    ")," +
    "'false'" +
    ") <> 'true'",
    [simulationId,cutoff]
  );

  return {
    candidates:rows.length,
    archived,
    updated:archived,
    remainingCandidates:Number(remaining[0]?.candidates||0)
  };
}

async function deleteOldDecisionContextArchives(conn, simulationId, simulationTime) {
  const cutoff=cutoffDateTime(simulationTime,POLICY.decisionContextArchiveDays);
  const selectSql=
    "SELECT BIN_TO_UUID(decision_id) AS id FROM decision_context_archive " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_time < ? " +
    "ORDER BY simulation_time ASC LIMIT "+POLICY.batchSize;
  const countSql=
    "SELECT COUNT(*) AS candidates FROM decision_context_archive " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_time < ?";
  return deleteSelectedRows(conn,{
    selectSql,
    selectParams:[simulationId,cutoff],
    countSql,
    countParams:[simulationId,cutoff],
    deleteTable:"decision_context_archive",
    resultKey:"deleted",
    deleteKeyColumn:"decision_id"
  });
}

async function deleteUnselectedDecisionOptions(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.decisionOptionsDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(dopt.id) AS id FROM decision_options dopt " +
    "JOIN decisions d ON d.id=dopt.decision_id " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.selected_option_id IS NOT NULL " +
      "AND dopt.id <> d.selected_option_id " +
      "AND d.selected_option_snapshot IS NOT NULL " +
    "AND d.simulation_time < ? " +
    "LIMIT " + limit;
  const countSql =
      "SELECT COUNT(*) AS candidates FROM decision_options dopt " +
      "JOIN decisions d ON d.id=dopt.decision_id " +
      "WHERE d.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.selected_option_id IS NOT NULL " +
      "AND dopt.id <> d.selected_option_id " +
      "AND d.selected_option_snapshot IS NOT NULL " +
      "AND d.simulation_time < ?";
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM decision_options WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function deleteResolvedExpectations(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(ce.id) AS id FROM cognitive_expectations ce " +
    "JOIN decisions d ON d.id=ce.decision_id " +
    "WHERE ce.simulation_id=UUID_TO_BIN(?) " +
    "AND ce.status='RESOLVED' " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND ce.resolved_simulation_at < ? " +
    "LIMIT " + limit;
  const countSql =
      "SELECT COUNT(*) AS candidates FROM cognitive_expectations ce " +
      "JOIN decisions d ON d.id=ce.decision_id " +
      "WHERE ce.simulation_id=UUID_TO_BIN(?) " +
      "AND ce.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ? " +
      "AND ce.resolved_simulation_at < ?";
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff, cutoff]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM cognitive_expectations WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  const [backlog] = await conn.query(countSql, [simulationId, cutoff, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function deleteResolvedCounterfactuals(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(cf.id) AS id FROM counterfactuals cf " +
    "JOIN decisions d ON d.id=cf.decision_id " +
    "WHERE cf.simulation_id=UUID_TO_BIN(?) " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "LIMIT " + limit;
  const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactuals cf " +
      "JOIN decisions d ON d.id=cf.decision_id " +
      "WHERE cf.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ?";
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM counterfactuals WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function deleteResolvedCounterfactualWorlds(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.cognitiveArtifactDays);
  const limit = POLICY.batchSize;
  const maxDeletes = POLICY.maxDeletesPerTable;
  const selectSql =
    "SELECT BIN_TO_UUID(cw.id) AS id FROM counterfactual_worlds cw " +
    "JOIN decisions d ON d.id=cw.decision_id " +
    "WHERE cw.simulation_id=UUID_TO_BIN(?) " +
    "AND cw.status='RESOLVED' " +
    "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND cw.resolved_simulation_at < ? " +
    "LIMIT " + limit;
  const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactual_worlds cw " +
      "JOIN decisions d ON d.id=cw.decision_id " +
      "WHERE cw.simulation_id=UUID_TO_BIN(?) " +
      "AND cw.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ? " +
      "AND cw.resolved_simulation_at < ?";
  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), deleted: 0, dryRun: true };
  }
  let deleted = 0;
  while (deleted < maxDeletes && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff, cutoff]);
    if (!rows.length) break;
    const ids = rows.map(row => row.id).filter(Boolean);
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
    const [result] = await conn.query("DELETE FROM counterfactual_worlds WHERE id IN (" + placeholders + ")", ids);
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }
  const [backlog] = await conn.query(countSql, [simulationId, cutoff, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function deleteOldSimulationTicks(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.simulationTickDays);
  const countSql =
    "SELECT COUNT(*) AS candidates FROM simulation_ticks t " +
    "WHERE t.simulation_id=UUID_TO_BIN(?) " +
    "AND t.status IN ('COMPLETED','FAILED','SKIPPED') " +
    "AND t.simulation_time < ?";

  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    const candidates = Number(rows[0]?.candidates || 0);
    return {
      deleted: 0,
      candidates,
      remainingCandidates: candidates,
      eventsDetached: 0,
      dryRun: true
    };
  }

  let deleted = 0;
  let eventsDetached = 0;
  while (deleted < POLICY.maxDeletesPerTable && retentionBudgetAvailable(simulationId)) {
    const limit = Math.min(POLICY.batchSize, POLICY.maxDeletesPerTable - deleted);
    const [rows] = await conn.query(
      "SELECT BIN_TO_UUID(t.id) AS id FROM simulation_ticks t " +
      "WHERE t.simulation_id=UUID_TO_BIN(?) " +
      "AND t.status IN ('COMPLETED','FAILED','SKIPPED') " +
      "AND t.simulation_time < ? " +
      "ORDER BY t.simulation_time ASC LIMIT " + limit,
      [simulationId, cutoff]
    );
    if (!rows.length) break;

    const ids = rows.map(row => row.id).filter(Boolean);
    if (!ids.length) break;
    const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");

    // Events outlive ticks. source_tick_id is only provenance metadata, so
    // detach that optional reference before removing the tick. Keeping the
    // event itself preserves the longer event retention policy.
    const [detached] = await conn.query(
      "UPDATE events " +
      "SET source_tick_id=NULL " +
      "WHERE simulation_id=UUID_TO_BIN(?) " +
      "AND source_tick_id IN (" + placeholders + ")",
      [simulationId, ...ids]
    );
    eventsDetached += Number(detached.affectedRows || 0);

    const [result] = await conn.query(
      "DELETE FROM simulation_ticks WHERE id IN (" + placeholders + ") " +
      "AND simulation_id=UUID_TO_BIN(?) " +
      "AND status IN ('COMPLETED','FAILED','SKIPPED')",
      [...ids, simulationId]
    );
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < rows.length) break;
  }

  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    deleted,
    candidates: Number(backlog[0]?.candidates || 0) + deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    eventsDetached,
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function deleteOldEvents(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.eventDays);
  const importantCutoff = cutoffDateTime(simulationTime, POLICY.importantEventDays);
  const importanceThreshold = POLICY.eventImportanceKeepThreshold;
  const selectSql =
    "SELECT BIN_TO_UUID(e.id) AS id FROM events e " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) " +
    "AND ((e.importance < ? AND e.simulation_at < ?) OR e.simulation_at < ?) " +
    "ORDER BY e.simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM events e " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) " +
    "AND ((e.importance < ? AND e.simulation_at < ?) OR e.simulation_at < ?)";
  return deleteSelectedRows(conn, {
    selectSql,
    selectParams: [simulationId, importanceThreshold, cutoff, importantCutoff],
    countSql,
    countParams: [simulationId, importanceThreshold, cutoff, importantCutoff],
    deleteTable: "events",
    resultKey: "deleted"
  });
}

async function compactOldActionDecisionSummaries(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.actionDays);
  const limit = POLICY.batchSize;
  const maxUpdates = POLICY.maxDeletesPerTable;
  const selectSql =
    `SELECT BIN_TO_UUID(a.id) AS actionId, BIN_TO_UUID(d.id) AS decisionId,
            a.action_type AS actionType, a.source_type AS sourceType,
            a.status, a.started_simulation_at AS startedAt,
            a.completed_simulation_at AS completedAt,
            a.target, a.parameters, a.result
     FROM actions a
     JOIN decisions d ON d.id=a.decision_id
     WHERE a.simulation_id=UUID_TO_BIN(?)
       AND a.decision_id IS NOT NULL
       AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED')
       AND a.completed_simulation_at IS NOT NULL
       AND a.completed_simulation_at < ?
       AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NULL
     ORDER BY a.completed_simulation_at ASC
     LIMIT ${limit}`;
  if (POLICY.dryRun) {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS candidates
       FROM actions a
       JOIN decisions d ON d.id=a.decision_id
       WHERE a.simulation_id=UUID_TO_BIN(?)
         AND a.decision_id IS NOT NULL
         AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED')
         AND a.completed_simulation_at IS NOT NULL
         AND a.completed_simulation_at < ?
         AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NULL`,
      [simulationId, cutoff]
    );
    return { candidates: Number(rows[0]?.candidates || 0), updated: 0, dryRun: true };
  }
  let updated = 0;
  while (updated < maxUpdates && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff]);
    if (!rows.length) break;
    for (const row of rows) {
      if (!retentionBudgetAvailable(simulationId) || updated >= maxUpdates) break;
      const actionSummary = {
        schemaVersion: 2,
        actionId: row.actionId,
        decisionId: row.decisionId,
        actionType: row.actionType,
        sourceType: row.sourceType,
        status: row.status,
        startedSimulationAt: row.startedAt || null,
        completedSimulationAt: row.completedAt || null,
        target: compactActionTarget(row.target),
        parameters: compactActionParameters(row.parameters),
        result: compactActionResult(row.result)
      };
      const [result] = await conn.query(
        `UPDATE decisions
         SET actual_outcome=JSON_SET(
           COALESCE(actual_outcome,JSON_OBJECT()),
           '$.actionSummary',CAST(? AS JSON)
         )
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND JSON_EXTRACT(actual_outcome,'$.actionSummary') IS NULL`,
        [JSON.stringify(actionSummary), row.decisionId, simulationId]
      );
      updated += Number(result.affectedRows || 0);
    }
    if (rows.length < limit) break;
  }
  const [backlog] = await conn.query(
    `SELECT COUNT(*) AS candidates
     FROM actions a
     JOIN decisions d ON d.id=a.decision_id
     WHERE a.simulation_id=UUID_TO_BIN(?)
       AND a.decision_id IS NOT NULL
       AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED')
       AND a.completed_simulation_at IS NOT NULL
       AND a.completed_simulation_at < ?
       AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NULL`,
    [simulationId, cutoff]
  );
  return {
    candidates: Number(backlog[0]?.candidates || 0) + updated,
    updated,
    remainingCandidates: Number(backlog[0]?.candidates || 0)
  };
}

async function deleteOldIntentions(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.intentionDays);
  const selectSql =
    "SELECT BIN_TO_UUID(i.id) AS id FROM intentions i " +
    "WHERE i.simulation_id=UUID_TO_BIN(?) AND i.status IN ('COMPLETED','CANCELLED') " +
    "AND i.created_simulation_at < ? " +
    "AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.source_intention_id=i.id) " +
    "ORDER BY i.created_simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM intentions i " +
    "WHERE i.simulation_id=UUID_TO_BIN(?) AND i.status IN ('COMPLETED','CANCELLED') " +
    "AND i.created_simulation_at < ? " +
    "AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.source_intention_id=i.id)";
  return deleteSelectedRows(conn,{
    selectSql,selectParams:[simulationId,cutoff],
    countSql,countParams:[simulationId,cutoff],
    deleteTable:"intentions",resultKey:"deleted"
  });
}

async function deleteOldDecisionOptions(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.decisionOptionDays);
  const selectSql =
    "SELECT BIN_TO_UUID(dopt.id) AS id FROM decision_options dopt " +
    "JOIN decisions d ON d.id=dopt.decision_id " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? ORDER BY d.simulation_time ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM decision_options dopt " +
    "JOIN decisions d ON d.id=dopt.decision_id " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ?";

  if (POLICY.dryRun) {
    const [rows]=await conn.query(countSql,[simulationId,cutoff]);
    const candidates=Number(rows[0]?.candidates||0);
    return {candidates,deleted:0,remainingCandidates:candidates,dryRun:true};
  }

  let deleted=0;
  while(deleted<POLICY.maxDeletesPerTable&&retentionBudgetAvailable(simulationId)){
    await conn.query(
      "UPDATE decisions d JOIN decision_options dopt ON dopt.decision_id=d.id " +
      "SET d.selected_option_id=NULL " +
      "WHERE d.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ? " +
      "AND d.selected_option_id=dopt.id",
      [simulationId,cutoff]
    );
    const [rows]=await conn.query(selectSql,[simulationId,cutoff]);
    if(!rows.length)break;
    const ids=rows.map(row=>row.id).filter(Boolean);
    if(!ids.length)break;
    const placeholders=ids.map(()=> "UUID_TO_BIN(?)").join(",");
    const [result]=await conn.query(
      "DELETE FROM decision_options WHERE id IN ("+placeholders+")",
      ids
    );
    const affected=Number(result.affectedRows||0);
    deleted+=affected;
    if(affected<rows.length)break;
  }

  const [backlog]=await conn.query(countSql,[simulationId,cutoff]);
  return {
    deleted,
    remainingCandidates:Number(backlog[0]?.candidates||0),
    budgetExhausted:retentionBudgetRemainingMs(simulationId)<=0
  };
}

async function deleteOldTraitHistory(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.traitHistoryDays);
  const selectSql =
    "SELECT BIN_TO_UUID(th.id) AS id FROM entity_trait_history th " +
    "JOIN entities e ON e.id=th.entity_id " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) AND th.changed_simulation_at < ? " +
    "ORDER BY th.changed_simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM entity_trait_history th " +
    "JOIN entities e ON e.id=th.entity_id " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) AND th.changed_simulation_at < ?";
  return deleteSelectedRows(conn,{
    selectSql,selectParams:[simulationId,cutoff],
    countSql,countParams:[simulationId,cutoff],
    deleteTable:"entity_trait_history",resultKey:"deleted"
  });
}

async function deleteOldGeminiDecisionTelemetry(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.geminiDecisionTelemetryDays);
  const selectSql =
    "SELECT id FROM gemini_decision_telemetry " +
    "WHERE simulation_id=? AND simulation_at < ? " +
    "ORDER BY simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM gemini_decision_telemetry " +
    "WHERE simulation_id=? AND simulation_at < ?";
  if (POLICY.dryRun) {
    const [rows]=await conn.query(countSql,[String(simulationId),cutoff]);
    const candidates=Number(rows[0]?.candidates||0);
    return {candidates,deleted:0,remainingCandidates:candidates,dryRun:true};
  }
  let deleted=0;
  while(deleted< POLICY.maxDeletesPerTable && retentionBudgetAvailable(simulationId)){
    const [rows]=await conn.query(selectSql,[String(simulationId),cutoff]);
    if(!rows.length)break;
    const ids=rows.map(row=>Number(row.id)).filter(Number.isFinite);
    if(!ids.length)break;
    const placeholders=ids.map(()=>"?").join(",");
    const [result]=await conn.query("DELETE FROM gemini_decision_telemetry WHERE id IN ("+placeholders+")",ids);
    const affected=Number(result.affectedRows||0);
    deleted+=affected;
    if(affected<rows.length)break;
  }
  const [backlog]=await conn.query(countSql,[String(simulationId),cutoff]);
  return {
    deleted,
    remainingCandidates:Number(backlog[0]?.candidates||0),
    budgetExhausted:retentionBudgetRemainingMs(simulationId)<=0
  };
}


async function deleteOldDecisions(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.decisionDays);
  const selectSql =
    "SELECT BIN_TO_UUID(d.id) AS id FROM decisions d " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM intentions i WHERE i.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM decision_options dopt WHERE dopt.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM counterfactuals cf WHERE cf.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM decision_context_archive dca WHERE dca.decision_id=d.id) " +
    "ORDER BY d.simulation_time ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM decisions d " +
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
    "AND d.simulation_time < ? " +
    "AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM intentions i WHERE i.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM decision_options dopt WHERE dopt.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM counterfactuals cf WHERE cf.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id) " +
    "AND NOT EXISTS (SELECT 1 FROM decision_context_archive dca WHERE dca.decision_id=d.id)";
  return deleteSelectedRows(conn,{
    selectSql,selectParams:[simulationId,cutoff],
    countSql,countParams:[simulationId,cutoff],
    deleteTable:"decisions",resultKey:"deleted"
  });
}

async function deleteOldActions(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.actionDays);
  const selectSql =
    "SELECT BIN_TO_UUID(a.id) AS id FROM actions a " +
    "WHERE a.simulation_id=UUID_TO_BIN(?) " +
    "AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED') " +
    "AND a.completed_simulation_at IS NOT NULL " +
    "AND a.completed_simulation_at < ? " +
    "AND (a.decision_id IS NULL OR EXISTS (" +
      "SELECT 1 FROM decisions d WHERE d.id=a.decision_id " +
      "AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NOT NULL)) " +
    "AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_action_id=a.id) " +
    "ORDER BY a.completed_simulation_at ASC LIMIT " + POLICY.batchSize;
  const countSql =
    "SELECT COUNT(*) AS candidates FROM actions a " +
    "WHERE a.simulation_id=UUID_TO_BIN(?) " +
    "AND a.status IN ('COMPLETED','CANCELLED','INTERRUPTED','FAILED') " +
    "AND a.completed_simulation_at IS NOT NULL " +
    "AND a.completed_simulation_at < ? " +
    "AND (a.decision_id IS NULL OR EXISTS (" +
      "SELECT 1 FROM decisions d WHERE d.id=a.decision_id " +
      "AND JSON_EXTRACT(d.actual_outcome,'$.actionSummary') IS NOT NULL)) " +
    "AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.target_action_id=a.id)";
  return deleteSelectedRows(conn, {
    selectSql,
    selectParams: [simulationId, cutoff],
    countSql,
    deleteTable: "actions",
    resultKey: "deleted"
  });
}


async function compactOldDailySample(conn, {
  table,
  simulationId,
  cutoff,
  partitionColumns,
  timeColumn,
  resultKey = "deleted"
}) {
  const safeTables = new Set(["cognitive_states", "emergent_wealth_history", "simulation_snapshots"]);
  const safeTimeColumns = new Set(["simulation_time","simulation_at"]);
  if (!safeTables.has(table) || !safeTimeColumns.has(timeColumn)) {
    throw new Error("Unsupported daily-sample retention target");
  }

  const partition = partitionColumns.join(",");
  const countSql =
    "SELECT COALESCE(SUM(cnt-1),0) AS candidates FROM (" +
    "SELECT " + partition + ", COUNT(*) AS cnt " +
    "FROM " + table +
    " WHERE simulation_id=UUID_TO_BIN(?) AND " + timeColumn + " < ? " +
    "GROUP BY " + partition +
    " HAVING COUNT(*) > 1" +
    ") groups_to_compact";

  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    const candidates = Number(rows[0]?.candidates || 0);
    return { [resultKey]: 0, candidates, remainingCandidates: candidates, dryRun: true };
  }

  const [result] = await conn.query(
    "DELETE target FROM " + table + " target JOIN (" +
      "SELECT ranked.id FROM (" +
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY " + partition +
        " ORDER BY " + timeColumn + " DESC) AS rn " +
        "FROM " + table +
        " WHERE simulation_id=UUID_TO_BIN(?) AND " + timeColumn + " < ?" +
      ") ranked WHERE ranked.rn > 1 " +
      "LIMIT " + POLICY.maxDeletesPerTable +
    ") victims ON victims.id=target.id"
  , [simulationId, cutoff]
  );

  const deleted = Number(result.affectedRows || 0);
  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    [resultKey]: deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function compactOldCognitiveStates(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.cognitiveStateDetailDays);
  return compactOldDailySample(conn, {
    table: "cognitive_states",
    simulationId,
    cutoff,
    partitionColumns: ["entity_id", "DATE(simulation_time)"],
    timeColumn: "simulation_time",
    resultKey: "deleted"
  });
}

async function compactOldEmergentWealthHistory(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.societyWealthDetailDays);
  return compactOldDailySample(conn, {
    table: "emergent_wealth_history",
    simulationId,
    cutoff,
    partitionColumns: ["entity_id", "DATE(simulation_at)"],
    timeColumn: "simulation_at",
    resultKey: "deleted"
  });
}

async function compactOldSnapshots(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.snapshotDetailDays);
  return compactOldDailySample(conn, {
    table: "simulation_snapshots",
    simulationId,
    cutoff,
    partitionColumns: ["simulation_id", "DATE(simulation_time)"],
    timeColumn: "simulation_time",
    resultKey: "deleted"
  });
}

async function aggregateAndDeleteOldEmergentTrades(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.societyTradeDetailDays);
  const countSql =
    "SELECT COUNT(*) AS candidates FROM emergent_trades " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ?";

  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    const candidates = Number(rows[0]?.candidates || 0);
    return { deleted: 0, candidates, remainingCandidates: candidates, dryRun: true };
  }

  if (!retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    return { deleted: 0, candidates: Number(rows[0]?.candidates || 0), remainingCandidates: Number(rows[0]?.candidates || 0), budgetExhausted: true };
  }

  await conn.query(
    "INSERT IGNORE INTO emergent_trade_daily_metrics " +
    "(simulation_id,simulation_date,location_id,good_code,trade_count,buyer_count,seller_count,total_quantity,total_value,average_unit_price,min_unit_price,max_unit_price,first_simulation_at,last_simulation_at) " +
    "SELECT simulation_id,DATE(simulation_at),location_id,good_code,COUNT(*),COUNT(DISTINCT buyer_entity_id),COUNT(DISTINCT seller_entity_id),SUM(quantity),SUM(total),AVG(unit_price),MIN(unit_price),MAX(unit_price),MIN(simulation_at),MAX(simulation_at) " +
    "FROM emergent_trades " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ? " +
    "GROUP BY simulation_id,DATE(simulation_at),location_id,good_code",
    [simulationId, cutoff]
  );

  let deleted = 0;
  while (deleted < POLICY.maxDeletesPerTable && retentionBudgetAvailable(simulationId)) {
    const limit = Math.min(POLICY.batchSize, POLICY.maxDeletesPerTable - deleted);
    const [result] = await conn.query(
      "DELETE FROM emergent_trades " +
      "WHERE id IN (SELECT id FROM (SELECT id FROM emergent_trades WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ? ORDER BY simulation_at ASC LIMIT " + limit + ") doomed)",
      [simulationId, cutoff]
    );
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < limit) break;
  }

  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function aggregateAndDeleteOldEmergentProduction(conn, simulationId, simulationTime) {
  const cutoff = cutoffDateTime(simulationTime, POLICY.societyProductionDetailDays);
  const countSql =
    "SELECT COUNT(*) AS candidates FROM emergent_production_history " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ?";

  if (POLICY.dryRun) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    const candidates = Number(rows[0]?.candidates || 0);
    return { deleted: 0, candidates, remainingCandidates: candidates, dryRun: true };
  }

  if (!retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    return { deleted: 0, candidates: Number(rows[0]?.candidates || 0), remainingCandidates: Number(rows[0]?.candidates || 0), budgetExhausted: true };
  }

  await conn.query(
    "INSERT IGNORE INTO emergent_production_daily_metrics " +
    "(simulation_id,simulation_date,producer_entity_id,structure_entity_id,good_code,production_count,total_quantity,average_quantity,first_simulation_at,last_simulation_at) " +
    "SELECT simulation_id,DATE(simulation_at),producer_entity_id,structure_entity_id,good_code,COUNT(*),SUM(quantity),AVG(quantity),MIN(simulation_at),MAX(simulation_at) " +
    "FROM emergent_production_history " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ? " +
    "GROUP BY simulation_id,DATE(simulation_at),producer_entity_id,structure_entity_id,good_code",
    [simulationId, cutoff]
  );

  let deleted = 0;
  while (deleted < POLICY.maxDeletesPerTable && retentionBudgetAvailable(simulationId)) {
    const limit = Math.min(POLICY.batchSize, POLICY.maxDeletesPerTable - deleted);
    const [result] = await conn.query(
      "DELETE FROM emergent_production_history " +
      "WHERE id IN (SELECT id FROM (SELECT id FROM emergent_production_history WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at < ? ORDER BY simulation_at ASC LIMIT " + limit + ") doomed)",
      [simulationId, cutoff]
    );
    const affected = Number(result.affectedRows || 0);
    deleted += affected;
    if (affected < limit) break;
  }

  const [backlog] = await conn.query(countSql, [simulationId, cutoff]);
  return {
    deleted,
    remainingCandidates: Number(backlog[0]?.candidates || 0),
    budgetExhausted: retentionBudgetRemainingMs(simulationId) <= 0
  };
}

async function runSafeRetention(simulationId, simulationTime) {
  if (!POLICY.enabled || !simulationId || !simulationTime) return { skipped: true, reason: "disabled" };
  const mysqlSimulationTime = normalizeSimulationTimestamp(simulationTime);
  const lock = await acquireLock(simulationId);
  if (!lock) return { skipped: true, reason: "lock_busy" };
  const previousState = adaptiveStateBySimulation.get(simulationId) || await loadRetentionTelemetryState(simulationId);
  const adaptiveProfile = getAdaptiveRetentionProfile(previousState?.overloadStreak || 0);
  retentionDeadlineAt.set(simulationId, Date.now() + adaptiveProfile.timeBudgetMs);
  try {
    // Prioritize continuous histories and simulation tick cleanup first. Their producers are continuous,
    // so leaving them to the end of the cycle lets slower cognitive cleanup consume
    // the whole retention budget and the backlog never catches up.
    const needs = await deleteOldNeedHistory(lock.conn, simulationId, mysqlSimulationTime);
    const emotions = await deleteOldEmotionHistory(lock.conn, simulationId, mysqlSimulationTime);
    const simulationTicks = await deleteOldSimulationTicks(lock.conn, simulationId, mysqlSimulationTime);
    const events = await withEventWriteLock(
      simulationId,
      conn => deleteOldEvents(conn, simulationId, mysqlSimulationTime),
      lock.conn
    );
    const actionSummaries = await compactOldActionDecisionSummaries(lock.conn, simulationId, mysqlSimulationTime);
    const planStepCompaction = await compactOldPlanStepResults(lock.conn, simulationId, mysqlSimulationTime);
    const actions = await deleteOldActions(lock.conn, simulationId, mysqlSimulationTime);
    const intentions = await deleteOldIntentions(lock.conn, simulationId, mysqlSimulationTime);
    const relationshipHistory = await deleteOldRelationshipHistory(lock.conn, simulationId, mysqlSimulationTime);
    const cognitiveStates = await compactOldCognitiveStates(lock.conn, simulationId, mysqlSimulationTime);
    const societyWealth = await compactOldEmergentWealthHistory(lock.conn, simulationId, mysqlSimulationTime);
    const societyTrades = await aggregateAndDeleteOldEmergentTrades(lock.conn, simulationId, mysqlSimulationTime);
    const societyProduction = await aggregateAndDeleteOldEmergentProduction(lock.conn, simulationId, mysqlSimulationTime);
    const snapshots = await compactOldSnapshots(lock.conn, simulationId, mysqlSimulationTime);
    const context = await compactOldDecisionContexts(lock.conn, simulationId, mysqlSimulationTime);
    const contextArchive = await deleteOldDecisionContextArchives(lock.conn, simulationId, mysqlSimulationTime);
    const compactedActionSummaries = await compactExistingDecisionActionSummaries(lock.conn, simulationId, mysqlSimulationTime);
    const counterfactualBaselineDedupe = await deduplicateCounterfactualWorldBaselines(lock.conn, simulationId, mysqlSimulationTime);
    const options = await deleteUnselectedDecisionOptions(lock.conn, simulationId, mysqlSimulationTime);
    const decisionOptions = await deleteOldDecisionOptions(lock.conn, simulationId, mysqlSimulationTime);
    const memoryDedupeBackfilled = await backfillMemoryDedupeKeys(lock.conn, simulationId);
    const episodicMemoryCap = await archiveExcessEpisodicMemories(lock.conn, simulationId, mysqlSimulationTime);
    const duplicateMemories = await compactDuplicateMemories(lock.conn, simulationId, mysqlSimulationTime);
    const memoryArchive = await archiveStaleMemories(lock.conn, simulationId, mysqlSimulationTime);
    const memories = await deleteOldMemories(lock.conn, simulationId, mysqlSimulationTime);
    const expectations = await deleteResolvedExpectations(lock.conn, simulationId, mysqlSimulationTime);
    const cognitiveActorCaps = await deleteActorCognitiveArtifacts(lock.conn, simulationId, mysqlSimulationTime);
    const counterfactuals = await deleteResolvedCounterfactuals(lock.conn, simulationId, mysqlSimulationTime);
    const worlds = await deleteResolvedCounterfactualWorlds(lock.conn, simulationId, mysqlSimulationTime);
    const traitHistory = await deleteOldTraitHistory(lock.conn, simulationId, mysqlSimulationTime);
    const geminiDecisionTelemetry = await deleteOldGeminiDecisionTelemetry(lock.conn, simulationId, mysqlSimulationTime);
    const decisions = await deleteOldDecisions(lock.conn, simulationId, mysqlSimulationTime);
    observability.increment(simulationId,"memory_archived_total",Number(memoryArchive.archived||0)+Number(episodicMemoryCap.archived||0));
    observability.increment(simulationId,"memory_deduplicated_total",Number(duplicateMemories.deleted||0));
    await recordMemoryStatusDistribution(simulationId);
    const summary = {
      simulationId,
      simulationTime,
      dryRun: POLICY.dryRun,
      decisionContextsCompacted: Number(context.updated || 0),
      decisionContextsArchived: Number(context.archived || 0),
      decisionContextArchivesDeleted: Number(contextArchive.deleted || 0),
      decisionOptionsDeleted: Number(options.deleted || 0) + Number(decisionOptions.deleted || 0),
      eventsDeleted: Number(events.deleted || 0),
      actionDecisionSummariesUpdated: Number(actionSummaries.updated || 0),
      actionDecisionSummaryCandidates: Number(actionSummaries.candidates || 0),
      actionDecisionSummaryBacklog: Number(actionSummaries.remainingCandidates || 0),
      planStepResultsCompacted: Number(planStepCompaction.updated || 0),
      planStepResultCandidates: Number(planStepCompaction.candidates || 0),
      planStepResultBacklog: Number(planStepCompaction.remainingCandidates || 0),
      actionSummariesCompacted: Number(compactedActionSummaries.updated || 0),
      counterfactualBaselineDuplicatesRemoved: Number(counterfactualBaselineDedupe.updated || 0),
      actionsDeleted: Number(actions.deleted || 0),
      needHistoryDeleted: Number(needs.deleted || 0),
      emotionHistoryDeleted: Number(emotions.deleted || 0),
      simulationTicksDeleted: Number(simulationTicks.deleted || 0),
      simulationTickEventsDetached: Number(simulationTicks.eventsDetached || 0),
      cognitiveStatesCompacted: Number(cognitiveStates.deleted || 0),
      societyWealthCompacted: Number(societyWealth.deleted || 0),
      societyTradesDeleted: Number(societyTrades.deleted || 0),
      societyProductionDeleted: Number(societyProduction.deleted || 0),
      snapshotsCompacted: Number(snapshots.deleted || 0),
      memoriesDeduped: Number(duplicateMemories.deleted || 0),
      episodicMemoryCapArchived: Number(episodicMemoryCap.archived || 0),
      cognitiveExpectationsCapped: Number(cognitiveActorCaps.expectations || 0),
      counterfactualsCapped: Number(cognitiveActorCaps.counterfactuals || 0),
      counterfactualWorldsCapped: Number(cognitiveActorCaps.counterfactualWorlds || 0),
      relationshipHistoryDeleted: Number(relationshipHistory.deleted || 0),
      intentionsDeleted: Number(intentions.deleted || 0),
      traitHistoryDeleted: Number(traitHistory.deleted || 0),
      geminiDecisionTelemetryDeleted: Number(geminiDecisionTelemetry.deleted || 0),
      decisionsDeleted: Number(decisions.deleted || 0),
      memoryDedupeBackfilled: Number(memoryDedupeBackfilled || 0),
      memoriesArchived: Number(memoryArchive.archived || 0),
      memoriesDeleted: Number(memories.deleted || 0),
      expectationsDeleted: Number(expectations.deleted || 0),
      counterfactualsDeleted: Number(counterfactuals.deleted || 0),
      counterfactualWorldsDeleted: Number(worlds.deleted || 0),
      decisionContextCandidates: Number(context.candidates || 0),
      decisionOptionCandidates: Number(options.candidates || 0) + Number(decisionOptions.candidates || 0),
      decisionContextArchiveCandidates: Number(contextArchive.candidates || 0),
      decisionContextArchiveBacklog: Number(contextArchive.remainingCandidates || 0),
      eventCandidates: Number(events.candidates || 0),
      actionCandidates: Number(actions.candidates || 0),
      needHistoryCandidates: Number(needs.candidates || 0),
      emotionHistoryCandidates: Number(emotions.candidates || 0),
      simulationTickCandidates: Number(simulationTicks.candidates || 0),
      memoryArchiveCandidates: Number(memoryArchive.candidates || 0),
      memoryDeleteCandidates: Number(memories.candidates || 0),
      expectationCandidates: Number(expectations.candidates || 0),
      counterfactualCandidates: Number(counterfactuals.candidates || 0),
      counterfactualWorldCandidates: Number(worlds.candidates || 0),
      needHistoryBacklog: Number(needs.remainingCandidates || 0),
      emotionHistoryBacklog: Number(emotions.remainingCandidates || 0),
      simulationTickBacklog: Number(simulationTicks.remainingCandidates || 0),
      eventBacklog: Number(events.remainingCandidates || 0),
      actionBacklog: Number(actions.remainingCandidates || 0),
      memoryArchiveBacklog: Number(memoryArchive.remainingCandidates || 0),
      memoryDedupeBacklog: Number(duplicateMemories.remainingCandidates || 0),
      memoryDeleteBacklog: Number(memories.remainingCandidates || 0),
      relationshipHistoryBacklog: Number(relationshipHistory.remainingCandidates || 0),
      expectationBacklog: Number(expectations.remainingCandidates || 0),
      counterfactualBacklog: Number(counterfactuals.remainingCandidates || 0),
      counterfactualWorldBacklog: Number(worlds.remainingCandidates || 0),
      retentionBacklogTotal: retentionBacklogTotalFromSummary({
        needHistoryBacklog:Number(needs.remainingCandidates||0),
        emotionHistoryBacklog:Number(emotions.remainingCandidates||0),
        simulationTickBacklog:Number(simulationTicks.remainingCandidates||0),
        eventBacklog:Number(events.remainingCandidates||0),
        actionBacklog:Number(actions.remainingCandidates||0),
        actionDecisionSummaryBacklog:Number(actionSummaries.remainingCandidates||0),
        planStepResultBacklog:Number(planStepCompaction.remainingCandidates||0),
        memoryArchiveBacklog:Number(memoryArchive.remainingCandidates||0),
        memoryDedupeBacklog:Number(duplicateMemories.remainingCandidates||0),
        memoryDeleteBacklog:Number(memories.remainingCandidates||0),
        relationshipHistoryBacklog:Number(relationshipHistory.remainingCandidates||0),
        expectationBacklog:Number(expectations.remainingCandidates||0),
        counterfactualBacklog:Number(counterfactuals.remainingCandidates||0),
        counterfactualWorldBacklog:Number(worlds.remainingCandidates||0),
        decisionContextArchiveBacklog:Number(contextArchive.remainingCandidates||0),
        intentionsDeleted:Number(intentions.remainingCandidates||0),
        decisionOptionCandidates:Number(options.remainingCandidates||0)+Number(decisionOptions.remainingCandidates||0),
        traitHistoryCandidates:Number(traitHistory.remainingCandidates||0),
        geminiDecisionTelemetryCandidates:Number(geminiDecisionTelemetry.remainingCandidates||0),
        decisions:Number(decisions.remainingCandidates||0)
      }),
      retentionBudgetMs: adaptiveProfile.timeBudgetMs,
      retentionBudgetRemainingMs: retentionBudgetRemainingMs(simulationId),
      adaptiveRetentionLevel: adaptiveProfile.level,
      adaptiveSimulationIntervalHours: adaptiveProfile.simulationIntervalHours
    };
    const resolvedRows =
      Number(needs.deleted || 0) +
      Number(emotions.deleted || 0) +
      Number(simulationTicks.deleted || 0) +
      Number(events.deleted || 0) +
      Number(actionSummaries.updated || 0) +
      Number(planStepCompaction.updated || 0) +
      Number(compactedActionSummaries.updated || 0) +
      Number(counterfactualBaselineDedupe.updated || 0) +
      Number(actions.deleted || 0) +
      Number(relationshipHistory.deleted || 0) +
      Number(memoryArchive.archived || 0) +
      Number(duplicateMemories.deleted || 0) +
      Number(memories.deleted || 0) +
      Number(expectations.deleted || 0) +
      Number(counterfactuals.deleted || 0) +
      Number(worlds.deleted || 0) +
      Number(contextArchive.deleted || 0);
    const retentionTelemetry = await persistRetentionTelemetry(
      lock.conn,
      simulationId,
      simulationTime,
      summary,
      resolvedRows,
      previousState,
      adaptiveProfile
    );
    Object.assign(summary, {
      retentionBacklogBefore: retentionTelemetry.backlogBefore,
      retentionProducedRows: retentionTelemetry.producedRows,
      retentionDeletedRows: retentionTelemetry.deletedRows,
      retentionProducedRowsPerSimDay: retentionTelemetry.producedRowsPerSimDay,
      retentionDeletedRowsPerSimDay: retentionTelemetry.deletedRowsPerSimDay,
      retentionDebt: retentionTelemetry.retentionDebt,
      retentionDebtAgeHours: retentionTelemetry.retentionDebtAgeHours,
      oldestRetentionDebtSimulationAt: retentionTelemetry.oldestRetentionDebtSimulationAt,
      retentionOverloadStreak: retentionTelemetry.overloadStreak
    });
    adaptiveStateBySimulation.set(simulationId, {
      overloadStreak: retentionTelemetry.overloadStreak,
      simulationMs: simulationTimestampMs(simulationTime),
      backlogAfter: summary.retentionBacklogTotal
    });
    observability.recordRetentionSummary(simulationId,summary);
    if (summary.retentionBacklogTotal > 0) {
      logger.warnThrottled(
        `retention:backlog:${simulationId}`,
        1800000,
        {
          simulationId,
          simulationTime,
          event:"RETENTION_BACKLOG",
          backlogRows:summary.retentionBacklogTotal,
          needHistoryBacklog:summary.needHistoryBacklog,
          emotionHistoryBacklog:summary.emotionHistoryBacklog,
          simulationTickBacklog:summary.simulationTickBacklog,
          relationshipHistoryBacklog:summary.relationshipHistoryBacklog,
          actionBacklog:summary.actionBacklog,
          actionDecisionSummaryBacklog:summary.actionDecisionSummaryBacklog,
          retentionDebt:summary.retentionDebt,
          retentionDebtAgeHours:summary.retentionDebtAgeHours,
          retentionProducedRowsPerSimDay:summary.retentionProducedRowsPerSimDay,
          retentionDeletedRowsPerSimDay:summary.retentionDeletedRowsPerSimDay,
          retentionOverloadStreak:summary.retentionOverloadStreak,
          retentionBudgetMs:summary.retentionBudgetMs
        },
        "retention backlog remains after bounded cleanup"
      );
    }
    if (
      summary.decisionContextsCompacted ||
      summary.decisionOptionsDeleted ||
      summary.eventsDeleted ||
      summary.actionDecisionSummariesUpdated ||
      summary.actionsDeleted ||
      summary.needHistoryDeleted ||
      summary.emotionHistoryDeleted ||
      summary.simulationTicksDeleted ||
      summary.memoriesArchived ||
      summary.memoriesDeleted ||
      summary.episodicMemoryCapArchived ||
      summary.cognitiveExpectationsCapped ||
      summary.counterfactualsCapped ||
      summary.counterfactualWorldsCapped ||
      summary.relationshipHistoryDeleted ||
      summary.expectationsDeleted ||
      summary.counterfactualsDeleted ||
      summary.counterfactualWorldsDeleted ||
      summary.retentionBacklogTotal > 0 ||
      POLICY.dryRun
    ) {
      const changes = {};
      const changeFields = [
        ["contexts",summary.decisionContextsCompacted],
        ["options",summary.decisionOptionsDeleted],
        ["events",summary.eventsDeleted],
        ["actionSummaries",summary.actionDecisionSummariesUpdated],
        ["planStepResultsCompacted",summary.planStepResultsCompacted],
        ["actionSummariesCompacted",summary.actionSummariesCompacted],
        ["counterfactualBaselineDuplicatesRemoved",summary.counterfactualBaselineDuplicatesRemoved],
        ["actions",summary.actionsDeleted],
        ["needHistory",summary.needHistoryDeleted],
        ["emotionHistory",summary.emotionHistoryDeleted],
        ["simulationTicks",summary.simulationTicksDeleted],
        ["simulationTickEventsDetached",summary.simulationTickEventsDetached],
        ["memoryDedupe",summary.memoriesDeduped],
        ["memoryCapArchived",summary.episodicMemoryCapArchived],
        ["expectationCaps",summary.cognitiveExpectationsCapped],
        ["counterfactualCaps",summary.counterfactualsCapped],
        ["counterfactualWorldCaps",summary.counterfactualWorldsCapped],
        ["relationshipHistory",summary.relationshipHistoryDeleted],
        ["intentions",summary.intentionsDeleted],
        ["traitHistory",summary.traitHistoryDeleted],
        ["geminiDecisionTelemetry",summary.geminiDecisionTelemetryDeleted],
        ["decisions",summary.decisionsDeleted],
        ["dedupeBackfilled",summary.memoryDedupeBackfilled],
        ["memoriesArchived",summary.memoriesArchived],
        ["memoriesDeleted",summary.memoriesDeleted],
        ["expectationsDeleted",summary.expectationsDeleted],
        ["counterfactualsDeleted",summary.counterfactualsDeleted],
        ["counterfactualWorldsDeleted",summary.counterfactualWorldsDeleted]
      ];
      for (const [key,value] of changeFields) {
        if (Number(value) > 0) changes[key]=Number(value);
      }
      logger.debug({
        simulationId,
        simulationTime,
        changes,
        backlogRows:summary.retentionBacklogTotal,
        budgetMs:summary.retentionBudgetMs,
        budgetRemainingMs:summary.retentionBudgetRemainingMs
      },"retention cycle");
      logger.debug(summary,"retention cycle detail");
    }
    return summary;
  } finally {
    retentionDeadlineAt.delete(simulationId);
    await releaseLock(lock);
  }
}

async function maybeRunSafeRetention(simulationId, simulationTime, options = {}) {
  if (!POLICY.enabled || !simulationId || !simulationTime) return { skipped: true, reason: "disabled" };
  const force = Boolean(options?.force);
  const now = Date.now();
  const lastWall = lastRunAt.get(simulationId);
  if (lastWall !== undefined && now - lastWall < Math.min(POLICY.intervalMs, 5000)) return { skipped: true, reason: "wall_interval" };
  if (running.has(simulationId)) return { skipped: true, reason: "running" };
  const simulationMs = simulationTimestampMs(simulationTime);
  const lastSimulationMs = lastRunSimulationAt.get(simulationId);
  const overloadStreak = adaptiveStateBySimulation.get(simulationId)?.overloadStreak || 0;
  const adaptiveProfile = getAdaptiveRetentionProfile(overloadStreak);
  if (!force && Number.isFinite(simulationMs) && lastSimulationMs !== undefined && simulationMs - lastSimulationMs < adaptiveProfile.simulationIntervalHours * 3600000) {
    return { skipped: true, reason: "simulation_interval" };
  }
  running.add(simulationId);
  try {
    const result=await runSafeRetention(simulationId, simulationTime);
    if(!result?.skipped){
      lastRunAt.set(simulationId, now);
      if(Number.isFinite(simulationMs)) lastRunSimulationAt.set(simulationId, simulationMs);
    }
    return result;
  } catch (err) {
    // Do not retry a failed retention cycle on every engine tick. That can
    // turn one schema/data issue into a continuous error storm.
    lastRunAt.set(simulationId, now);
    if (Number.isFinite(simulationMs)) lastRunSimulationAt.set(simulationId, simulationMs);
    logger.error({ simulationId, simulationTime, err }, "safe retention cycle failed");
    return { skipped: true, reason: "error" };
  } finally {
    running.delete(simulationId);
  }
}

function getRetentionPolicy() {
  return {
    ...POLICY,
    terminalDecisionStatuses: [...TERMINAL_DECISION_STATUSES],
    terminalActionStatuses: [...TERMINAL_ACTION_STATUSES]
  };
}

module.exports = {
  archiveExcessEpisodicMemories,
  deleteActorCognitiveArtifacts,
  compactOldCognitiveStates,
  compactOldEmergentWealthHistory,
  aggregateAndDeleteOldEmergentTrades,
  aggregateAndDeleteOldEmergentProduction,
  compactOldSnapshots,
  deleteOldRelationshipHistory,
  getRetentionPolicy,
  isTerminalDecisionStatus,
  isTerminalActionStatus,
  runSafeRetention,
  maybeRunSafeRetention,
  getAdaptiveRetentionProfile,
  ensureRetentionTelemetryTable,
  getOldestRetentionDebtAt,
  normalizeArchiveJson,
  positiveInt,
  boundedNumber,
  retentionBacklogTotalFromSummary
};
