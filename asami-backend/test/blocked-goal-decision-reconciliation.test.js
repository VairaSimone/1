const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const src=path.join(__dirname,"../src");
const read=name=>fs.readFileSync(path.join(src,name),"utf8");

test("blocked resource goal maintenance checks physical reachability before unblocking",()=>{
  const source=read("services/planning-service.js");
  const start=source.indexOf("async function revalidateBlockedResourceGoals");
  const end=source.indexOf("\nasync function abandonGoal",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/status='BLOCKED'/);
  assert.match(section,/RESOURCE_UNAVAILABLE/);
  assert.match(section,/retryWhenResourceAvailable/);
  assert.match(section,/isCriticalResourceReachable\(/);
  assert.match(section,/unblockBlockedGoal\(/);
});

test("blocked goal unblocking is exported for the maintenance pipeline",()=>{
  const source=read("services/planning-service.js");
  assert.match(source,/unblockBlockedGoal,revalidateBlockedResourceGoals/);
});

test("engine executes blocked resource goal revalidation during maintenance",()=>{
  const source=read("simulation/engine.js");
  const maintenance=source.indexOf("if (maintenanceDue)");
  const revalidation=source.indexOf("revalidateBlockedResourceGoals",maintenance);
  const actors=source.indexOf("findAutonomousActors",maintenance);
  assert.ok(maintenance>=0&&revalidation>maintenance&&actors>revalidation);
  assert.match(source.slice(maintenance,revalidation),/maintainDistributedResources/);
});

test("intentions have a direct nullable decision link with an idempotent migration and canonical action backfill",()=>{
  const migration=read("db/schema-migrations.js");
  const autonomy=read("services/autonomy-service.js");
  assert.match(migration,/INTENTION_DECISION_MIGRATION/);
  assert.match(migration,/ADD COLUMN decision_id BINARY\(16\) NULL/);
  assert.match(migration,/a\.source_intention_id=i\.id/);
  assert.match(migration,/SET i\.decision_id=a\.decision_id/);
  assert.match(migration,/fk_intentions_decision_same_simulation/);
  assert.doesNotMatch(migration,/ADD CONSTRAINT fk_intentions_decision\b/);
  assert.match(migration,/if \(Number\(columns\[0\]\?\.count \|\| 0\) === 0\)/);
  assert.match(autonomy,/decision_id/);
  assert.match(autonomy,/decision\.decisionId/);
});

test("actForEntity compensates a persisted decision when intention or action creation fails",()=>{
  const source=read("services/autonomy-service.js");
  const start=source.indexOf("async function markDecisionPipelineFailed");
  const actionStart=source.indexOf("async function actForEntity");
  const intentionStart=source.indexOf("async function ensureIntention");
  assert.ok(start>=0&&actionStart>start&&intentionStart>actionStart);
  const helper=source.slice(start,actionStart);
  const section=source.slice(actionStart,intentionStart);
  assert.match(helper,/DECISION_PIPELINE_INCOMPLETE/);
  assert.match(helper,/UPDATE decisions/);
  assert.match(helper,/status='FAILED'/);
  assert.match(helper,/UPDATE intentions/);
  assert.match(helper,/status='CANCELLED'/);
  assert.match(section,/let intentionId=null/);
  assert.match(section,/try\{/);
  assert.match(section,/ensureIntention\(/);
  assert.match(section,/startAction\(/);
  assert.match(section,/markDecisionPipelineFailed\(/);
  assert.match(section,/throw err/);
});

test("stale evaluated decisions use a simulated-time grace window and only fail without a live action",()=>{
  const source=read("services/action-reconciliation-service.js");
  const start=source.indexOf("async function reconcileStaleEvaluatedDecisions");
  const end=source.indexOf("\nasync function reconcileCompletedActions",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/d\.status='EVALUATED'/);
  assert.match(section,/const cutoff=new Date/);
  assert.match(section,/d\.simulation_time<=\?/);
  assert.match(section,/LEFT JOIN intentions/);
  assert.match(section,/i\.decision_id=d\.id/);
  assert.match(section,/LEFT JOIN actions/);
  assert.match(section,/a\.decision_id=d\.id/);
  assert.match(section,/\["ACTIVE","COMPLETED","INTERRUPTED"\]/);
  assert.match(section,/DECISION_PIPELINE_INCOMPLETE/);
  assert.match(section,/UPDATE intentions/);
  assert.match(section,/status='CANCELLED'/);
  assert.match(section,/UPDATE decisions/);
  assert.match(section,/status='FAILED'/);
});

test("engine executes stale decision reconciliation in the same maintenance phase as action reconciliation",()=>{
  const source=read("simulation/engine.js");
  const action=source.indexOf("reconcileCompletedActions");
  const stale=source.indexOf("reconcileStaleEvaluatedDecisions",action);
  const integrity=source.indexOf('setPhase("integrity.check")',stale);
  assert.ok(action>=0&&stale>action&&integrity>stale);
});

test("reconciler configuration has a bounded default grace window and batch size",()=>{
  const source=read("config/env.js");
  assert.match(source,/DECISION_RECONCILIATION_GRACE_MINUTES/);
  assert.match(source,/\.default\(5\)/);
  assert.match(source,/DECISION_RECONCILIATION_BATCH_SIZE/);
});
