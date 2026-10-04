const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const src=path.join(__dirname,"../src");
const read=name=>fs.readFileSync(path.join(src,name),"utf8");

test("planning maintenance revalidates only retryable resource-blocked goals",()=>{
  const source=read("services/planning-service.js");
  const start=source.indexOf("async function revalidateBlockedResourceGoals");
  const end=source.indexOf("\nasync function abandonGoal",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/status='BLOCKED'/);
  assert.match(section,/result/);
  assert.match(section,/reason!==\\"RESOURCE_UNAVAILABLE\\"/);
  assert.match(section,/!retry/);
  assert.match(section,/\[\\"food\\",\\"water\\"\]/);
  assert.match(section,/isCriticalResourceReachable\(/);
  assert.match(section,/unblockBlockedGoal\(/);
});

test("planning exports the blocked-goal unblock and maintenance revalidator",()=>{
  const source=read("services/planning-service.js");
  assert.match(source,/unblockBlockedGoal,revalidateBlockedResourceGoals/);
});

test("engine runs blocked-goal revalidation inside the maintenance cycle",()=>{
  const source=read("simulation/engine.js");
  const maintenance=source.indexOf("if (maintenanceDue)");
  const revalidate=source.indexOf("revalidateBlockedResourceGoals",maintenance);
  const actors=source.indexOf("findAutonomousActors",maintenance);
  assert.ok(maintenance>=0&&revalidate>maintenance&&actors>revalidate);
  assert.match(source.slice(maintenance,revalidate+700),/maintainDistributedResources/);
  assert.match(source.slice(revalidate,revalidate+1400),/simulationTime: nextTime\.toISOString\(\)/);
});

test("intentions persist a direct decision_id link and migration backfills existing action links",()=>{
  const migration=read("db/schema-migrations.js");
  const autonomy=read("services/autonomy-service.js");
  assert.match(migration,/INTENTION_DECISION_MIGRATION/);
  assert.match(migration,/ADD COLUMN decision_id BINARY\(16\) NULL/);
  assert.match(migration,/a\.source_intention_id=i\.id/);
  assert.match(migration,/SET i\.decision_id=a\.decision_id/);
  assert.match(migration,/fk_intentions_decision/);
  assert.match(migration,/fk_intentions_decision_same_simulation/);
  assert.match(autonomy,/decision_id/);
  assert.match(autonomy,/decision\.decisionId/);
});

test("actForEntity compensates a persisted decision when intention or action creation fails",()=>{
  const source=read("services/autonomy-service.js");
  const start=source.indexOf("async function actForEntity");
  const end=source.indexOf("\nasync function ensureIntention",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/let intentionId=null/);
  assert.match(section,/try\{/);
  assert.match(section,/ensureIntention\(/);
  assert.match(section,/startAction\(/);
  assert.match(section,/markDecisionPipelineFailed\(/);
  assert.match(section,/throw err/);
  const helperStart=source.indexOf("async function markDecisionPipelineFailed");
  assert.match(source.slice(helperStart,helperStart+2600),/DECISION_PIPELINE_INCOMPLETE/);
  assert.match(source.slice(helperStart,helperStart+2600),/UPDATE decisions/);
  assert.match(source.slice(helperStart,helperStart+2600),/status='FAILED'/);
});

test("decision reconciler only fails old EVALUATED decisions that lack a live action",()=>{
  const source=read("services/action-reconciliation-service.js");
  const start=source.indexOf("async function reconcileStaleEvaluatedDecisions");
  const end=source.indexOf("\nasync function reconcileCompletedActions",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/d\.status='EVALUATED'/);
  assert.match(section,/d\.simulation_time<=DATE_SUB\(\?,INTERVAL \? MINUTE\)/);
  assert.match(section,/LEFT JOIN intentions/);
  assert.match(section,/i\.decision_id=d\.id/);
  assert.match(section,/LEFT JOIN actions/);
  assert.match(section,/a\.decision_id=d\.id/);
  assert.match(section,/DECISION_PIPELINE_INCOMPLETE/);
  assert.match(section,/UPDATE decisions/);
  assert.match(section,/status='FAILED'/);
  assert.match(section,/UPDATE intentions/);
  assert.match(section,/status='CANCELLED'/);
});

test("engine runs stale decision reconciliation during maintenance",()=>{
  const source=read("simulation/engine.js");
  const maintenance=source.indexOf('setPhase("action.reconcile")');
  const stale=source.indexOf("reconcileStaleEvaluatedDecisions",maintenance);
  const integrity=source.indexOf('setPhase("integrity.check")',stale);
  assert.ok(maintenance>=0&&stale>maintenance&&integrity>stale);
  assert.match(source.slice(maintenance,integrity),/reconcileCompletedActions/);
});
