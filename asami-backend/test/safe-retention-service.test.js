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
    "deleteOldActions",
    "archiveStaleMemories",
    "deleteOldMemories"
  ]) {
    assert.match(source, new RegExp("function " + helper + "\\b"));
    assert.match(source, new RegExp(helper + "\\("));
  }

  assert.ok(
    source.indexOf("const events = await deleteOldEvents") <
    source.indexOf("const actions = await deleteOldActions")
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
  assert.match(block,/DELETE t FROM \+target\.table\+ t/);
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
