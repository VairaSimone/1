const test = require('node:test');
const assert = require('node:assert/strict');
const { cognitiveDecisionModifier, clamp01 } = require('../src/services/personality-service');

test('cognitiveDecisionModifier favors strong action preferences and habits', async () => {
  const candidates = [
    { action: 'READING', score: 1 },
    { action: 'TALKING', score: 1 }
  ];
  const result = await cognitiveDecisionModifier({
    cognitiveProfile: {
      preferences: [{ targetType: 'ACTION:TALKING', preferenceValue: 1, strength: 1, confidence: 1 }],
      habits: [{ strength: 0.8, actionDefinition: { actionType: 'TALKING' } }]
    }
  }, candidates);
  assert.equal(result[0].action, 'TALKING');
  assert.ok(result[0].score > result[1].score);
});

test('clamp01 is finite and bounded', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01('not-a-number'), 0.5);
});
