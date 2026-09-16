const test = require("node:test");
const assert = require("node:assert/strict");
const { GOAL_TEMPLATES, selectTopNeed, selectActiveStep } = require("../src/services/planning-service");

test("selectTopNeed chooses the strongest weighted pressure", () => {
  const need = selectTopNeed([
    { code: "HUNGER", value: 0.55, priorityWeight: 0.5 },
    { code: "THIRST", value: 0.45, priorityWeight: 1.1 },
    { code: "SLEEPINESS", value: 0.20, priorityWeight: 1.1 }
  ]);

  assert.equal(need.code, "THIRST");
});

test("autonomous goals expose concrete multi-step plans where sequencing matters", () => {
  assert.deepEqual(GOAL_TEMPLATES.THIRST.steps.map(step => step.actionType), ["WALKING", "DRINKING"]);
  assert.deepEqual(GOAL_TEMPLATES.HUNGER.steps.map(step => step.actionType), ["WALKING", "EATING"]);
  assert.deepEqual(GOAL_TEMPLATES.CURIOSITY.steps.map(step => step.actionType), ["EXPLORING", "READING"]);
});

test("selectActiveStep prefers ACTIVE step and otherwise first PENDING step", () => {
  const pendingPlan = {
    steps: [
      { id: "2", sequence: 2, status: "PENDING" },
      { id: "1", sequence: 1, status: "PENDING" }
    ]
  };
  assert.equal(selectActiveStep(pendingPlan).id, "1");

  const activePlan = {
    steps: [
      { id: "3", sequence: 3, status: "PENDING" },
      { id: "2", sequence: 2, status: "ACTIVE" },
      { id: "1", sequence: 1, status: "COMPLETED" }
    ]
  };
  assert.equal(selectActiveStep(activePlan).id, "2");
});
