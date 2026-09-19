const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { safetyContextDelta, emotionAppraisal } = require("../src/services/state-service");

test("safety decreases during risky exploration in a normal environment", () => {
  const safeDelta = safetyContextDelta({
    actionType: "SLEEPING",
    currentValue: 1,
    recoveryRate: 0.5,
    decayRate: 0.02,
    hours: 4,
    perception: {
      simulationTime: "2026-09-19T12:00:00.000Z",
      location: { environment: { weather: "CLEAR", daylight: 1, visibility: 1, noise: 0.1 } },
      recentEvents: []
    }
  });

  const explorationDelta = safetyContextDelta({
    actionType: "EXPLORING",
    currentValue: 1,
    recoveryRate: 0.5,
    decayRate: 0.02,
    hours: 4,
    perception: {
      simulationTime: "2026-09-19T12:00:00.000Z",
      location: { environment: { weather: "CLEAR", daylight: 1, visibility: 1, noise: 0.1 } },
      recentEvents: []
    }
  });

  assert.ok(explorationDelta < safeDelta);
  assert.ok(explorationDelta < 0);
});

test("weather and critical environmental events add safety pressure", () => {
  const clearDelta = safetyContextDelta({
    actionType: "WALKING",
    currentValue: 0.8,
    recoveryRate: 0.5,
    decayRate: 0.02,
    hours: 1,
    perception: {
      simulationTime: "2026-09-19T12:00:00.000Z",
      location: { environment: { weather: "CLEAR", daylight: 1, visibility: 1, noise: 0.1 } },
      recentEvents: []
    }
  });
  const stormDelta = safetyContextDelta({
    actionType: "WALKING",
    currentValue: 0.8,
    recoveryRate: 0.5,
    decayRate: 0.02,
    hours: 1,
    perception: {
      simulationTime: "2026-09-19T12:00:00.000Z",
      location: { environment: { weather: "STORM", daylight: 1, visibility: 0.4, noise: 0.8 } },
      recentEvents: [{
        simulationAt: "2026-09-19T12:00:00.000Z",
        importance: 0.9
      }]
    }
  });

  assert.ok(stormDelta < clearDelta);
});

test("fear responds to moderate safety deterioration, not only critical safety", () => {
  const calm = emotionAppraisal("TALKING", [{ code: "SAFETY", new: 1 }], { deltaHours: 1 });
  const risk = emotionAppraisal("TALKING", [{ code: "SAFETY", new: 0.7 }], { deltaHours: 1 });

  assert.ok(risk.FEAR > calm.FEAR);
});

test("snapshot creation captures live behavioral state when no explicit state is supplied", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/repositories/simulation-repo.js"),
    "utf8"
  );

  assert.match(source, /async function buildSimulationSnapshotState\(/);
  assert.match(source, /const snapshotState = state === undefined \|\| state === null \? await buildSimulationSnapshotState/);
  for (const table of [
    "entity_needs_current",
    "entity_emotions_current",
    "entity_traits_current",
    "entity_skills",
    "entity_development",
    "entity_locations_current",
    "actions",
    "goals"
  ]) {
    assert.match(source, new RegExp(table));
  }
  assert.match(source, /schemaVersion:2/);
});

test("startup reconciliation marks only stale RUNNING ticks as FAILED", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/repositories/simulation-repo.js"),
    "utf8"
  );
  const serverSource = fs.readFileSync(
    path.join(__dirname, "../src/server.js"),
    "utf8"
  );
  const workerSource = fs.readFileSync(
    path.join(__dirname, "../src/worker.js"),
    "utf8"
  );

  assert.match(source, /async function reconcileStaleRunningTicks\(/);
  assert.match(source, /status='RUNNING' AND TIMESTAMPDIFF\(SECOND,real_started_at,UTC_TIMESTAMP\(3\)\) >= \?/);
  assert.match(source, /SET status='FAILED',real_finished_at=UTC_TIMESTAMP\(3\)/);
  assert.doesNotMatch(source, /SET status='ABORTED'/);
  assert.match(serverSource, /reconcileStaleRunningTicks\(\)/);
  assert.match(workerSource, /reconcileStaleRunningTicks\(\)/);
});
