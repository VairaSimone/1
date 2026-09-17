const test = require("node:test");
const assert = require("node:assert/strict");
const { sleepReadiness, scoreAction } = require("../src/services/decision-rules");
const { computeLearningStrength, cognitiveExperienceModifier } = require("../src/services/experience-learning-service");

test("sleep is not selected when the body is already rested", () => {
  const needs = [
    { code: "SLEEPINESS", value: 0.12, priorityWeight: 1 },
    { code: "ENERGY", value: 0.92, priorityWeight: 1 },
    { code: "THIRST", value: 0.25, priorityWeight: 1 },
    { code: "HUNGER", value: 0.25, priorityWeight: 1 }
  ];
  assert.equal(sleepReadiness(needs), 0);
  assert.equal(scoreAction("SLEEPING", needs, []), 0);
});

test("pre-sleep thirst reduces sleep readiness", () => {
  const rested = [
    { code: "SLEEPINESS", value: 0.70 },
    { code: "ENERGY", value: 0.35 },
    { code: "THIRST", value: 0.30 },
    { code: "HUNGER", value: 0.30 }
  ];
  const thirsty = rested.map(need => need.code === "THIRST" ? { ...need, value: 0.72 } : need);
  assert.ok(sleepReadiness(thirsty) < sleepReadiness(rested));
});

test("repeated interrupted negative experience becomes materially stronger", () => {
  const first = Math.abs(computeLearningStrength({ outcome: "PARTIAL", confidence: 0.86, repetition: 0, contextSimilarity: 0.5, interrupted: true }));
  const repeated = Math.abs(computeLearningStrength({ outcome: "PARTIAL", confidence: 0.86, repetition: 1, contextSimilarity: 1, interrupted: true }));
  assert.ok(repeated > first * 2);
});

test("learned negative preference produces a visible action penalty", () => {
  const modifier = cognitiveExperienceModifier({
    preferences: [{ targetType: "ACTION:SLEEPING", preferenceValue: -1, strength: 0.22, confidence: 0.9 }],
    beliefs: [],
    plans: []
  }, "SLEEPING");
  assert.ok(modifier < -0.12);
  assert.ok(modifier >= -0.35);
});
