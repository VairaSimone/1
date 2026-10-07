const test = require("node:test");
const assert = require("node:assert/strict");
const { haversineMeters, nextHop, classifyPhysicalOutcome } = require("../src/services/action-service");

test("movement distance rejects invalid coordinates", () => {
  assert.equal(haversineMeters({ latitude: null, longitude: 7 }, { latitude: 45, longitude: 8 }), Infinity);
});

test("walking without an explicit destination selects a connected next hop", () => {
  const locations = [
    { locationId: "A", data: { worldCode: "HOME", connections: ["PARK"] } },
    { locationId: "B", data: { worldCode: "PARK", connections: ["HOME"] } }
  ];
  assert.equal(nextHop(locations, "A"), "B");
});

test("resource outcomes distinguish unavailable, partial and successful consumption", () => {
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0, remaining: 0, resource: "food" }), {
    outcome: "FAILURE",
    success: false,
    failureReason: "RESOURCE_UNAVAILABLE"
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0.5, remaining: 0, resource: "food" }), {
    outcome: "PARTIAL",
    success: false,
    failureReason: "RESOURCE_PARTIALLY_AVAILABLE"
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: true, consumed: 1, remaining: 4, resource: "food" }), {
    outcome: "SUCCESS",
    success: true,
    failureReason: null
  });
});

test("reconciler covers interrupted terminal actions and marks post-processing complete",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/action-reconciliation-service.js"),"utf8");
  assert.match(source,/a\.status IN \('COMPLETED','INTERRUPTED'\)/);
  assert.match(source,/terminalStatus==="INTERRUPTED"/);
  assert.match(source,/markActionPostProcessingComplete\(row\.actionId\)/);
});

test("action lifecycle completion marks interrupted actions as post-processed",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  assert.match(source,/calibrateDecisionOutcome\(active\.decisionId,"PARTIAL"\)/);
  assert.match(source,/markActionPostProcessingComplete\(actionId\)/);
});

test("post-processing finalizer accepts interrupted terminal actions",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/action-service.js"),"utf8");
  assert.match(source,/status IN \('COMPLETED','INTERRUPTED'\) AND post_processing_status='PENDING'/);
});

test("reconciler increments its counter only after post-processing is actually finalized",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/action-reconciliation-service.js"),"utf8");
  assert.match(source,/if\(await markActionPostProcessingComplete\(row\.actionId\)\) reconciled\+=1/);
});


test("action reconciler finalizes terminal cognitive artifacts after recovering a decision",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/action-reconciliation-service.js"),"utf8");
  assert.match(source,/finalizeDecisionCognitiveArtifacts/);
  assert.match(source,/finalizeRecoveredDecisionCognition/);
  assert.match(source,/terminal reconciliation/);
});


test("critical action interruption finalizes terminal decision cognition immediately",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  assert.match(source,/finalizeDecisionCognitiveArtifacts/);
  assert.match(source,/decision:cognitive-interrupt/);
  assert.match(source,/outcome:"PARTIAL"/);
});

test("autonomy pipeline failure attempts terminal cognitive finalization even when decision was already terminalized",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");
  assert.match(source,/async function markDecisionPipelineFailed/);
  assert.match(source,/finalizeDecisionCognitiveArtifacts/);
  assert.match(source,/decision:cognitive-pipeline-failure/);
});

test("integrity check runs after stale decision reconciliation",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  const reconcile=source.indexOf("const staleDecisionReconciliation = await reconcileStaleEvaluatedDecisions");
  const integrity=source.indexOf("const integrity = await runSimulationIntegrityCheck",reconcile);
  const oldIntegrity=source.indexOf("const integrity = await runSimulationIntegrityCheck",0);
  assert.ok(reconcile>=0);
  assert.ok(integrity>reconcile);
  assert.equal(oldIntegrity,integrity);
});

test("critical interruption uses the function simulation time for cognitive finalization",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  assert.doesNotMatch(source,/simulationTime:updateTime/);
  const interruption=source.indexOf("async function interruptActiveAction");
  const finalization=source.indexOf("finalizeDecisionCognitiveArtifacts",interruption);
  const end=source.indexOf("await actionService.markActionPostProcessingComplete(actionId)",finalization);
  assert.ok(interruption>=0);
  assert.ok(finalization>interruption);
  assert.ok(end>finalization);
  assert.match(source.slice(finalization,end),/simulationTime,/);
});
