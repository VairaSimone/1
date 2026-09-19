const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveProactivity,
  applyPlanCommitment,
  applyExplorationCommitment,
  criticalNeedAction,
  resolveCriticalDecisionRequirement,
  validateCriticalDecision,
  applyRecoveryBlocks
} = require("../src/services/decision-service");
const { physiologicalPressure } = require("../src/services/behavioral-policy-bootstrap");
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

  assert.ok(modifier >= -0.65 && modifier <= 0.65);
});

test("critical decision requirement records the physiological need separately from the action", () => {
  const routed = {
    critical: { code: "THIRST", resource: "water" },
    selectedAction: "WALKING",
    mode: "ROUTING",
    candidate: { targetLocationId: "water-source" }
  };

  const requirement = resolveCriticalDecisionRequirement(
    [{ code: "THIRST", value: 0.94 }],
    routed
  );

  assert.equal(requirement.needCode, "THIRST");
  assert.equal(requirement.requiredAction, "WALKING");
  assert.equal(requirement.mode, "ROUTING");
  assert.equal(requirement.targetLocationId, "water-source");
  assert.equal(
    validateCriticalDecision(
      [{ code: "THIRST", value: 0.94 }],
      "WALKING",
      "water-source",
      routed
    ).needCode,
    "THIRST"
  );
});

test("critical decision invariant rejects an incoherent final action", () => {
  assert.throws(
    () =>
      validateCriticalDecision(
        [{ code: "THIRST", value: 0.94 }],
        "SLEEPING",
        null,
        {
          critical: { code: "THIRST", resource: "water" },
          selectedAction: "DRINKING",
          mode: "DIRECT",
          candidate: null
        }
      ),
    error => error?.code === "CRITICAL_DECISION_ACTION_MISMATCH"
  );
});

test("critical routed recovery rejects a changed destination", () => {
  assert.throws(
    () =>
      validateCriticalDecision(
        [{ code: "HUNGER", value: 0.92 }],
        "WALKING",
        "wrong-location",
        {
          critical: { code: "HUNGER", resource: "food" },
          selectedAction: "WALKING",
          mode: "ROUTING",
          candidate: { targetLocationId: "food-source" }
        }
      ),
    error => error?.code === "CRITICAL_DECISION_TARGET_MISMATCH"
  );
});

test("critical action cannot be blocked by its own recovery gate", () => {
  const result = applyRecoveryBlocks(
    [
      { action: "SLEEPING", score: 1 },
      { action: "READING", score: 2 }
    ],
    [{ code: "ENERGY", needValue: 0.05, releaseBelow: 0.35, blockedActions: ["SLEEPING", "READING"] }],
    ["SLEEPING"]
  );

  assert.equal(result[0].recoveryBlocked, false);
  assert.equal(result[0].recoveryBlock, null);
  assert.equal(result[1].recoveryBlocked, true);
});

test("ENERGY uses the same critical action in decision and behavioral policy", () => {
  const needs = [{ code: "ENERGY", value: 0.05, priorityWeight: 1 }];
  assert.equal(criticalNeedAction(needs), "SLEEPING");
  assert.equal(physiologicalPressure(needs)?.action, "SLEEPING");
  assert.equal(physiologicalPressure(needs)?.direction, "LOW");
});
