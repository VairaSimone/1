const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreAction } = require("../src/services/decision-rules");
const { classifyPhysicalOutcome } = require("../src/services/action-service");

test("resource availability changes action scoring", () => {
  const needs = [{ code: "THIRST", value: 0.9, priorityWeight: 1 }];
  const local = scoreAction("DRINKING", needs, [], {
    localResources: { water: 5 },
    nearestResources: { water: null },
    blockedResources: {}
  });
  const unavailable = scoreAction("DRINKING", needs, [], {
    localResources: { water: 0 },
    nearestResources: { water: { travelMinutes: 10 } },
    blockedResources: {}
  });
  assert.ok(local > unavailable);
});

test("recently unavailable local resource adds a decision penalty", () => {
  const needs = [{ code: "THIRST", value: 0.9, priorityWeight: 1 }];
  const available = scoreAction("DRINKING", needs, [], {
    localResources: { water: 0 },
    nearestResources: { water: { travelMinutes: 10 } },
    blockedResources: {}
  });
  const blocked = scoreAction("DRINKING", needs, [], {
    localResources: { water: 0 },
    nearestResources: { water: { travelMinutes: 10 } },
    blockedResources: { water: true }
  });
  assert.ok(available > blocked);
});

test("physical outcomes are classified as success, partial, or failure", () => {
  assert.deepEqual(classifyPhysicalOutcome({ ok: true, consumed: 1, remaining: 3 }), {
    outcome: "SUCCESS",
    success: true,
    failureReason: null
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0.5, remaining: 0 }), {
    outcome: "PARTIAL",
    success: false,
    failureReason: "RESOURCE_PARTIALLY_AVAILABLE"
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0, remaining: 0 }), {
    outcome: "FAILURE",
    success: false,
    failureReason: "RESOURCE_UNAVAILABLE"
  });
});
