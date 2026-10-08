const test=require("node:test");
const assert=require("node:assert/strict");
const { classifyPhysicalOutcome }=require("../src/services/action-service");
test("missing physical result is treated as successful for non-resource actions",()=>{assert.deepEqual(classifyPhysicalOutcome(undefined),{outcome:"SUCCESS",success:true,failureReason:null});});
test("partial resource consumption is distinct from total failure",()=>{assert.deepEqual(classifyPhysicalOutcome({ok:false,consumed:.5}),{outcome:"PARTIAL",success:false,failureReason:"RESOURCE_PARTIALLY_AVAILABLE"});});
test("zero consumed resource is a failure",()=>{assert.deepEqual(classifyPhysicalOutcome({ok:false,consumed:0}),{outcome:"FAILURE",success:false,failureReason:"RESOURCE_UNAVAILABLE"});});
test("event effect writes use the transaction retry path",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/event-service.js"),"utf8");
  assert.match(source,/withTransaction/);
  assert.match(source,/withEventWriteLock\(simulationId/);
  assert.match(source,/\{ connection: conn \}/);
});

test("event effect insert remains inside the retried transaction",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/event-service.js"),"utf8");
  const start=source.indexOf("async function addEffect(");
  const end=source.indexOf("\nasync function listEvents",start);
  const block=source.slice(start,end);
  assert.ok(block.indexOf("withTransaction")<block.indexOf("INSERT INTO event_effects"));
});

test("simulation engine completes active actions before stale decision reconciliation",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  const entityLoop=source.indexOf("for (const id of actors)");
  const completion=source.indexOf("completion = await actionService.completeAction",entityLoop);
  const reconciliation=source.indexOf("const staleDecisionReconciliation = await reconcileStaleEvaluatedDecisions",completion);
  const reconcilePhase=source.indexOf('setPhase("action.reconcile");',completion);
  assert.ok(entityLoop>=0);
  assert.ok(completion>entityLoop);
  assert.ok(reconciliation>completion);
  assert.ok(reconcilePhase>completion);
});

test("autonomy actor selection prioritizes entities with active actions",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");
  assert.match(
    source,
    /ORDER BY CASE WHEN EXISTS\(SELECT 1 FROM actions a WHERE a\.simulation_id=e\.simulation_id AND a\.entity_id=e\.id AND a\.status='ACTIVE'\) THEN 0 ELSE 1 END/
  );
});

test("stale decision logs distinguish decision time from reconciliation time",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/action-reconciliation-service.js"),"utf8");
  assert.match(source,/decisionSimulationTime:row\.simulationTime/);
  assert.match(source,/reconciliationSimulationTime:simulationTime/);
});
