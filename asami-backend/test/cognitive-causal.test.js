const test = require('node:test');
const assert = require('node:assert/strict');
const causal = require('../src/services/cognitive-causal-service');

test('causal normalization produces stable graph keys', () => {
  assert.equal(causal.normalize(' meaningful relationships '), 'MEANINGFUL_RELATIONSHIPS');
  assert.equal(causal.normalize('A'.repeat(300)).length, 180);
});

test('action evidence maps into a persistent belief domain', () => {
  assert.equal(causal.beliefForAction('talking').key, 'SOCIAL_CAPABILITY');
  assert.equal(causal.beliefForAction('learning').key, 'CAPABLE_OF_LEARNING');
  assert.equal(causal.beliefForAction('drawing').key, 'CREATIVE_CAPABILITY');
});

test('causal action mapping connects experience to desire and values', () => {
  assert.equal(causal.DESIRES.LEARNING, 'UNDERSTAND_WORLD');
  assert.ok(causal.VALUES.HELPING.includes('KINDNESS'));
  assert.ok(causal.VALUES.HELPING.includes('SOCIAL_CONNECTION'));
});

test('negative evidence targets the opposite belief confidence', () => {
  assert.equal(causal.beliefRevisionTarget(1, 0.8), 0.8);
  assert.ok(Math.abs(causal.beliefRevisionTarget(-1, 0.8) - 0.2) < Number.EPSILON * 16);
});

test('causal relationships remain bounded and interpretable', () => {
  assert.equal(causal.clamp01(4), 1);
  assert.equal(causal.clamp01(-2), 0);
  const summary = causal.causalSummary([
    { sourceType: 'MEMORY', sourceKey: 'LEARNING:SUCCESS', targetType: 'SELF_BELIEF', targetKey: 'CAPABLE_OF_LEARNING', activation: 0.6 },
  ]);
  assert.match(summary, /MEMORY:LEARNING:SUCCESS/);
  assert.match(summary, /SELF_BELIEF:CAPABLE_OF_LEARNING/);
});
