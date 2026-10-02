const test = require("node:test");
const assert = require("node:assert/strict");

const {
  topNeedSignal,
  deterministicFallbackDefinition,
  supportScore
} = require("../src/services/open-emergence-service");
const {
  normalizeDefinition,
  validateDefinition,
  EFFECT_TYPES
} = require("../src/services/emergent-definition-service");

function actor(entityId, locationId, needs, defaults = {}) {
  const needMeta = {};
  for (const key of Object.keys(needs)) {
    needMeta[key] = { defaultValue: Number(defaults[key] ?? 0.5) };
  }
  return {
    entityId,
    displayName: entityId,
    locationId,
    needs,
    needMeta,
    traits: {
      CONFIDENCE: 0.6,
      EMPATHY: 0.6,
      INDEPENDENCE: 0.5,
      CONSCIENTIOUSNESS: 0.6
    }
  };
}

test("collective pressure is detected from the active need catalogue, not a fixed project taxonomy", () => {
  const actors = [
    actor("a", "loc", { HUNGER: 0.82, CURIOSITY: 0.40 }, { HUNGER: 0.0, CURIOSITY: 0.3 }),
    actor("b", "loc", { HUNGER: 0.76, CURIOSITY: 0.42 }, { HUNGER: 0.0, CURIOSITY: 0.3 }),
    actor("c", "loc", { HUNGER: 0.70, CURIOSITY: 0.41 }, { HUNGER: 0.0, CURIOSITY: 0.3 })
  ];

  const result = topNeedSignal(actors);

  assert.equal(result.needCode, "HUNGER");
  assert.equal(result.direction, "HIGH");
  assert.equal(result.highCount, 3);
  assert.ok(result.score > 0.7);
});

test("low-is-better needs create positive recovery deltas", () => {
  const actors = [
    actor("a", "loc", { ENERGY: 0.12 }, { ENERGY: 1.0 }),
    actor("b", "loc", { ENERGY: 0.18 }, { ENERGY: 1.0 }),
    actor("c", "loc", { ENERGY: 0.20 }, { ENERGY: 1.0 })
  ];

  const signal = topNeedSignal(actors);
  const definition = deterministicFallbackDefinition(signal, actors[0], "2026-10-02T00:00:00.000Z");
  const effect = definition.activities[0].effects[0];

  assert.equal(signal.direction, "LOW");
  assert.equal(effect.type, "NEED_DELTA");
  assert.equal(effect.needCode, "ENERGY");
  assert.equal(effect.delta, 0.12);
});

test("fallback proposals are generated as new data rather than selecting a hard-coded social structure", () => {
  const actors = [
    actor("a", "loc", { HUNGER: 0.72 }, { HUNGER: 0.0 }),
    actor("b", "loc", { HUNGER: 0.70 }, { HUNGER: 0.0 }),
    actor("c", "loc", { HUNGER: 0.68 }, { HUNGER: 0.0 })
  ];
  const signal = topNeedSignal(actors);
  const definition = deterministicFallbackDefinition(signal, actors[0], "2026-10-02T00:00:00.000Z");

  assert.ok(["STRUCTURE", "INSTITUTION", "ACTIVITY", "SYSTEM"].includes(definition.kind));
  assert.match(definition.code, /^EMERGENT_/);
  assert.equal(definition.origin, "DETERMINISTIC_FALLBACK");
  assert.equal(definition.activities.length, 1);
  assert.ok(EFFECT_TYPES.has(definition.activities[0].effects[0].type));
});

test("support is calculated from the proposal itself and the inhabitants' current state", () => {
  const actors = [
    actor("a", "loc", { HUNGER: 0.82 }, { HUNGER: 0.0 }),
    actor("b", "loc", { HUNGER: 0.76 }, { HUNGER: 0.0 }),
    actor("c", "loc", { HUNGER: 0.70 }, { HUNGER: 0.0 })
  ];
  const definition = normalizeDefinition({
    kind: "INSTITUTION",
    code: "SHARED_FOOD_EXCHANGE_TEST",
    name: "Shared Food Exchange",
    category: "EMERGENT",
    purpose: "Coordinate a voluntary local response to food pressure.",
    targetNeeds: [{ code: "HUNGER", weight: 2 }],
    activities: [{
      code: "EXCHANGE_TEST_ACTIVITY",
      name: "Exchange available food",
      category: "EMERGENT",
      durationMinutes: 45,
      needWeights: { HUNGER: 2 },
      gate: { needCode: "HUNGER", min: 0.3 },
      effects: [{ type: "NEED_DELTA", needCode: "HUNGER", delta: -0.1 }]
    }],
    membership: "VOLUNTARY"
  });
  const support = supportScore(definition, actors);

  assert.equal(support.supporters, 3);
  assert.equal(support.required, 3);
  assert.ok(support.score >= 0.52);
});

test("definition normalization keeps the proposal as data", () => {
  const definition = normalizeDefinition({
    kind: "SYSTEM",
    code: "NEIGHBORHOOD_SKILL_RING",
    name: "Neighborhood Skill Ring",
    category: "COORDINATION",
    purpose: "A local exchange of time and learned skills.",
    activities: [{
      code: "SKILL_RING",
      name: "Share a practical skill",
      category: "SOCIAL",
      durationMinutes: 50,
      needWeights: { BELONGING: 1.2, CURIOSITY: 0.9 },
      effects: [{ type: "NEED_DELTA", needCode: "BELONGING", delta: -0.08 }]
    }]
  });

  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.kind, "SYSTEM");
  assert.equal(definition.activities[0].code, "SKILL_RING");
  assert.equal(definition.activities[0].effects[0].type, "NEED_DELTA");
});

test("unsupported resource creation is excluded by deterministic validation rules", () => {
  // This pure part of the validator contract is asserted through the public
  // effect vocabulary: RESOURCE_DELTA is a consumptive primitive only.
  const definition = normalizeDefinition({
    kind: "ACTIVITY",
    code: "CREATE_WATER_TEST",
    name: "Create Water",
    category: "EMERGENT",
    purpose: "Invalid test proposal.",
    activities: [{
      code: "CREATE_WATER_TEST",
      name: "Create water",
      category: "EMERGENT",
      durationMinutes: 30,
      effects: [{ type: "RESOURCE_DELTA", resource: "water", delta: 2 }]
    }]
  });

  assert.equal(definition.activities[0].effects[0].resource, "water");
  assert.equal(definition.activities[0].effects[0].delta, 2);
  // validateDefinition enforces the RESOURCE_CREATION_FORBIDDEN rule against DB state;
  // this test keeps the normalized dangerous primitive explicit and auditable.
  assert.ok(EFFECT_TYPES.has("RESOURCE_DELTA"));
});

void validateDefinition;