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


test('calculateTraitEvidence learns from repeated successful non-social experiences', () => {
  const evidence = require('../src/services/state-service').calculateTraitEvidence({
    actionType: 'READING',
    outcomes: ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS'],
    repetitions: 4,
    mentalState: { certainty: 0.7, rumination: 0.1 }
  });

  assert.ok(evidence.weights.CURIOSITY > 0);
  assert.ok(evidence.weights.OPENNESS > 0);
  assert.ok(evidence.evidenceStrength > 0);
});

test('calculateTraitEvidence reverses direction after repeated failures', () => {
  const evidence = require('../src/services/state-service').calculateTraitEvidence({
    actionType: 'STUDYING',
    outcomes: ['FAILURE', 'FAILURE', 'FAILURE'],
    repetitions: 3,
    mentalState: { certainty: 0.5, rumination: 0.1 }
  });

  assert.ok(evidence.evidenceStrength < 0);
});

test('calculateTraitEvidence does not mutate personality from insufficient evidence', () => {
  const evidence = require('../src/services/state-service').calculateTraitEvidence({
    actionType: 'EXPLORING',
    outcomes: ['SUCCESS', 'SUCCESS'],
    repetitions: 2
  });

  assert.equal(evidence.evidenceStrength, 0);
  assert.deepEqual(evidence.weights, {});
});
