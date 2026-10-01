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


test("completed drinking with consumed water always lowers thirst", () => {
  const { calculateOutcomeDependentNeedDelta } = require("../src/services/state-service");
  const effect = calculateOutcomeDependentNeedDelta({actionType:"DRINKING",needCode:"THIRST",currentValue:0.8,durationMinutes:10,consumed:1});
  assert.equal(effect.applied,true);
  assert.ok(effect.delta < 0);
  assert.ok(effect.new < effect.old);
});

test("partial water consumption lowers thirst proportionally", () => {
  const { calculateOutcomeDependentNeedDelta } = require("../src/services/state-service");
  const full = calculateOutcomeDependentNeedDelta({actionType:"DRINKING",needCode:"THIRST",currentValue:0.8,durationMinutes:10,consumed:1});
  const partial = calculateOutcomeDependentNeedDelta({actionType:"DRINKING",needCode:"THIRST",currentValue:0.8,durationMinutes:10,consumed:0.5});
  assert.ok(partial.delta < 0);
  assert.ok(Math.abs(partial.delta) < Math.abs(full.delta));
});

test("zero water consumption does not apply the drinking thirst recovery", () => {
  const { calculateOutcomeDependentNeedDelta } = require("../src/services/state-service");
  const effect = calculateOutcomeDependentNeedDelta({actionType:"DRINKING",needCode:"THIRST",currentValue:0.8,durationMinutes:10,consumed:0});
  assert.equal(effect.applied,false);
  assert.equal(effect.delta,0);
});

test("drinking thirst recovery is outcome-dependent, not applied by passive action ticking", () => {
  const fs = require("node:fs"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname,"../src/services/state-service.js"),"utf8");
  assert.match(source,/OUTCOME_DEPENDENT_NEED_EFFECTS/);
  assert.match(source,/if\(action && !isOutcomeDependentNeed\(action,r\.code\)\)/);
});

test("completed drinking records a physiological need effect and enforces the invariant", () => {
  const fs = require("node:fs"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname,"../src/services/action-service.js"),"utf8");
  assert.match(source,/applyOutcomeDependentNeed/);
  assert.match(source,/RESOURCE_NEED_INVARIANT_VIOLATION/);
  assert.match(source,/oldNeed:/);
  assert.match(source,/actionDelta:/);
  assert.match(source,/newNeed:/);
});
