const { pool, normalizeSimulationTimestamp } = require("../db/pool");
const observability = require("./simulation-observability");
const logger = require("../lib/logger");
const { withEventWriteLock } = require("./event-service");
function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return fallback;}}


const TERMINAL_DECISION_STATUSES = new Set(["EXECUTED", "FAILED", "CANCELLED"]);
const TERMINAL_ACTION_STATUSES = new Set(["COMPLETED", "CANCELLED", "INTERRUPTED", "FAILED"]);
const lastRunAt = new Map();
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
  decisionContextDays: positiveInt(process.env.RETENTION_DECISION_CONTEXT_DAYS, 2, 1),
  decisionOptionsDays: positiveInt(process.env.RETENTION_DECISION_OPTIONS_DAYS, 3, 2),
  cognitiveArtifactDays: positiveInt(process.env.RETENTION_COGNITIVE_ARTIFACT_DAYS, 30, 14),
  needHistoryDays: positiveInt(process.env.RETENTION_NEED_HISTORY_DAYS, 7, 1),
  emotionHistoryDays: positiveInt(process.env.RETENTION_EMOTION_HISTORY_DAYS, 7, 1),
  actionDays: positiveInt(process.env.RETENTION_ACTION_DAYS, 7, 1),
  eventDays: positiveInt(process.env.RETENTION_EVENT_DAYS, 7, 1),
  importantEventDays: positiveInt(process.env.RETENTION_IMPORTANT_EVENT_DAYS, 30, 7),
  memoryArchiveDays: positiveInt(process.env.RETENTION_MEMORY_ARCHIVE_DAYS, 30, 7),
  memoryDeleteDays: positiveInt(process.env.RETENTION_MEMORY_DELETE_DAYS, 7, 1),
  memoryArchiveImportanceMax: boundedNumber(process.env.RETENTION_MEMORY_ARCHIVE_IMPORTANCE_MAX, 0.75, 0, 1),
  memoryPermanentImportance: boundedNumber(process.env.RETENTION_MEMORY_PERMANENT_IMPORTANCE, 0.82, 0, 1),
  maxEpisodicMemoriesPerActor: Math.min(10000, positiveInt(process.env.RETENTION_MAX_EPISODIC_MEMORIES_PER_ACTOR, 1200, 100)),
  maxCognitiveExpectationsPerActor: Math.min(10000, positiveInt(process.env.RETENTION_MAX_COGNITIVE_EXPECTATIONS_PER_ACTOR, 1200, 100)),
  maxCounterfactualsPerActor: Math.min(20000, positiveInt(process.env.RETENTION_MAX_COUNTERFACTUALS_PER_ACTOR, 2500, 100)),
  maxCounterfactualWorldsPerActor: Math.min(20000, positiveInt(process.env.RETENTION_MAX_COUNTERFACTUAL_WORLDS_PER_ACTOR, 3000, 100)),
  relationshipHistoryDays: positiveInt(process.env.RETENTION_RELATIONSHIP_HISTORY_DAYS, 45, 7),
  eventImportanceKeepThreshold: boundedNumber(process.env.RETENTION_EVENT_IMPORTANCE_KEEP_THRESHOLD, 0.8, 0, 1),
  batchSize: Math.min(5000, positiveInt(process.env.RETENTION_BATCH_SIZE, 2000, 250)),
  maxDeletesPerTable: Math.min(20000, positiveInt(process.env.RETENTION_MAX_DELETES_PER_TABLE, 8000, 500)),
  timeBudgetMs: Math.min(30000, positiveInt(process.env.RETENTION_TIME_BUDGET_MS, 5000, 250)),
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
  resultKey
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
      "DELETE FROM " + deleteTable + " WHERE id IN (" + placeholders + ")",
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
    {table:"counterfactuals",max:POLICY.maxCounterfactualsPerActor,timeColumn:"created_simulation_at",where:"EXISTS (SELECT 1 FROM decisions d WHERE d.id=counterfactuals.decision_id AND d.status IN (\'EXECUTED\',\'FAILED\',\'CANCELLED\'))"},
    {table:"counterfactual_worlds",max:POLICY.maxCounterfactualWorldsPerActor,timeColumn:"created_simulation_at",where:"status='RESOLVED'"}
  ];
  const totals={expectations:0,counterfactuals:0,counterfactualWorlds:0};
  for(const target of targets){
    if(!retentionBudgetAvailable(simulationId))break;
    const [result]=await conn.query(
      "DELETE FROM "+target.table+" WHERE id IN (SELECT id FROM ("+
      "SELECT id,ROW_NUMBER() OVER(PARTITION BY entity_id ORDER BY "+target.timeColumn+" DESC) AS rn "+
      "FROM "+target.table+" WHERE simulation_id=UUID_TO_BIN(?) AND "+target.where+" AND "+target.timeColumn+">?"+
      ") ranked WHERE ranked.rn>? LIMIT "+POLICY.batchSize,
      [simulationId,cutoff,target.max]
    );
    const affected=Number(result.affectedRows||0);
    if(target.table==="cognitive_expectations")totals.expectations=affected;
    else if(target.table==="counterfactuals")totals.counterfactuals=affected;
    else totals.counterfactualWorlds=affected;
  }
  return totals;
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
    "UPDATE memories SET memory_dedupe_key=SHA2(CONCAT_WS('|',entity_id,COALESCE(location_id,''),LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType')),'')),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome')),''),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decision.goalId')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.goalId')),'')),COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.planId')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decision.planId')),'')),256) WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND memory_dedupe_key IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='action_outcome' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome'))='SUCCESS' AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType')),''))<>'talking' AND importance<=0.55 AND emotional_intensity<=0.30 LIMIT "+limit,
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
      "DELETE FROM memories WHERE id IN (SELECT id FROM (SELECT m.id,ROW_NUMBER() OVER(PARTITION BY m.memory_dedupe_key ORDER BY m.importance DESC,m.strength DESC,m.created_simulation_at DESC) AS rn FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?) AND m.status='ACTIVE' AND m.memory_dedupe_key IS NOT NULL AND m.created_simulation_at < ? AND m.importance<=0.55 AND m.emotional_intensity<=0.30) ranked WHERE ranked.rn>1 LIMIT "+limit+")",
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

async function deleteOldNeedHistory(conn, simulationId, simulationTime) {
  const cutoff=cutoffDateTime(simulationTime,POLICY.needHistoryDays);
  return deleteHistoryDirectBatch(conn,"entity_need_history",simulationId,cutoff,POLICY.maxDeletesPerTable);
}

async function deleteOldEmotionHistory(conn, simulationId, simulationTime) {
  const cutoff=cutoffDateTime(simulationTime,POLICY.emotionHistoryDays);
  return deleteHistoryDirectBatch(conn,"entity_emotion_history",simulationId,cutoff,POLICY.maxDeletesPerTable);
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
    const candidates=Number(rows[0]?.candidates || 0);
    return { candidates, updated: 0, remainingCandidates: candidates, dryRun: true };
  }
  let updated = 0;
  while (updated < maxUpdates && retentionBudgetAvailable(simulationId)) {
    const [rows] = await conn.query(selectSql, [simulationId, cutoff]);
    if (!rows.length) break;
    for (const row of rows) {
      if (!retentionBudgetAvailable(simulationId) || updated >= maxUpdates) break;
      const actionSummary = {
        schemaVersion: 1,
        actionId: row.actionId,
        decisionId: row.decisionId,
        actionType: row.actionType,
        sourceType: row.sourceType,
        status: row.status,
        startedSimulationAt: row.startedAt || null,
        completedSimulationAt: row.completedAt || null,
        target: parseJson(row.target, null),
        parameters: parseJson(row.parameters, null),
        result: parseJson(row.result, null)
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
    "AND simulation_time < ? " +
    "AND context IS NOT NULL " +
    "AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(context,'$.archived')),'false') <> 'true')";
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM decisions " +
      "WHERE simulation_id=UUID_TO_BIN(?) " +
      "AND status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND simulation_time < ? " +
      "AND context IS NOT NULL " +
      "AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(context,'$.archived')),'false') <> 'true')";
    const [rows] = await conn.query(countSql, [simulationId, cutoff]);
    return { candidates: Number(rows[0]?.candidates || 0), updated: 0, dryRun: true };
  }
  const [result] = await conn.query(sql, [simulationId, cutoff]);
  return { candidates: Number(result.affectedRows || 0), updated: Number(result.affectedRows || 0) };
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
    "AND d.simulation_time < ? " +
    "LIMIT " + limit;
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM decision_options dopt " +
      "JOIN decisions d ON d.id=dopt.decision_id " +
      "WHERE d.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.selected_option_id IS NOT NULL " +
      "AND dopt.id <> d.selected_option_id " +
      "AND d.simulation_time < ?";
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
  return { deleted };
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
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM cognitive_expectations ce " +
      "JOIN decisions d ON d.id=ce.decision_id " +
      "WHERE ce.simulation_id=UUID_TO_BIN(?) " +
      "AND ce.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ? " +
      "AND ce.resolved_simulation_at < ?";
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
  return { deleted };
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
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactuals cf " +
      "JOIN decisions d ON d.id=cf.decision_id " +
      "WHERE cf.simulation_id=UUID_TO_BIN(?) " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ?";
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
  return { deleted };
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
  if (POLICY.dryRun) {
    const countSql =
      "SELECT COUNT(*) AS candidates FROM counterfactual_worlds cw " +
      "JOIN decisions d ON d.id=cw.decision_id " +
      "WHERE cw.simulation_id=UUID_TO_BIN(?) " +
      "AND cw.status='RESOLVED' " +
      "AND d.status IN ('EXECUTED','FAILED','CANCELLED') " +
      "AND d.simulation_time < ? " +
      "AND cw.resolved_simulation_at < ?";
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
  return { deleted };
}

async function runSafeRetention(simulationId, simulationTime) {
  if (!POLICY.enabled || !simulationId || !simulationTime) return { skipped: true, reason: "disabled" };
  const mysqlSimulationTime = normalizeSimulationTimestamp(simulationTime);
  const lock = await acquireLock(simulationId);
  if (!lock) return { skipped: true, reason: "lock_busy" };
  retentionDeadlineAt.set(simulationId, Date.now() + POLICY.timeBudgetMs);
  try {
    const context = await compactOldDecisionContexts(lock.conn, simulationId, mysqlSimulationTime);
    const options = await deleteUnselectedDecisionOptions(lock.conn, simulationId, mysqlSimulationTime);
    // Events must be removed before actions because event_effects.target_action_id
    // deliberately uses ON DELETE RESTRICT.
    const events = await withEventWriteLock(
      simulationId,
      conn => deleteOldEvents(conn, simulationId, mysqlSimulationTime),
      lock.conn
    );
    const actionSummaries = await compactOldActionDecisionSummaries(lock.conn, simulationId, mysqlSimulationTime);
    const actions = await deleteOldActions(lock.conn, simulationId, mysqlSimulationTime);
    const memoryDedupeBackfilled = await backfillMemoryDedupeKeys(lock.conn, simulationId);
    const episodicMemoryCap = await archiveExcessEpisodicMemories(lock.conn, simulationId, mysqlSimulationTime);
    const duplicateMemories = await compactDuplicateMemories(lock.conn, simulationId, mysqlSimulationTime);
    const needs = await deleteOldNeedHistory(lock.conn, simulationId, mysqlSimulationTime);
    const emotions = await deleteOldEmotionHistory(lock.conn, simulationId, mysqlSimulationTime);
    const memoryArchive = await archiveStaleMemories(lock.conn, simulationId, mysqlSimulationTime);
    const memories = await deleteOldMemories(lock.conn, simulationId, mysqlSimulationTime);
    const expectations = await deleteResolvedExpectations(lock.conn, simulationId, mysqlSimulationTime);
    const cognitiveActorCaps = await deleteActorCognitiveArtifacts(lock.conn, simulationId, mysqlSimulationTime);
    const counterfactuals = await deleteResolvedCounterfactuals(lock.conn, simulationId, mysqlSimulationTime);
    const worlds = await deleteResolvedCounterfactualWorlds(lock.conn, simulationId, mysqlSimulationTime);
    const relationshipHistory = await deleteOldRelationshipHistory(lock.conn, simulationId, mysqlSimulationTime);
    const summary = {
      simulationId,
      simulationTime,
      dryRun: POLICY.dryRun,
      decisionContextsCompacted: Number(context.updated || 0),
      decisionOptionsDeleted: Number(options.deleted || 0),
      eventsDeleted: Number(events.deleted || 0),
      actionDecisionSummariesUpdated: Number(actionSummaries.updated || 0),
      actionDecisionSummaryCandidates: Number(actionSummaries.candidates || 0),
      actionDecisionSummaryBacklog: Number(actionSummaries.remainingCandidates || 0),
      actionsDeleted: Number(actions.deleted || 0),
      needHistoryDeleted: Number(needs.deleted || 0),
      emotionHistoryDeleted: Number(emotions.deleted || 0),
      memoriesDeduped: Number(duplicateMemories.deleted || 0),
      episodicMemoryCapArchived: Number(episodicMemoryCap.archived || 0),
      cognitiveExpectationsCapped: Number(cognitiveActorCaps.expectations || 0),
      counterfactualsCapped: Number(cognitiveActorCaps.counterfactuals || 0),
      counterfactualWorldsCapped: Number(cognitiveActorCaps.counterfactualWorlds || 0),
      relationshipHistoryDeleted: Number(relationshipHistory.deleted || 0),
      memoryDedupeBackfilled: Number(memoryDedupeBackfilled || 0),
      memoriesArchived: Number(memoryArchive.archived || 0),
      memoriesDeleted: Number(memories.deleted || 0),
      expectationsDeleted: Number(expectations.deleted || 0),
      counterfactualsDeleted: Number(counterfactuals.deleted || 0),
      counterfactualWorldsDeleted: Number(worlds.deleted || 0),
      decisionContextCandidates: Number(context.candidates || 0),
      decisionOptionCandidates: Number(options.candidates || 0),
      eventCandidates: Number(events.candidates || 0),
      actionCandidates: Number(actions.candidates || 0),
      needHistoryCandidates: Number(needs.candidates || 0),
      emotionHistoryCandidates: Number(emotions.candidates || 0),
      memoryArchiveCandidates: Number(memoryArchive.candidates || 0),
      memoryDeleteCandidates: Number(memories.candidates || 0),
      expectationCandidates: Number(expectations.candidates || 0),
      counterfactualCandidates: Number(counterfactuals.candidates || 0),
      counterfactualWorldCandidates: Number(worlds.candidates || 0),
      needHistoryBacklog: Number(needs.remainingCandidates || 0),
      emotionHistoryBacklog: Number(emotions.remainingCandidates || 0),
      eventBacklog: Number(events.remainingCandidates || 0),
      actionBacklog: Number(actions.remainingCandidates || 0),
      memoryArchiveBacklog: Number(memoryArchive.remainingCandidates || 0),
      memoryDedupeBacklog: Number(duplicateMemories.remainingCandidates || 0),
      memoryDeleteBacklog: Number(memories.remainingCandidates || 0),
      relationshipHistoryBacklog: Number(relationshipHistory.remainingCandidates || 0),
      expectationBacklog: Number(expectations.remainingCandidates || 0),
      counterfactualBacklog: Number(counterfactuals.remainingCandidates || 0),
      counterfactualWorldBacklog: Number(worlds.remainingCandidates || 0),
      retentionBacklogTotal:
        Number(needs.remainingCandidates || 0) +
        Number(emotions.remainingCandidates || 0) +
        Number(events.remainingCandidates || 0) +
        Number(actions.remainingCandidates || 0) +
        Number(actionSummaries.remainingCandidates || 0) +
        Number(memoryArchive.remainingCandidates || 0) +
        Number(duplicateMemories.remainingCandidates || 0) +
        Number(memories.remainingCandidates || 0) +
        Number(relationshipHistory.remainingCandidates || 0) +
        Number(expectations.remainingCandidates || 0) +
        Number(counterfactuals.remainingCandidates || 0) +
        Number(worlds.remainingCandidates || 0),
      retentionBudgetMs: POLICY.timeBudgetMs,
      retentionBudgetRemainingMs: retentionBudgetRemainingMs(simulationId)
    };
    observability.recordRetentionSummary(simulationId,summary);
    if (summary.retentionBacklogTotal > 0) {
      logger.warn({
        simulationId,
        simulationTime,
        event:"RETENTION_BACKLOG",
        backlogRows:summary.retentionBacklogTotal,
        needHistoryBacklog:summary.needHistoryBacklog,
        emotionHistoryBacklog:summary.emotionHistoryBacklog,
        relationshipHistoryBacklog:summary.relationshipHistoryBacklog,
        actionBacklog:summary.actionBacklog,
        actionDecisionSummaryBacklog:summary.actionDecisionSummaryBacklog,
        retentionBudgetMs:summary.retentionBudgetMs
      },"retention backlog remains after bounded cleanup");
    }
    if (
      summary.decisionContextsCompacted ||
      summary.decisionOptionsDeleted ||
      summary.eventsDeleted ||
      summary.actionDecisionSummariesUpdated ||
      summary.actionsDeleted ||
      summary.needHistoryDeleted ||
      summary.emotionHistoryDeleted ||
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
      logger.info(summary, "safe retention cycle completed");
    }
    return summary;
  } finally {
    retentionDeadlineAt.delete(simulationId);
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
  return {
    ...POLICY,
    terminalDecisionStatuses: [...TERMINAL_DECISION_STATUSES],
    terminalActionStatuses: [...TERMINAL_ACTION_STATUSES]
  };
}

module.exports = {
  archiveExcessEpisodicMemories,
  deleteActorCognitiveArtifacts,
  deleteOldRelationshipHistory,
  getRetentionPolicy,
  isTerminalDecisionStatus,
  isTerminalActionStatus,
  runSafeRetention,
  maybeRunSafeRetention
};
