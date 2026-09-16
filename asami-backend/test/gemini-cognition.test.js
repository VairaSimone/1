const test = require("node:test");
const assert = require("node:assert/strict");
const { DecisionSchema } = require("../src/ai/gemini");
const { getGeminiTrigger, sanitizeGeminiChoice } = require("../src/services/autonomy-service");

test("Gemini decision schema accepts strategy and multi-step plan proposals", () => {
  const parsed = DecisionSchema.parse({
    selectedActionType: "WALKING",
    targetEntityId: null,
    targetLocationId: "11111111-1111-1111-1111-111111111111",
    reason: "Try a different route after the failed attempt.",
    confidence: 0.72,
    strategy: {
      objective: "Reach water",
      rationale: "The current location was exhausted.",
      constraints: ["Avoid the failed source"],
      fallbackActionType: "RESTING"
    },
    planProposal: {
      title: "Find a reliable water source",
      steps: [
        { title: "Walk to another place", actionType: "WALKING" },
        { title: "Drink", actionType: "DRINKING" }
      ]
    }
  });

  assert.equal(parsed.strategy.objective, "Reach water");
  assert.equal(parsed.planProposal.steps.length, 2);
});

test("Gemini is triggered by failures and periodic strategic deliberation", () => {
  const entity = { entityType: "PERSON", id: "person-1" };
  const context = {
    simulationTime: "2026-09-19T01:42:01.000Z",
    candidates: [
      { action: "DRINKING", score: 1.1 },
      { action: "RESTING", score: 0.5 }
    ],
    recentOutcomes: [{ actionType: "DRINKING", outcome: "FAILURE" }]
  };

  assert.equal(getGeminiTrigger(entity, context).priority, "HIGH");
  assert.equal(getGeminiTrigger(entity, {
    simulationTime: "2026-09-19T01:42:01.000Z",
    candidates: [{ action: "DRINKING", score: 1.1 }, { action: "RESTING", score: 0.8 }]
  }, []).type, "PERIODIC_DELIBERATION");
});

test("Gemini target and plan proposals are constrained by deterministic world data", () => {
  const validEntity = "22222222-2222-2222-2222-222222222222";
  const invalidEntity = "33333333-3333-3333-3333-333333333333";
  const current = "44444444-4444-4444-4444-444444444444";
  const target = "55555555-5555-5555-5555-555555555555";

  const result = sanitizeGeminiChoice({
    selectedActionType: "WALKING",
    targetEntityId: invalidEntity,
    targetLocationId: target,
    reason: "Go there",
    confidence: 0.8,
    planProposal: {
      title: "Reach target",
      steps: [
        { title: "Walk", actionType: "WALKING" },
        { title: "Invent action", actionType: "TELEPORT" }
      ]
    }
  },
  { allowedActionTypes: ["WALKING", "DRINKING"] },
  {
    currentLocationId: current,
    socialContext: { candidates: [{ id: validEntity }] },
    worldLocations: [
      { locationId: current, data: { connections: ["TARGET"] } },
      { locationId: target, data: { worldCode: "TARGET", connections: [] } }
    ]
  });

  assert.equal(result.targetEntityId, null);
  assert.equal(result.targetLocationId, target);
  assert.equal(result.planProposal.steps.length, 1);
  assert.equal(result.planProposal.steps[0].actionType, "WALKING");
});
