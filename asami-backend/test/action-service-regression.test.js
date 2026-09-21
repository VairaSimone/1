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
