const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const cognitive=require("../src/services/decision-cognitive-finalization-service");

test("terminal cognitive finalization recognizes terminal outcomes",()=>{
  assert.equal(cognitive.outcomeScore("SUCCESS"),1);
  assert.equal(cognitive.outcomeScore("PARTIAL"),0.5);
  assert.equal(cognitive.outcomeScore("FAILURE"),0);
  assert.equal(cognitive.normalizeOutcome(null,"FAILED"),"FAILURE");
  assert.equal(cognitive.normalizeOutcome(null,"CANCELLED"),"CANCELLED");
});

test("cognitive regret matches the existing expectation resolver semantics",()=>{
  assert.equal(cognitive.calculateCognitiveRegret(0.4,[0.8,0.6],0),0.4);
  assert.equal(cognitive.calculateCognitiveRegret(0.4,[0.8],1),0.2);
});

test("terminal cognitive reconciliation contains the no-open-artifact invariant",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/services/decision-cognitive-finalization-service.js"),"utf8");
  assert.match(source,/status='RESOLVED'/);
  assert.match(source,/status='OPEN'/);
  assert.match(source,/reconcileTerminalDecisionCognition/);
  assert.match(source,/action_outcome/);
});
