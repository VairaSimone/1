const test = require("node:test");
const assert = require("node:assert/strict");
const { needPriorityState, scoreAction } = require("../src/services/decision-rules");
const { computeLearningStrength } = require("../src/services/experience-learning-service");
const { memoryRelevance } = require("../src/services/memory-service");
const { traitBehaviorWeights } = require("../src/services/state-service");
const { getInterruptionReason } = require("../src/simulation/engine");

test("need priority exposes CRITICAL/HIGH/MEDIUM/LOW hierarchy", () => {
  assert.equal(needPriorityState([{ code: "THIRST", value: 0.91, priorityWeight: 1 }]).level, "CRITICAL");
  assert.equal(needPriorityState([{ code: "HUNGER", value: 0.67, priorityWeight: 1 }]).level, "HIGH");
  assert.equal(needPriorityState([{ code: "FUN", value: 0.4, priorityWeight: 1 }]).level, "MEDIUM");
  assert.equal(needPriorityState([{ code: "FUN", value: 0.2, priorityWeight: 1 }]).level, "LOW");
});

test("critical need gets an explicit decision advantage", () => {
  const needs = [
    { code: "THIRST", value: 0.95, priorityWeight: 1 },
    { code: "SOCIAL_NEED", value: 0.9, priorityWeight: 1 }
  ];
  assert.ok(scoreAction("DRINKING", needs, [], { localResources: { water: 1 } }) > scoreAction("TALKING", needs, []));
});

test("a single failure has weaker learning than repeated contextual failures", () => {
  const first = Math.abs(computeLearningStrength({ outcome: "FAILURE", confidence: 0.96, repetition: 0.125, contextSimilarity: 0.35 }));
  const repeated = Math.abs(computeLearningStrength({ outcome: "FAILURE", confidence: 0.96, repetition: 1, contextSimilarity: 1 }));
  assert.ok(first > 0);
  assert.ok(repeated > first * 3);
  assert.ok(repeated <= 0.25);
});

test("success produces a learning signal too", () => {
  const success = computeLearningStrength({ outcome: "SUCCESS", confidence: 0.8, repetition: 0.5, contextSimilarity: 0.8 });
  const failure = computeLearningStrength({ outcome: "FAILURE", confidence: 0.8, repetition: 0.5, contextSimilarity: 0.8 });
  assert.ok(success > 0);
  assert.ok(failure < 0);
  assert.ok(Math.abs(failure) > success);
});

test("memory relevance prefers goal/location/action matches over an unrelated recent memory", () => {
  const context = {
    simulationTime: "2026-09-22T10:00:00.000Z",
    goalIds: ["goal-1"],
    locationId: "loc-1",
    locationType: "CAFE",
    candidateActionTypes: ["TALKING"],
    targetEntityId: "person-1"
  };
  const relevant = {
    simulationAt: "2026-09-21T10:00:00.000Z",
    importance: 0.6,
    strength: 0.7,
    confidence: 0.9,
    locationId: "loc-1",
    metadata: { goalId: "goal-1", actionType: "TALKING", location: { type: "CAFE", id: "loc-1" }, targetEntityId: "person-1" },
    content: "Talking with person-1 at the cafe advanced my social goal."
  };
  const unrelated = {
    simulationAt: "2026-09-22T09:30:00.000Z",
    importance: 0.5,
    strength: 0.7,
    confidence: 0.9,
    locationId: "loc-9",
    metadata: { actionType: "WATCHING", location: { type: "HOME", id: "loc-9" } },
    content: "I watched something at home."
  };
  assert.ok(memoryRelevance(relevant, context) > memoryRelevance(unrelated, context));
});

test("trait mapping is evidence metadata, not a direct action-to-trait update", () => {
  assert.equal(traitBehaviorWeights("TALKING").EXTRAVERSION, 0.6);
  assert.equal(traitBehaviorWeights("TALKING").SOCIABILITY, 0.7);
  assert.equal(traitBehaviorWeights("TALKING").EMPATHY, 0.25);
});

test("long actions are interrupted by incompatible critical needs", () => {
  const result = getInterruptionReason("WORKING", [
    { code: "THIRST", value: 0.91 },
    { code: "SLEEPINESS", value: 0.2 }
  ], { recentEvents: [] });
  assert.equal(result.type, "CRITICAL_NEED");
  assert.equal(result.code, "THIRST");
});

test("sleeping is not interrupted by sleepiness itself", () => {
  const result = getInterruptionReason("SLEEPING", [
    { code: "SLEEPINESS", value: 0.95 },
    { code: "THIRST", value: 0.2 }
  ], { recentEvents: [] });
  assert.equal(result, null);
});