const test = require("node:test");
const assert = require("node:assert/strict");

const { habitMaturity, habitStrengthFromEvidence } = require("../src/services/behavioral-policy-bootstrap");

test("habit maturity accepts a repeated multi-day routine with either temporal or contextual stability", () => {
  const maturity = habitMaturity({
    observations: 16,
    distinctDays: 5,
    spanDays: 4.2,
    maxGapDays: 2.1,
    timeConcentration: 0.58,
    contextConsistency: 0.71,
    rewardRate: 0.81,
    decisionDominance: 0.74
  });

  assert.equal(maturity.mature, true);
  assert.deepEqual(maturity.reasons, []);
  assert.equal(maturity.patternConsistency, 0.71);
});

test("a burst of actions on one day does not become a persistent habit", () => {
  const maturity = habitMaturity({
    observations: 40,
    distinctDays: 1,
    spanDays: 0.27,
    maxGapDays: 0.04,
    timeConcentration: 0.88,
    contextConsistency: 1,
    rewardRate: 1,
    decisionDominance: 1
  });

  assert.equal(maturity.mature, false);
  assert.ok(maturity.reasons.includes("INSUFFICIENT_DISTINCT_DAYS"));
  assert.ok(maturity.reasons.includes("INSUFFICIENT_TEMPORAL_SPAN"));
});

test("a matured habit is created above the HABITUAL activation threshold", () => {
  const strength = habitStrengthFromEvidence({
    observations: 12,
    rewardRate: 0.65,
    decisionDominance: 0.55,
    timeConcentration: 0.55,
    contextConsistency: 0.55
  });

  assert.ok(strength >= 0.70);
  assert.ok(strength <= 0.86);
});

test("habit maturity no longer requires perfect simultaneous time and location consistency", () => {
  const maturity = habitMaturity({
    observations: 14,
    distinctDays: 4,
    spanDays: 2.3,
    maxGapDays: 1.5,
    timeConcentration: 0.59,
    contextConsistency: 0.42,
    rewardRate: 0.72,
    decisionDominance: 0.65
  });

  assert.equal(maturity.mature, true);
});
