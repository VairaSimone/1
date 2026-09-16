const test = require("node:test");
const assert = require("node:assert/strict");
const { isSignificantExperience } = require("../src/services/experience-learning-service");
const { emotionAppraisal } = require("../src/services/state-service");

test("significant experiences include failures and meaningful social/resource outcomes", () => {
  assert.equal(isSignificantExperience({ outcome: "FAILURE" }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", targetEntityId: "person-1" }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", resource: { resource: "water", consumed: 1 } }), true);
  assert.equal(isSignificantExperience({ outcome: "SUCCESS", needChanges: [{ delta: 0.05 }] }), false);
});

test("outcome appraisal changes emotion direction independently of action baseline", () => {
  const success = emotionAppraisal("DRINKING", [{ code: "THIRST", new: 0.2 }], {
    event: true,
    outcome: "SUCCESS",
    expectedOutcome: { outcome: "SUCCESS" },
    targetEntityId: "person-1"
  });
  const failure = emotionAppraisal("DRINKING", [{ code: "THIRST", new: 0.9 }], {
    event: true,
    outcome: "FAILURE",
    expectedOutcome: { outcome: "SUCCESS" },
    failureReason: "RESOURCE_UNAVAILABLE",
    targetEntityId: "person-1",
    meaning: "GOAL_BLOCKED"
  });

  assert.ok(success.JOY > 0);
  assert.ok(success.FRUSTRATION >= 0);
  assert.ok(failure.FRUSTRATION > success.FRUSTRATION);
  assert.ok(failure.ANXIETY > success.ANXIETY);
});
