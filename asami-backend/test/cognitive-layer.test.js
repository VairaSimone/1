const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReactiveLayer, buildDeliberativeLayer, buildHabitLayer, composeCognitiveLayers, shouldBlockByReactive } = require("../src/services/cognitive-layer-service");
const { cognitiveExperienceModifier, habitActionForProfile } = require("../src/services/experience-learning-service");

test("reactive layer has explicit CRITICAL precedence", () => {
  const layers = buildReactiveLayer([
    { code: "THIRST", value: 0.91, priorityWeight: 1 },
    { code: "SOCIAL_NEED", value: 0.95, priorityWeight: 1 }
  ]);
  assert.equal(layers.priority, "CRITICAL");
  assert.equal(layers.topNeed.code, "THIRST");
  assert.equal(layers.blocking, true);
});

test("deliberative layer keeps goals separate from physiological pressure", () => {
  const layer = buildDeliberativeLayer({
    needs: [
      { code: "THIRST", value: 0.9, priorityWeight: 1 },
      { code: "CURIOSITY", value: 0.8, priorityWeight: 1 }
    ],
    goals: [{ id: "goal-1", title: "Study biology", priority: 0.9, progress: 0.2, motivation: 0.8 }],
    activePlanStep: { id: "step-1", sequence: 1, title: "Read chapter", actionType: "READING", status: "ACTIVE" }
  });
  assert.equal(layer.goal.id, "goal-1");
  assert.equal(layer.activePlanStep.actionType, "READING");
  assert.equal(layer.dominantNeeds[0].code, "CURIOSITY");
});

test("habit layer is disabled while reactive layer is critical", () => {
  const blocked = buildHabitLayer({
    needs: [{ code: "THIRST", value: 0.95 }],
    habits: [{ id: "h1", name: "walk", strength: 0.95, triggerDefinition: { type: "TIME_WINDOW", hour: 17, toleranceHours: 2 }, actionDefinition: { actionType: "WALKING" } }],
    simulationTime: "2026-09-16T17:00:00.000Z"
  });
  assert.equal(blocked.blockedByReactive, true);
  assert.equal(blocked.selected, null);
});

test("habit can become active when no critical reactive blocker exists", () => {
  const layers = composeCognitiveLayers({
    needs: [{ code: "THIRST", value: 0.2 }, { code: "FUN", value: 0.1 }],
    goals: [],
    habits: [{ id: "h1", name: "walk", strength: 0.9, triggerDefinition: { type: "TIME_WINDOW", hour: 17, toleranceHours: 2 }, actionDefinition: { actionType: "WALKING" } }],
    simulationTime: "2026-09-16T17:00:00.000Z"
  });
  assert.equal(layers.habit.selected.actionType, "WALKING");
  assert.equal(layers.winner, "HABIT");
  assert.equal(shouldBlockByReactive(layers, "WALKING"), false);
});

test("active deliberative plan suppresses habit bonus", () => {
  const profile = {
    mentalState: { updatedSimulationAt: "2026-09-16T17:00:00.000Z" },
    plans: [{ status: "ACTIVE", steps: [{ status: "ACTIVE", actionType: "READING" }] }],
    habits: [{ id: "h1", strength: 1, triggerDefinition: { type: "TIME_WINDOW", hour: 17, toleranceHours: 2 }, actionDefinition: { actionType: "WALKING" } }],
    preferences: [],
    beliefs: []
  };
  assert.equal(habitActionForProfile(profile, "WALKING", "2026-09-16T17:00:00.000Z").actionType, "WALKING");
  const withPlan = cognitiveExperienceModifier(profile, "WALKING", { simulationTime: "2026-09-16T17:00:00.000Z" });
  const withoutPlan = cognitiveExperienceModifier({ ...profile, plans: [] }, "WALKING", { simulationTime: "2026-09-16T17:00:00.000Z" });
  assert.ok(withoutPlan > withPlan);
});

test("semantic resource preference only influences matching resource actions", () => {
  const profile = {
    mentalState: { updatedSimulationAt: "2026-09-16T12:00:00.000Z" },
    plans: [], habits: [], beliefs: [],
    preferences: [{ targetType: "LOCATION_RESOURCE:SCHOOL:FOOD", preferenceValue: -1, strength: 0.8, confidence: 0.9 }]
  };
  const eating = cognitiveExperienceModifier(profile, "EATING", { locationType: "SCHOOL" });
  const drinking = cognitiveExperienceModifier(profile, "DRINKING", { locationType: "SCHOOL" });
  assert.ok(eating < drinking);
});
