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
  assert.equal(cognitive.beliefRevisionTarget(1, 0.8), 0.8);
  assert.equal(cognitive.beliefRevisionTarget(-1, 0.8), 0.2);
  assert.ok(cognitive.beliefRevisionRate(1) > cognitive.beliefRevisionRate(0));
});

test('normalization remains deterministic for cognitive keys', () => {
  assert.equal(cognitive.selfBeliefForAction('social connection').key, 'SOCIAL_CAPABILITY');
  assert.equal(cognitive.beliefRevisionTarget(1, 2), 1);
  assert.equal(cognitive.beliefRevisionTarget(-1, -2), 1);
});