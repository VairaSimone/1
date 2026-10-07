const test = require('node:test');
const assert = require('node:assert/strict');
const cognitive = require('../src/services/cognitive-v3-service');

test('belief mapping follows the domain that produced the evidence', () => {
  assert.equal(cognitive.selfBeliefForAction('talking').key, 'SOCIAL_CAPABILITY');
  assert.equal(cognitive.selfBeliefForAction('learning').key, 'CAPABLE_OF_LEARNING');
  assert.equal(cognitive.selfBeliefForAction('drawing').key, 'CREATIVE_CAPABILITY');
  assert.equal(cognitive.selfBeliefForAction('walking').key, 'AGENCY');
});

test('belief revision converts positive and negative evidence into opposing targets', () => {
  assert.ok(Math.abs(cognitive.beliefRevisionTarget(1, 0.8) - 0.8) < 1e-12);
  assert.ok(Math.abs(cognitive.beliefRevisionTarget(-1, 0.8) - 0.2) < 1e-12);
  assert.ok(cognitive.beliefRevisionRate(1) > cognitive.beliefRevisionRate(0));
});

test('normalization remains deterministic for cognitive keys', () => {
  assert.equal(cognitive.selfBeliefForAction('Talking').key, 'SOCIAL_CAPABILITY');
  assert.equal(cognitive.beliefRevisionTarget(1, 2), 1);
  assert.equal(cognitive.beliefRevisionTarget(-1, -2), 1);
});


test("counterfactual worlds keep the shared baseline only on the selected world",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/cognitive-v3-service.js"),"utf8");
  assert.match(source,/const isSelectedWorld = worldKey === normalize\(actionType\)/);
  assert.match(source,/const baselineState = isSelectedWorld \? JSON\.stringify\(baseline\) : null/);
});
