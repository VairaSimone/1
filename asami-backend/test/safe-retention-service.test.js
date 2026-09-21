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
  assert.ok(policy.eventDays >= 1);
  assert.ok(policy.importantEventDays >= 7);
  assert.ok(policy.memoryArchiveDays >= 7);
  assert.ok(policy.memoryDeleteDays >= 1);
  assert.ok(policy.memoryArchiveImportanceMax >= 0 && policy.memoryArchiveImportanceMax <= 1);
  assert.ok(policy.eventImportanceKeepThreshold >= 0 && policy.eventImportanceKeepThreshold <= 1);
  assert.ok(policy.batchSize >= 50);
  assert.ok(policy.maxDeletesPerTable >= 100);
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
  assert.match(source,/simulationMs-lastSimulationMs/);
  assert.match(source,/RETENTION_CHECK_SIMULATION_HOURS/);
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
  assert.match(geminiSource,/logger\.debug\(\{kind,model:this\.model/);
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
  assert.match(source,/httpOptions:\{timeout:timeoutMs,retryOptions:\{attempts:1,initialDelay:0\}\}/);
  assert.match(source,/maxOutputTokens:outputTokenCeiling/);
  assert.doesNotMatch(source,/Promise\.race\(\[this\.client\.models\.generateContent/);
});

test("normal Gemini autonomy uses low reasoning and escalates only high-priority triggers",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
  assert.match(
    source,
    /const thinkingLevel=context\?\.geminiTrigger\?\.priority==="HIGH"\?"medium":"low"/
  );
  assert.match(source,/DecisionSchema,\{kind:"autonomy",thinkingLevel\}\)/);
});
