const test = require("node:test");
const assert = require("node:assert/strict");
const { WORLD_LOCATIONS, MIN_WORLD_PEOPLE, MAX_WORLD_PEOPLE, goalActionSatisfiesNeed } = (() => {
  const world = require("../src/services/world-population-service");
  return { ...world, goalActionSatisfiesNeed: require("../src/services/autonomy-service").goalActionSatisfiesNeed };
})();

test("world map has a connected location graph", () => {
  const codes = new Set(WORLD_LOCATIONS.map(location => location.code));
  assert.equal(WORLD_LOCATIONS.length, 12);
  for (const location of WORLD_LOCATIONS) {
    assert.ok(location.connections.length > 0, `${location.code} must have exits`);
    for (const connection of location.connections) assert.ok(codes.has(connection), `${location.code} points to missing ${connection}`);
  }
  assert.ok(MIN_WORLD_PEOPLE >= 5);
  assert.ok(MAX_WORLD_PEOPLE > MIN_WORLD_PEOPLE);
});

test("romantic/social goals remain tied to the correct actions", () => {
  assert.equal(goalActionSatisfiesNeed("BELONGING", "TALKING"), true);
  assert.equal(goalActionSatisfiesNeed("BELONGING", "SLEEPING"), false);
  assert.equal(goalActionSatisfiesNeed("HUNGER", "EATING"), true);
  assert.equal(goalActionSatisfiesNeed("HUNGER", "DRINKING"), false);
});
