const test = require("node:test");
const assert = require("node:assert/strict");
const { buildActionMemory, buildFailureMemory, recallContext, deriveRecallContext, memoryRelevance } = require("../src/services/memory-service");

test("action memory captures context, cause, outcome, consequence and learning", () => {
  const memory = buildActionMemory({
    actionType: "DRINKING",
    outcome: "SUCCESS",
    simulationAt: "2026-09-16T12:00:00.000Z",
    perception: {
      location: { locationId: "loc-1", locationType: "HOME", addressData: { name: "Home" } }
    },
    decision: { actionType: "DRINKING", goalId: "goal-1", reason: "thirst pressure" },
    needChanges: [{ code: "THIRST", value: 0.7 }],
    completion: { learning: "water was available here" }
  });

  assert.match(memory.content, /Context:/);
  assert.match(memory.content, /Cause:/);
  assert.match(memory.content, /Outcome: It succeeded/);
  assert.match(memory.content, /Consequence:/);
  assert.match(memory.content, /Learning:/);
  assert.equal(memory.metadata.outcome, "SUCCESS");
  assert.equal(memory.metadata.decision.goalId, "goal-1");
});

test("resource failure memory records the exhausted resource and alternative strategy", () => {
  const memory = buildFailureMemory({
    locationId: "loc-home",
    simulationTime: "2026-09-16T12:00:00.000Z",
    actionType: "DRINKING",
    perception: {
      location: { locationId: "loc-home", locationType: "HOME", addressData: { name: "Home" } }
    },
    decision: { actionType: "DRINKING", goalId: "goal-thirst" },
    needChanges: [{ code: "THIRST", value: 0.9 }],
    physical: { actionType: "DRINKING", resource: "water", remaining: 0 },
    failureReason: "RESOURCE_UNAVAILABLE",
    resourceLearning: { type: "RESOURCE_UNAVAILABLE", resource: "water" }
  });

  assert.equal(memory.metadata.kind, "resource_failure");
  assert.equal(memory.metadata.failureReason, "RESOURCE_UNAVAILABLE");
  assert.equal(memory.metadata.resource.resource, "water");
  assert.equal(memory.metadata.locationId, "loc-home");
  assert.match(memory.content, /water/);
  assert.match(memory.content, /Alternative strategy:/);
  assert.match(memory.content, /go to another location/);
  assert.equal(memory.context.outcome, "FAILURE");
});


test("cognitive memory recall requires an explicit simulation timestamp", async () => {
  await assert.rejects(
    () => recallContext("simulation-1", "entity-1"),
    error => error?.code === "SIMULATION_TIME_REQUIRED"
  );
  await assert.rejects(
    () => deriveRecallContext("simulation-1", "entity-1"),
    error => error?.code === "SIMULATION_TIME_REQUIRED"
  );
});

test("memory lifecycle exposes transition counters and current state gauges",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const memory=fs.readFileSync(path.join(__dirname,"../src/services/memory-service.js"),"utf8");
  const retention=fs.readFileSync(path.join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  const observability=fs.readFileSync(path.join(__dirname,"../src/services/simulation-observability.js"),"utf8");
  for(const name of [
    "memory_created_total",
    "memory_recalled_total",
    "memory_strength_changed_total",
    "memory_forgotten_total",
    "memory_deduplicated_total",
    "memory_archived_total"
  ]) assert.match(memory+retention,new RegExp(name));
  assert.match(memory,/recordMemoryStatusDistribution/);
  assert.match(memory,/observability\.setGauge\(simulationId,\`memory_\$\{status\.toLowerCase\(\)\}_current\`,counts\[status\]\|\|0\)/);
  assert.match(memory,/\["ACTIVE","FADING","FORGOTTEN","ARCHIVED"\]/);
  assert.match(observability,/memory.*Current|memory_active_current/);
});

test("memory relevance never falls back to wall-clock time", () => {
  assert.throws(
    () =>
      memoryRelevance(
        {
          simulationAt: "2026-09-20T10:00:00.000Z",
          importance: 0.5,
          strength: 0.8,
          confidence: 0.8,
          metadata: {}
        },
        {}
      ),
    error => error?.code === "SIMULATION_TIME_REQUIRED"
  );
});
