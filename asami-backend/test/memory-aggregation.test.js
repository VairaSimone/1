const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const { createMemory, isSalientActionOutcome } = require("../src/services/memory-service");

test("routine successful action is aggregateable", () => {
  assert.equal(isSalientActionOutcome({ metadata: { kind: "action_outcome", actionType: "WALKING", outcome: "SUCCESS", needChanges: [{ code: "CURIOSITY", delta: -0.04 }] }, importance: 0.5, emotionalIntensity: 0.2 }), false);
});

test("salient successful actions stay episodic", () => {
  assert.equal(isSalientActionOutcome({ metadata: { kind: "action_outcome", actionType: "WALKING", outcome: "SUCCESS", goalId: "goal-1" }, importance: 0.5, emotionalIntensity: 0.2 }), true);
  assert.equal(isSalientActionOutcome({ metadata: { kind: "action_outcome", actionType: "TALKING", outcome: "SUCCESS" }, importance: 0.5, emotionalIntensity: 0.2 }), true);
  assert.equal(isSalientActionOutcome({ metadata: { kind: "action_outcome", actionType: "WALKING", outcome: "SUCCESS", needChanges: [{ code: "THIRST", delta: -0.25 }] }, importance: 0.5, emotionalIntensity: 0.2 }), true);
});

test("repeated routine success updates the aggregate", async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("action_routine")) return [[{ id: "routine-memory-1", version: 3, createdAt: "2026-09-19 10:00:00.000", strength: 0.62, confidence: 0.68, importance: 0.32, metadata: JSON.stringify({ kind: "action_routine", routineObservationCount: 5 }) }]];
    if (sql.startsWith("UPDATE memories SET content=?")) return [{ affectedRows: 1 }];
    throw new Error("Unexpected SQL");
  };
  try {
    const id = await createMemory({ simulationId: "simulation-1", entityId: "entity-1", locationId: "shop", simulationAt: "2026-09-19T12:00:00.000Z", content: "routine", importance: 0.5, strength: 0.86, confidence: 0.85, emotionalIntensity: 0.24, metadata: { kind: "action_outcome", actionType: "WALKING", outcome: "SUCCESS", location: { id: "shop", type: "SHOP", label: "Shop" }, needChanges: [{ code: "CURIOSITY", delta: -0.04 }] } });
    assert.equal(id, "routine-memory-1");
    assert.equal(calls.length, 2);
  } finally { pool.query = originalQuery; }
});

test("first routine success creates a semantic aggregate", async () => {
  const originalQuery = pool.query;
  const calls = [];
  pool.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("action_routine")) return [[]];
    if (sql.startsWith("INSERT INTO memories")) return [{ affectedRows: 1 }];
    throw new Error("Unexpected SQL");
  };
  try {
    const id = await createMemory({ simulationId: "simulation-1", entityId: "entity-1", locationId: "shop", simulationAt: "2026-09-19T12:00:00.000Z", content: "routine", importance: 0.5, strength: 0.86, confidence: 0.85, emotionalIntensity: 0.24, metadata: { kind: "action_outcome", actionType: "WALKING", outcome: "SUCCESS", location: { id: "shop", type: "SHOP", label: "Shop" }, needChanges: [{ code: "CURIOSITY", delta: -0.04 }] } });
    assert.ok(id);
    assert.equal(calls.length, 2);
    const metadata = JSON.parse(calls[1].values[calls[1].values.length - 1]);
    assert.equal(metadata.kind, "action_routine");
    assert.equal(metadata.routineObservationCount, 1);
  } finally { pool.query = originalQuery; }
});
