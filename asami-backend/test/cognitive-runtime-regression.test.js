const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLink, normalizeActivation } = require('../src/services/cognitive-causal-api-guard');

test('causal API normalizes SQL DECIMAL fields to numbers', () => {
  const link = normalizeLink({ weight: '0.42', polarity: '-1', confidence: '0.75', evidenceCount: '9' });
  assert.equal(link.weight, 0.42);
  assert.equal(link.polarity, -1);
  assert.equal(link.confidence, 0.75);
  assert.equal(link.evidenceCount, 9);
});

test('causal API normalizes activation depth and magnitude', () => {
  const activation = normalizeActivation({ activation: '-0.6', depth: '2.8' });
  assert.equal(activation.activation, -0.6);
  assert.equal(activation.depth, 3);
});

test('causal API rejects non-finite numeric payloads safely', () => {
  const link = normalizeLink({ weight: 'not-a-number', confidence: null });
  const activation = normalizeActivation({ activation: 'NaN', depth: '-4' });
  assert.equal(link.weight, 0);
  assert.equal(link.confidence, 0);
  assert.equal(activation.activation, 0);
  assert.equal(activation.depth, 0);
});
