const test = require("node:test");
const assert = require("node:assert/strict");
const { haversineMeters, nextHop, classifyPhysicalOutcome } = require("../src/services/action-service");

test("movement distance rejects invalid coordinates", () => {
  assert.equal(haversineMeters({ latitude: null, longitude: 7 }, { latitude: 45, longitude: 8 }), Infinity);
});

test("walking without an explicit destination selects a connected next hop", () => {
  const locations = [
    { locationId: "A", data: { worldCode: "HOME", connections: ["PARK"] } },
    { locationId: "B", data: { worldCode: "PARK", connections: ["HOME"] } }
  ];
  assert.equal(nextHop(locations, "A"), "B");
});

test("resource outcomes distinguish unavailable, partial and successful consumption", () => {
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0, remaining: 0, resource: "food" }), {
    outcome: "FAILURE",
    success: false,
    failureReason: "RESOURCE_UNAVAILABLE"
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: false, consumed: 0.5, remaining: 0, resource: "food" }), {
    outcome: "PARTIAL",
    success: false,
    failureReason: "RESOURCE_PARTIALLY_AVAILABLE"
  });
  assert.deepEqual(classifyPhysicalOutcome({ ok: true, consumed: 1, remaining: 4, resource: "food" }), {
    outcome: "SUCCESS",
    success: true,
    failureReason: null
  });
});
