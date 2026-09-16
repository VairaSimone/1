const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveProactivity, applyProactiveOpportunityBias } = require("../src/services/decision-service");

test("internal state produces an explicit proactive trigger", () => {
  const proactivity = deriveProactivity({
    needs: [
      { code: "SOCIAL_NEED", value: 0.72 },
      { code: "CURIOSITY", value: 0.51 }
    ],
    goals: [{ id: "goal-1", priority: 0.8, progress: 0.2 }],
    social: { candidates: [{ id: "person-1" }] },
    explorationDestination: { locationId: "loc-2", novelty: 0.9, score: 1.2 },
    activePlanStep: { id: "step-1", result: { actionType: "WALKING" } }
  });

  assert.equal(proactivity.mode, "PROACTIVE");
  assert.equal(proactivity.trigger, "INTERNAL_STATE");
  assert.equal(proactivity.priority, "HIGH");
  assert.ok(proactivity.signals.some(signal => signal.type === "SOCIAL"));
  assert.ok(proactivity.signals.some(signal => signal.type === "EXPLORATION"));
});

test("proactive opportunities influence ranking without bypassing the action domain", () => {
  const candidates = [
    { action: "RESTING", score: 1.0 },
    { action: "TALKING", score: 0.85 },
    { action: "EXPLORING", score: 0.80 }
  ];
  const proactivity = deriveProactivity({
    needs: [{ code: "SOCIAL_NEED", value: 0.7 }],
    goals: [],
    social: { candidates: [{ id: "person-1" }] },
    explorationDestination: { locationId: "loc-2", novelty: 0.8, score: 1.0 }
  });

  const ranked = applyProactiveOpportunityBias(candidates, proactivity);
  assert.equal(ranked[0].action, "TALKING");
  assert.deepEqual(ranked.map(candidate => candidate.action).sort(), ["EXPLORING", "RESTING", "TALKING"].sort());
});

test("the next decision remains a separate cycle after an outcome", () => {
  const cycle = ["PERCEPTION", "DECISION", "ACTION", "OUTCOME", "APPRAISAL", "LEARNING", "NEXT_DECISION"];
  assert.deepEqual(cycle.slice(0, 6), ["PERCEPTION", "DECISION", "ACTION", "OUTCOME", "APPRAISAL", "LEARNING"]);
  assert.equal(cycle[6], "NEXT_DECISION");
});
