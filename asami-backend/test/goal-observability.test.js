const test=require("node:test");
const assert=require("node:assert/strict");
const observability=require("../src/services/simulation-observability");

test("goal observability separates elapsed gaps from active action time",()=>{
  const simulationId="sim-goal-observability";
  const entityId="entity-goal-observability";
  const goalId="goal-goal-observability";
  observability.recordGoalProgress(simulationId,entityId,"2026-01-01T00:00:00Z",{
    goalId,progress:0.2,status:"ACTIVE",actionType:"WORKING"
  });
  const gap=observability.recordGoalActionOutcome(simulationId,entityId,"2026-01-01T01:00:00Z",{
    goalId,actionId:"action-0",actionType:"WORKING",outcome:"SUCCESS",durationMinutes:0
  });
  assert.equal(gap.timeSinceLastProgress,1);
  assert.equal(gap.timeSinceLastAction,1);
  assert.equal(gap.totalActiveTime,0);
  assert.equal(gap.activeTimeOnCurrentGoal,0);
  const outcome=observability.recordGoalActionOutcome(simulationId,entityId,"2026-01-01T02:00:00Z",{
    goalId,actionId:"action-1",actionType:"WORKING",outcome:"SUCCESS",durationMinutes:90
  });
  assert.equal(outcome.totalActiveTime,1.5);
  assert.equal(outcome.activeTimeOnCurrentGoal,1.5);
  assert.equal(outcome.successfulActionsOnGoal,2);
  assert.equal(outcome.failedActionsOnGoal,0);
  const duplicate=observability.recordGoalActionOutcome(simulationId,entityId,"2026-01-01T03:00:00Z",{
    goalId,actionId:"action-1",actionType:"WORKING",outcome:"SUCCESS",durationMinutes:90
  });
  assert.equal(duplicate.successfulActionsOnGoal,2);
  assert.equal(duplicate.totalActiveTime,1.5);
});

test("legacy activityHours elapsed-gap metric is no longer produced",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/simulation-observability.js"),"utf8");
  assert.match(source,/timeSinceLastProgress/);
  assert.match(source,/timeSinceLastAction/);
  assert.match(source,/activeTimeOnCurrentGoal/);
  assert.match(source,/successfulActionsOnGoal/);
  assert.match(source,/failedActionsOnGoal/);
  assert.doesNotMatch(source,/activityHoursSinceLastAction/);
});
