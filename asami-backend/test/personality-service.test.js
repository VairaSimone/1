const test = require('node:test');
const assert = require('node:assert/strict');
const { cognitiveDecisionModifier, clamp01 } = require('../src/services/personality-service');

test('cognitiveDecisionModifier favors strong action preferences and habits', async () => {
  const profile = {
    preferences: [{ targetType: 'ACTION:TALKING', preferenceValue: 1, strength: 1, confidence: 1 }],
    habits: [{ strength: 0.8, actionDefinition: { actionType: 'TALKING' } }]
  };
  const talkingModifier = cognitiveDecisionModifier(profile, 'TALKING');
  const readingModifier = cognitiveDecisionModifier(profile, 'READING');
  assert.ok(talkingModifier > readingModifier);
  assert.ok(talkingModifier > 0);
});

test('clamp01 is finite and bounded', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01('not-a-number'), 0.5);
});
