const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveProactivity,
  applyPlanCommitment,
  applyExplorationCommitment,
  criticalNeedAction
} = require("../src/services/decision-service");
const {
  shouldCreateExperiencePreference,
  cognitiveExperienceModifier
} = require("../src/services/experience-learning-service");

test("critical physiological needs suppress social proactivity", () => {
  const result = deriveProactivity({
    needs: [
      { code: "THIRST", value: 1 },
      { code: "SOCIAL_NEED", value: 0.7 }
    ],
    social: { candidates: [{ id: "person-1" }] }
  });

  assert.equal(criticalNeedAction([{ code: "THIRST", value: 1 }, { code: "SOCIAL_NEED", value: 0.7 }]), "DRINKING");
  assert.equal(result.priority, "CRITICAL");
  assert.equal(result.signals.some(signal => signal.type === "SOCIAL"), false);
});

test("active plan step becomes a commitment rather than a weak bonus", () => {
  const candidates = [
    { action: "TALKING", score: 2.0 },
    { action: "WALKING", score: 1.1 }
  ];
  const ranked = applyPlanCommitment(candidates, {
    needs: [{ code: "SOCIAL_NEED", value: 0.4 }],
    activePlanStep: { actionType: "WALKING", status: "ACTIVE" }
  });

  assert.equal(ranked[0].action, "WALKING");
});

test("novel exploration opportunity can commit when curiosity is high", () => {
  const candidates = [
    { action: "TALKING", score: 1.8 },
    { action: "EXPLORING", score: 1.1 }
  ];
  const ranked = applyExplorationCommitment(candidates, {
    needs: [
      { code: "CURIOSITY", value: 0.9 },
      { code: "SOCIAL_NEED", value: 0.25 }
    ],
    explorationDestination: {
      locationId: "school",
      novelty: 1,
      interest: 0.79,
      travelMinutes: 7.38
    }
  });

  assert.equal(ranked[0].action, "EXPLORING");
  assert.equal(ranked[0].targetLocationId, "school");
});

test("routine successful targeted interaction does not create an action preference", () => {
  assert.equal(shouldCreateExperiencePreference({
    outcome: "SUCCESS",
    needChanges: [{ code: "SOCIAL_NEED", delta: 0.08 }]
  }), false);

  assert.equal(shouldCreateExperiencePreference({
    outcome: "SUCCESS",
    needChanges: [{ code: "HUNGER", delta: -0.55 }]
  }), true);
});

test("stored experience cannot dominate decision making", () => {
  const modifier = cognitiveExperienceModifier({
    preferences: [
      { targetType: "ACTION:TALKING", preferenceValue: 1, strength: 1, confidence: 1 },
      { targetType: "LOCATION_ACTION:CAFE:TALKING", preferenceValue: 1, strength: 1, confidence: 1 }
    ],
    beliefs: [
      { predicate: "ACTION_OUTCOME_TALKING", objectValue: { outcome: "SUCCESS" }, confidence: 1, importance: 1 }
    ],
    knowledge: Array.from({ length: 50 }, () => ({
      predicate: "ACTION_OUTCOME",
      content: JSON.stringify({ actionType: "TALKING", outcome: "SUCCESS" }),
      confidence: 1
    }))
  }, "TALKING", { locationType: "CAFE" });

  assert.ok(modifier <= 0.35);
});
