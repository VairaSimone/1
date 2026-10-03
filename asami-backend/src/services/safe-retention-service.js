const { pool, normalizeSimulationTimestamp } = require("../db/pool");
const observability = require("./simulation-observability");
const logger = require("../lib/logger");
const { withEventWriteLock } = require("./event-service");
function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return fallback;}}


const TERMINAL_DECISION_STATUSES = new Set(["EXECUTED", "FAILED", "CANCELLED"]);
const TERMINAL_ACTION_STATUSES = new Set(["COMPLETED", "CANCELLED", "INTERRUPTED", "FAILED"]);
const lastRunAt = new Map();
const lastRunSimulationAt = new Map();
const running = new Set();
const retentionDeadlineAt = new Map();

function positiveInt(value, fallback, minimum) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(minimum, Math.floor(n)) : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(maximum, Math.max(minimum, n)) : fallback;
}

const POLICY = Object.freeze({
  enabled: !["0", "false", "no", "off"].includes(String(process.env.RETENTION_ENABLED || "true").trim().toLowerCase()),
  intervalMs: positiveInt(process.env.RETENTION_CHECK_INTERVAL_MS, 15 * 60 * 1000, 60 * 1000),
  simulationIntervalHours: positiveInt(process.env.RETENTION_CHECK_SIMULATION_HOURS, 1, 1),
  decisionContextDays: positiveInt(process.env.RETENTION_DECISION_CONTEXT_DAYS, 2, 1),
  decisionOptionsDays: positiveInt(process.env.RETENTION_DECISION_OPTIONS_DAYS, 3, 2),
  cognitiveArtifactDays: positiveInt(process.env.RETENTION_COGNITIVE_ARTIFACT_DAYS, 14, 7),
  needHistoryDays: positiveInt(process.env.RETENTION_NEED_HISTORY_DAYS, 3, 1),
  emotionHistoryDays: positiveInt(process.env.RETENTION_EMOTION_HISTORY_DAYS, 3, 1),
  actionDays: positiveInt(process.env.RETENTION_ACTION_DAYS, 7, 1),
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