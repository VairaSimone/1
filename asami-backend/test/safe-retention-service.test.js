const test = require("node:test");
const assert = require("node:assert/strict");

const retention = require("../src/services/safe-retention-service");

test("retention policy protects against aggressive windows", () => {
  const policy = retention.getRetentionPolicy();
  assert.ok(policy.decisionContextDays >= 1);
  assert.ok(policy.decisionOptionsDays >= 2);
  assert.ok(policy.cognitiveArtifactDays >= 14);
  assert.ok(policy.needHistoryDays >= 1);
  assert.ok(policy.emotionHistoryDays >= 1);
  assert.ok(policy.actionDays >= 1);
  assert.ok(policy.simulationTickDays >= 1);
  assert.ok(policy.eventDays >= 1);
  assert.ok(policy.importantEventDays >= 7);
  assert.ok(policy.memoryArchiveDays >= 7);
  assert.ok(policy.memoryDeleteDays >= 1);
  assert.ok(policy.memoryArchiveImportanceMax >= 0 && policy.memoryArchiveImportanceMax <= 1);
  assert.ok(policy.eventImportanceKeepThreshold >= 0 && policy.eventImportanceKeepThreshold <= 1);
  assert.ok(policy.batchSize >= 50);
  assert.ok(policy.maxDeletesPerTable >= 100);
  assert.ok(policy.timeBudgetMs >= 250);
});

test("only terminal decisions are eligible for retention", () => {
  assert.equal(retention.isTerminalDecisionStatus("EXECUTED"), true);
  assert.equal(retention.isTerminalDecisionStatus("FAILED"), true);
  assert.equal(retention.isTerminalDecisionStatus("CANCELLED"), true);
  assert.equal(retention.isTerminalDecisionStatus("CREATED"), false);
  assert.equal(retention.isTerminalDecisionStatus("EVALUATED"), false);
  assert.equal(retention.isTerminalDecisionStatus(""), false);
});


test("retention exposes separate action terminal-state protection", () => {
  assert.equal(retention.isTerminalActionStatus("COMPLETED"), true);
  assert.equal(retention.isTerminalActionStatus("CANCELLED"), true);
  assert.equal(retention.isTerminalActionStatus("INTERRUPTED"), true);
  assert.equal(retention.isTerminalActionStatus("FAILED"), true);
  assert.equal(retention.isTerminalActionStatus("ACTIVE"), false);
  assert.equal(retention.isTerminalActionStatus("CREATED"), false);
});

test("retention wires all high-growth tables and deletes events before actions", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/safe-retention-service.js"),
    "utf8"
  );

  for (const helper of [
    "deleteOldNeedHistory",
    "deleteOldEmotionHistory",
    "deleteOldSimulationTicks",
    "deleteOldEvents",
    "compactOldActionDecisionSummaries",
    "deleteOldActions",
    "archiveStaleMemories",
    "deleteOldMemories"
  ]) {
    assert.match(source, new RegExp("function " + helper + "\\b"));
    assert.match(source, new RegExp(helper + "\\("));
  }

  assert.ok(
    source.indexOf("deleteOldEvents(conn, simulationId, mysqlSimulationTime)") <
    source.indexOf("compactOldActionDecisionSummaries(lock.conn, simulationId, mysqlSimulationTime)")
  );
  assert.ok(
    source.indexOf("compactOldActionDecisionSummaries(lock.conn, simulationId, mysqlSimulationTime)") <
    source.indexOf("deleteOldActions(lock.conn, simulationId, mysqlSimulationTime)")
  );
  assert.match(
    source,
    /JSON_UNQUOTE\(JSON_EXTRACT\(m\.metadata,'\$\.kind'\)\).*resource_failure/
  );
});

test("retention uses direct set-based deletion for high-growth history",()=>{
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function deleteHistoryDirectBatch/);
  assert.match(source,/DELETE FROM "\+table\+" WHERE id IN/);
  assert.match(source,/memory_dedupe_key/);
  assert.match(source,/compactDuplicateMemories/);
});

test("retention exposes actor caps and differentiated history policy",()=>{
  const policy=retention.getRetentionPolicy();
  assert.ok(policy.needHistoryDays<=3);
  assert.ok(policy.emotionHistoryDays<=3);
  assert.ok(policy.cognitiveArtifactDays<=14);
  assert.ok(policy.maxEpisodicMemoriesPerActor>=100);
  assert.ok(policy.maxCognitiveExpectationsPerActor>=100);
  assert.ok(policy.maxCounterfactualsPerActor>=100);
  assert.ok(policy.maxCounterfactualWorldsPerActor>=100);
  assert.ok(policy.relationshipHistoryDays>=7);
  assert.ok(policy.memoryPermanentImportance>=0.75);
  assert.equal(policy.memoryArchiveImportanceMax,policy.memoryPermanentImportance);
});

test("retention contains actor-level caps and preserves open counterfactuals",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function archiveExcessEpisodicMemories/);
  assert.match(source,/async function deleteActorCognitiveArtifacts/);
  assert.match(source,/status='RESOLVED'/);
  assert.match(source,/EXISTS \(SELECT 1 FROM decisions d/);
  assert.match(source,/RETENTION_MAX_EPISODIC_MEMORIES_PER_ACTOR/);
});

test("memory dedupe backfill uses valid MySQL SHA2 syntax",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/SHA2\(CONCAT_WS\([^;]+,256\)/);
  assert.match(source,/SHA2\(/);
});

test("duplicate memory cleanup avoids MySQL LIMIT inside IN subquery",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/DELETE m FROM memories m JOIN \(SELECT id FROM \(SELECT m2\.id/);
  assert.doesNotMatch(source,/WHERE id IN \(SELECT id FROM \(SELECT m\.id/);
});

test("actor cognitive cap uses joined DELETE instead of LIMIT in IN subquery",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function deleteActorCognitiveArtifacts");
  const end=source.indexOf("\nasync function deleteOldRelationshipHistory",start);
  const block=source.slice(start,end);
  assert.match(block,/DELETE t FROM "\+target\.table\+" t/);
  assert.match(block,/JOIN \(SELECT id FROM/);
  assert.doesNotMatch(block,/WHERE id IN \(SELECT id FROM \(SELECT id/);
});

test("decision context archive is bounded separately from the operational decision row",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const policy=retention.getRetentionPolicy();
  assert.ok(policy.decisionContextArchiveDays>=2);
  assert.match(source,/async function compactOldDecisionContexts/);
  assert.match(source,/decision_context_archive/);
  assert.match(source,/async function deleteOldDecisionContextArchives/);
  assert.match(source,/decisionContextArchivesDeleted/);
  assert.ok(source.includes("JSON_EXTRACT(d.context,'$.operational')"));
  assert.match(source,/BIN_TO_UUID\(d\.entity_id\) AS entityId/);
});

test("retention services continuous histories before slower cognitive cleanup",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const run=source.slice(source.indexOf("async function runSafeRetention"),source.indexOf("async function maybeRunSafeRetention"));
  assert.ok(run.indexOf("const needs = await deleteOldNeedHistory")<run.indexOf("const context = await compactOldDecisionContexts"));
  assert.ok(run.indexOf("const emotions = await deleteOldEmotionHistory")<run.indexOf("const context = await compactOldDecisionContexts"));
});

test("retention scheduling is based on simulation time during accelerated runs",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/simulationIntervalHours/);
  assert.match(source,/simulationTimestampMs\(simulationTime\)/);
  assert.match(source,/simulationMs - lastSimulationMs/);
  assert.match(source,/RETENTION_CHECK_SIMULATION_HOURS/);
  assert.match(source,/adaptiveProfile\.simulationIntervalHours/);
});

test("retention keeps dedicated need and emotion history workers wired",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function deleteOldNeedHistory/);
  assert.match(source,/async function deleteOldEmotionHistory/);
  assert.match(source,/deleteHistoryDirectBatch\(conn,"entity_need_history"/);
  assert.match(source,/deleteHistoryDirectBatch\(conn,"entity_emotion_history"/);
});


test("normal observability logs are compact while full metrics stay at debug",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/simulation-observability.js"),"utf8");
  const observability=require("../src/services/simulation-observability");
  const compact=observability.compactSnapshot({
    counters:{
      db_queries_total:123,
      db_query_latency_ms_total:456,
      db_slow_queries_total:2,
      integrity_violation_total:1
    },
    gauges:{
      db_queries_current_tick:9,
      db_query_latency_ms_last:4,
      db_query_latency_ms_max:80,
      retention_backlog_rows:0,
      action_backlog_rows:0,
      action_decision_summary_backlog_rows:0,
      event_backlog_rows:0,
      need_history_backlog_rows:0,
      emotion_history_backlog_rows:0
    }
  });
  assert.equal(compact.dbQueries,123);
  assert.equal(compact.dbQueryMs,456);
  assert.equal(compact.tickQueries,9);
  assert.equal(compact.alerts.integrityViolations,1);
  assert.equal(Object.prototype.hasOwnProperty.call(compact,"counters"),false);
  assert.match(source,/metrics:compactSnapshot\(metrics\)/);
  assert.match(source,/"simulation observability detail"/);
});

test("retention info logs emit only changes and summary gauges",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/const changes = \{\};/);
  assert.match(source,/backlogRows:summary\.retentionBacklogTotal/);
  assert.match(source,/logger\.debug\(summary,"retention cycle detail"\)/);
  assert.doesNotMatch(source,/logger\.info\(summary,"safe retention cycle completed"\)/);
});

test("startup and successful-provider noise are suppressed at info level",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const envSource=fs.readFileSync(path.join(__dirname,"../src/config/env.js"),"utf8");
  const geminiSource=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
  assert.match(envSource,/dotenv"\)\.config\(\{ quiet: true \}\)/);
  assert.match(geminiSource,/logger\.debug\(\{kind,retryAfterMs/);
  assert.doesNotMatch(geminiSource,/logger\.info\(\{kind,model:this\.model/);
});


test("bounded retention workers expose remaining candidate backlogs",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  for(const [start,end] of [
    ["async function deleteUnselectedDecisionOptions","async function deleteResolvedExpectations"],
    ["async function deleteResolvedExpectations","async function deleteResolvedCounterfactuals"],
    ["async function deleteResolvedCounterfactuals","async function deleteResolvedCounterfactualWorlds"],
    ["async function deleteResolvedCounterfactualWorlds","async function deleteOldEvents"]
  ]) {
    const block=source.slice(source.indexOf(start),source.indexOf(end));
    assert.match(block,/const \[backlog\] = await conn\.query\(countSql/);
    assert.match(block,/remainingCandidates/);
  }
});


test("Gemini requests use bounded generation and no hidden SDK retries",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
  assert.match(source,/new AbortController\(\)/);
  assert.match(source,/abortSignal:controller\.signal/);
  assert.match(source,/httpOptions:\{/);
  assert.match(source,/timeout:timeoutMs/);
  assert.match(source,/retryOptions:\{attempts:1,initialDelay:0\}/);
  assert.match(source,/maxOutputTokens:outputTokenCeiling/);
  assert.doesNotMatch(source,/Promise\.race\(\[this\.client\.models\.generateContent/);
});

test("normal Gemini autonomy uses low reasoning and escalates only high-priority triggers",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
  assert.match(
    source,
    /const thinkingLevel=advanced\s*\n\s*\?\(context\?\.geminiTrigger\?\.priority==="HIGH"\?"medium":"low"\)\s*\n\s*:"low";/
  );
  assert.match(source,/return this\.generateJson\(prompt,schema,\{[\s\S]*kind:"autonomy"[\s\S]*thinkingLevel/);
});

test("retention escalates worker capacity after sustained debt",()=>{
  const base=retention.getAdaptiveRetentionProfile(0);
  const level1=retention.getAdaptiveRetentionProfile(3);
  const level2=retention.getAdaptiveRetentionProfile(6);
  const level3=retention.getAdaptiveRetentionProfile(9);
  assert.equal(base.level,0);
  assert.ok(level1.timeBudgetMs>base.timeBudgetMs);
  assert.ok(level2.timeBudgetMs>=level1.timeBudgetMs);
  assert.ok(level3.timeBudgetMs>=level2.timeBudgetMs);
  assert.ok(level1.simulationIntervalHours<base.simulationIntervalHours);
  assert.ok(level2.simulationIntervalHours<=level1.simulationIntervalHours);
  assert.ok(level3.simulationIntervalHours<=level2.simulationIntervalHours);
  assert.ok(level3.timeBudgetMs<=30000);
  assert.ok(level3.simulationIntervalHours>=0.25);
});

test("retention records production rate, deletion rate, debt and overload history",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/CREATE TABLE IF NOT EXISTS retention_cycle_metrics/);
  assert.match(source,/produced_rows_per_sim_day/);
  assert.match(source,/deleted_rows_per_sim_day/);
  assert.match(source,/retention_debt_age_hours/);
  assert.match(source,/overload_streak/);
  assert.match(source,/persistRetentionTelemetry/);
  assert.match(source,/adaptiveRetentionLevel/);
  assert.match(source,/adaptiveProfile\.timeBudgetMs/);
});

test("retention prioritizes high-growth event/action cleanup before slower compaction",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const run=source.slice(source.indexOf("async function runSafeRetention"),source.indexOf("async function maybeRunSafeRetention"));
  assert.ok(run.indexOf("deleteOldSimulationTicks(lock.conn, simulationId, mysqlSimulationTime)")<run.indexOf("compactOldCognitiveStates(lock.conn, simulationId, mysqlSimulationTime)"));
  assert.ok(run.indexOf("deleteOldEvents(lock.conn, simulationId, mysqlSimulationTime)")<run.indexOf("compactOldCognitiveStates(lock.conn, simulationId, mysqlSimulationTime)"));
  assert.ok(run.indexOf("deleteOldActions(lock.conn, simulationId, mysqlSimulationTime)")<run.indexOf("compactOldCognitiveStates(lock.conn, simulationId, mysqlSimulationTime)"));
  assert.ok(run.indexOf("deleteOldRelationshipHistory(lock.conn, simulationId, mysqlSimulationTime)")<run.indexOf("compactOldCognitiveStates(lock.conn, simulationId, mysqlSimulationTime)"));
});

test("retention treats blank numeric environment values as unspecified",()=>{
  assert.equal(retention.positiveInt("",7500,250),7500);
  assert.equal(retention.boundedNumber("",0.82,0,1),0.82);
});

test("retention detaches event provenance before deleting old simulation ticks",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function deleteOldSimulationTicks");
  const end=source.indexOf("\nasync function deleteOldEvents",start);
  const helperBlock=source.slice(start,end);
  assert.match(helperBlock,/UPDATE events/);
  assert.match(helperBlock,/SET source_tick_id=NULL/);
  assert.match(helperBlock,/source_tick_id IN/);
  assert.match(helperBlock,/DELETE FROM simulation_ticks/);
  assert.match(helperBlock,/eventsDetached/);
});

test("retention bounds simulation tick history without deleting active ticks",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const policy=retention.getRetentionPolicy();
  assert.ok(policy.simulationTickDays>=1);
  assert.match(source,/async function deleteOldSimulationTicks/);
  const start=source.indexOf("async function deleteOldSimulationTicks");
  const end=source.indexOf("\nasync function deleteOldEvents",start);
  const helperBlock=source.slice(start,end);
  assert.ok(helperBlock.includes("status IN ('COMPLETED','FAILED','SKIPPED')"));
  assert.doesNotMatch(helperBlock,/status='RUNNING'/);
  assert.match(source,/RETENTION_SIMULATION_TICK_DAYS/);
});

test("decision context archival preserves invalid raw context and never overwrites an existing archive",()=>{
  const normalized=retention.normalizeArchiveJson("{invalid");
  assert.equal(normalized._invalidJson,true);
  assert.equal(normalized._rawContext,"{invalid");

  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/ON DUPLICATE KEY UPDATE decision_id=decision_id/);
  assert.match(source,/serializeArchiveJson\(archiveContext\)/);
  assert.match(source,/function serializeArchiveJson\(value\)/);
  assert.match(source,/BIN_TO_UUID\(d\.selected_option_id\) AS selectedOptionId/);
  assert.match(source,/UPDATE decisions SET context=\? WHERE id=UUID_TO_BIN\(\?\)/);
  assert.match(source,/JSON_VALID\(d\.context\)/);
});

test("retention has lifecycle cleanup for operational decision artifacts",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  for(const helper of [
    "deleteOldIntentions",
    "deleteOldDecisionOptions",
    "deleteOldTraitHistory",
    "deleteOldGeminiDecisionTelemetry",
    "deleteOldDecisions"
  ]) {
    assert.match(source,new RegExp("function " + helper + "\\b"));
  }
  assert.match(source,/RETENTION_DECISION_DAYS/);
  assert.match(source,/RETENTION_INTENTION_DAYS/);
  assert.match(source,/NOT EXISTS \(SELECT 1 FROM decision_options/);
  assert.match(source,/NOT EXISTS \(SELECT 1 FROM decision_context_archive/);
});


test("forced retention bypasses simulation-time interval checks for database pressure",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function maybeRunSafeRetention\(simulationId, simulationTime, options = \{\}\)/);
  assert.match(source,/const force = Boolean\(options\?\.force\)/);
  assert.match(source,/if \(!force && Number\.isFinite\(simulationMs\)/);
});

test("old plan-step and decision action-summary payloads are compacted safely",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function compactOldPlanStepResults/);
  assert.match(source,/compactPlanStepResult\(row\.result\)/);
  assert.match(source,/async function compactExistingDecisionActionSummaries/);
  assert.match(source,/compactDecisionActualOutcome\(row\.actualOutcome\)/);
});

test("counterfactual world baseline is deduplicated per decision",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/async function deduplicateCounterfactualWorldBaselines/);
  assert.match(source,/ROW_NUMBER\(\) OVER\(PARTITION BY decision_id ORDER BY selected DESC,id ASC\)/);
  assert.match(source,/while\(updated<Math\.min\(POLICY\.maxDeletesPerTable,POLICY\.batchSize\)/);
});


test("retention debt-age query binds binary simulation ids instead of embedding UUID functions around placeholders",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function getOldestRetentionDebtAt");
  const end=source.indexOf("\nasync function persistRetentionTelemetry",start);
  const block=source.slice(start,end);
  assert.match(source,/function uuidBinaryParam\(value\)/);
  assert.match(block,/const simulationIdBinary = uuidBinaryParam\(simulationId\)/);
  assert.doesNotMatch(block,/simulation_id=UUID_TO_BIN\(\?\)/);
  assert.match(block,/simulation_id=\?/);
});

test("retention debt-age query keeps SQL placeholders and bound parameters in sync",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function getOldestRetentionDebtAt");
  const end=source.indexOf("\nasync function persistRetentionTelemetry",start);
  const block=source.slice(start,end);
  const queryStart=block.indexOf('const [rows]=await conn.query(');
  const paramsStart=block.indexOf("simulationIdBinary,needCutoff",queryStart);
  const paramsEnd=block.indexOf("simulationIdBinary,decisionCutoff",paramsStart);
  assert.ok(queryStart>=0 && paramsStart>queryStart && paramsEnd>paramsStart);
  const querySource=block.slice(queryStart,paramsStart);
  const paramsSource=block.slice(paramsStart,paramsEnd)+"simulationIdBinary,decisionCutoff";
  const placeholderCount=(querySource.match(/\\?/g)||[]).length;
  const parameterCount=paramsSource.split(",").map(value=>value.trim()).filter(Boolean).length;
  assert.equal(placeholderCount,parameterCount);
  assert.equal(placeholderCount,48);
});

test("retention plan-step debt uses the plan timestamp because plan_steps has no creation timestamp",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function getOldestRetentionDebtAt");
  const end=source.indexOf("\nasync function persistRetentionTelemetry",start);
  const block=source.slice(start,end);
  assert.ok(block.includes("SELECT p.created_simulation_at FROM plan_steps ps JOIN plans p ON p.id=ps.plan_id"));
  assert.ok(!block.includes("SELECT ps.created_simulation_at FROM plan_steps ps"));
  const compactionStart=source.indexOf("async function compactOldPlanStepResults");
  const compactionEnd=source.indexOf("\nasync function compactExistingDecisionActionSummaries",compactionStart);
  const compaction=source.slice(compactionStart,compactionEnd);
  assert.ok(compaction.includes("p.created_simulation_at<?"));
  assert.ok(!compaction.includes("ps.created_simulation_at"));
});

test("retention decision-option debt uses the parent decision timestamp because decision_options has no creation timestamp",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const start=source.indexOf("async function getOldestRetentionDebtAt");
  const end=source.indexOf("\nasync function persistRetentionTelemetry",start);
  const block=source.slice(start,end);
  assert.ok(block.includes("SELECT d.simulation_time FROM decision_options dopt JOIN decisions d ON d.id=dopt.decision_id"));
  assert.ok(!block.includes("SELECT dopt.created_simulation_at FROM decision_options dopt"));
});
