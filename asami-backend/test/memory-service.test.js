const test = require("node:test");
const assert = require("node:assert/strict");
const { buildActionMemory, buildFailureMemory } = require("../src/services/memory-service");

test("action memory captures context, cause, outcome, consequence and learning", () => {
  const memory = buildActionMemory({
    actionType: "DRINKING",
    outcome: "SUCCESS",
    simulationAt: "2026-09-16T12:00:00.000Z",
    perception: {
      location: { locationId: "loc-1", locationType: "HOME", addressData: { name: "Home" } }
    },
    decision: { actionType: "DRINKING", goalId: "goal-1", reason: "thirst pressure" },
    needChanges: [{ code: "THIRST", value: 0.7 }],
    completion: { learning: "water was available here" }
  });

  assert.match(memory.content, /Context:/);
  assert.match(memory.content, /Cause:/);
  assert.match(memory.content, /Outcome: It succeeded/);
  assert.match(memory.content, /Consequence:/);
  assert.match(memory.content, /Learning:/);
  assert.equal(memory.metadata.outcome, "SUCCESS");
  assert.equal(memory.metadata.decision.goalId, "goal-1");
});

test("resource failure memory records the exhausted resource and alternative strategy", () => {
  const memory = buildFailureMemory({
    locationId: "loc-home",
    simulationTime: "2026-09-16T12:00:00.000Z",
    actionType: "DRINKING",
    perception: {
      location: { locationId: "loc-home", locationType: "HOME", addressData: { name: "Home" } }
    },
    decision: { actionType: "DRINKING", goalId: "goal-thirst" },
    needChanges: [{ code: "THIRST", value: 0.9 }],
    physical: { actionType: "DRINKING", resource: "water", remaining: 0 },
    failureReason: "RESOURCE_UNAVAILABLE",
    resourceLearning: { type: "RESOURCE_UNAVAILABLE", resource: "water" }
  });

  assert.equal(memory.metadata.kind, "resource_failure");
  assert.equal(memory.metadata.failureReason, "RESOURCE_UNAVAILABLE");
  assert.equal(memory.metadata.resource.resource, "water");
  assert.equal(memory.metadata.locationId, "loc-home");
  assert.match(memory.content, /water/);
  assert.match(memory.content, /Alternative strategy:/);
  assert.match(memory.content, /go to another location/);
  assert.equal(memory.context.outcome, "FAILURE");
});
