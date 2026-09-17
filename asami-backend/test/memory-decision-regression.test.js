const test = require("node:test");
const assert = require("node:assert/strict");
const { humanizeActionMemory, MEMORY_TYPES } = require("../src/services/runtime-enhancements");

test("action memories are psychological rather than raw telemetry", () => {
  const text = humanizeActionMemory({
    actionType: "SLEEPING",
    metadata: {
      kind: "action_outcome",
      actionType: "SLEEPING",
      outcome: "FAILURE",
      location: { label: "Green Market", type: "CAFE" },
      decision: { reason: "sleepiness was high" },
      cause: "THIRST_CRITICAL_INTERRUPTION",
      consequence: "I woke before finishing the planned sleep",
      learning: "sleeping while already thirsty is unreliable",
      strategyAlternative: "drink before going to sleep",
      needChanges: [{ code: "SLEEPINESS", new: 0.22, delta: -0.3 }]
    }
  }, "raw telemetry");

  assert.match(text, /I chose to sleep/);
  assert.match(text, /I learned that sleeping while already thirsty is unreliable/);
  assert.match(text, /drink before going to sleep/);
  assert.doesNotMatch(text, /^raw telemetry$/);
});

test("semantic and procedural memory types are first-class runtime targets", () => {
  assert.equal(MEMORY_TYPES.has("EPISODIC"), true);
  assert.equal(MEMORY_TYPES.has("SEMANTIC"), true);
  assert.equal(MEMORY_TYPES.has("PROCEDURAL"), true);
});
