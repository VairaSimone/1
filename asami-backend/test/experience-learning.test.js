const test = require("node:test");
const assert = require("node:assert/strict");
const { isSignificantExperience, shouldCreateExperiencePreference, cognitiveExperienceModifier } = require("../src/services/experience-learning-service");
const { emotionAppraisal } = require("../src/services/state-service");

test("significant experiences include failures and meaningful social/resource outcomes", () => {
  assert.equal(isSignificantExperience({ outcome: "FAILURE" }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", targetEntityId: "person-1" }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", resource: { resource: "water", consumed: 1 } }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", needChanges: [{ delta: 0.05 }] }), false);
});

test("routine success does not automatically become a preference", () => {
  assert.equal(shouldCreateExperiencePreference({ outcome: "SUCCESS", needChanges: [{ delta: 0.08 }] }), false);
  assert.equal(shouldCreateExperiencePreference({ outcome: "SUCCESS", needChanges: [{ delta: -0.5 }] }), true);
  assert.equal(shouldCreateExperiencePreference({ outcome: "FAILURE", needChanges: [] }), true);
});

test("outcome appraisal changes emotion direction independently of action baseline", () => {
  const success = emotionAppraisal("DRINKING", [{ code: "THIRST", new: 0.2 }], { event: true, outcome: "SUCCESS", expectedOutcome: { outcome: "SUCCESS" }, targetEntityId: "person-1" });
  const failure = emotionAppraisal("DRINKING", [{ code: "THIRST", new: 0.9 }], { event: true, outcome: "FAILURE", expectedOutcome: { outcome: "SUCCESS" }, failureReason: "RESOURCE_UNAVAILABLE", targetEntityId: "person-1", meaning: "GOAL_BLOCKED" });
  assert.ok(success.JOY > 0);
  assert.ok(failure.FRUSTRATION > success.FRUSTRATION);
  assert.ok(failure.ANXIETY > success.ANXIETY);
});

test("experience cognition biases later action selection within a bounded range", () => {
  const profile = {
    preferences: [
      { targetType: "ACTION:DRINKING", preferenceValue: -1, strength: 0.7, confidence: 0.9 },
      { targetType: "LOCATION_ACTION:HOME:DRINKING", preferenceValue: -1, strength: 0.8, confidence: 0.9 }
    ],
    beliefs: [{ predicate: "ACTION_OUTCOME_DRINKING", objectValue: { outcome: "FAILURE", locationId: "home" }, confidence: 0.9, importance: 0.9 }],
    knowledge: [{ predicate: "ACTION_OUTCOME", content: JSON.stringify({ actionType: "DRINKING", outcome: "FAILURE", locationId: "home" }), confidence: 0.9 }]
  };
  const modifier = cognitiveExperienceModifier(profile, "DRINKING", { locationType: "HOME", locationId: "home" });
  assert.ok(modifier >= -0.65 && modifier <= 0.65);
});

test("exploration and goal-linked successes are significant learning experiences",()=>{
  const { isSignificantExperience } = require("../src/services/experience-learning-service");
  assert.equal(isSignificantExperience({outcome:"SUCCESS",actionType:"EXPLORING",needChanges:[]}),true);
  assert.equal(isSignificantExperience({outcome:"SUCCESS",actionType:"READING",goalId:"goal-1",needChanges:[]}),true);
  assert.equal(isSignificantExperience({outcome:"SUCCESS",actionType:"READING",needChanges:[]}),false);
});
