const test = require("node:test");
const assert = require("node:assert/strict");
const { nextHop } = require("../src/services/action-service");
const { applyLocationBias } = require("../src/services/decision-service");

test("location graph moves only along connected nodes", () => {
  const locations = [
    { locationId: "home", data: { worldCode: "HOME", connections: ["PARK", "CAFE"] } },
    { locationId: "park", data: { worldCode: "PARK", connections: ["HOME", "SQUARE"] } },
    { locationId: "cafe", data: { worldCode: "CAFE", connections: ["HOME", "SQUARE"] } },
    { locationId: "square", data: { worldCode: "SQUARE", connections: ["PARK", "CAFE"] } }
  ];

  assert.equal(nextHop(locations, "home", "square"), "park");
  assert.equal(nextHop(locations, "park", "home"), "home");
  assert.equal(nextHop(locations, "home", "home"), null);
});

test("location context changes autonomous action scores", () => {
  const candidates = [
    { action: "SLEEPING", score: 1 },
    { action: "STUDYING", score: 1 },
    { action: "TALKING", score: 1 }
  ];

  const library = applyLocationBias(candidates, { locationType: "LIBRARY" });
  assert.equal(library[0].action, "STUDYING");

  const park = applyLocationBias(candidates, { locationType: "PARK" });
  assert.equal(park[0].action, "TALKING");
});
