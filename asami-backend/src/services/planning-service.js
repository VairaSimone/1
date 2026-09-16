const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const GOAL_PRESSURE_CODES = new Set([
  "HUNGER",
  "THIRST",
  "SLEEPINESS",
  "SOCIAL_NEED",
  "FUN",
  "CURIOSITY",
  "ACHIEVEMENT",
  "BELONGING"
]);

const GOAL_TEMPLATES = {
  HUNGER: {
    title: "Find food",
    description: "Get food and satisfy the current hunger pressure.",
    goalType: "NEED",
    steps: [
      { title: "Go somewhere with food", description: "Travel to a reachable place where food is available.", actionType: "WALKING" },
      { title: "Eat", description: "Consume available food and verify the result.", actionType: "EATING" }
    ]
  },
  THIRST: {
    title: "Find water",
    description: "Find accessible water and satisfy the current thirst pressure.",
    goalType: "NEED",
    steps: [
      { title: "Go somewhere with water", description: "Travel to a reachable place where water is available.", actionType: "WALKING" },
      { title: "Drink", description: "Consume available water and verify the result.", actionType: "DRINKING" }
    ]
  },
  SOCIAL_NEED: {
    title: "Connect with someone",
    description: "Have a meaningful social interaction to reduce social pressure.",
    goalType: "NEED",
    steps: [
      { title: "Talk with someone", description: "Find an appropriate person and have a social interaction.", actionType: "TALKING" }
    ]
  },
  BELONGING: {
    title: "Strengthen belonging",
    description: "Build or reinforce a meaningful social connection.",
    goalType: "NEED",
    steps: [
      { title: "Talk with someone", description: "Have an interaction that can contribute to belonging.", actionType: "TALKING" }
    ]
  },
  FUN: {
    title: "Do something enjoyable",
    description: "Choose an enjoyable activity and follow through with it.",
    goalType: "NEED",
    steps: [
      { title: "Go somewhere interesting", description: "Travel toward a suitable place for leisure.", actionType: "WALKING" },
      { title: "Have fun", description: "Perform an activity that meaningfully satisfies fun.", actionType: "PLAYING" }
    ]
  },
  CURIOSITY: {
    title: "Learn something new",
    description: "Seek a novel experience and turn it into learning.",
    goalType: "NEED",
    steps: [
      { title: "Explore somewhere new", description: "Visit a location that is interesting and not recently visited.", actionType: "EXPLORING" },
      { title: "Learn from the experience", description: "Read or study something connected to the experience.", actionType: "READING" }
    ]
  },
  ACHIEVEMENT: {
    title: "Accomplish something",
    description: "Complete a meaningful productive activity.",
    goalType: "NEED",
    steps: [
      { title: "Work toward the objective", description: "Perform a productive action that advances the objective.", actionType: "STUDYING" },
      { title: "Complete the objective", description: "Continue with a productive activity until the goal is complete.", actionType: "WORKING" }
    ]
  },
  SLEEPINESS: {
    title: "Get enough sleep",
    description: "Restore sleep and energy when sleep pressure is high.",
    goalType: "NEED",
    steps: [
      { title: "Sleep", description: "Get enough uninterrupted sleep and verify recovery.", actionType: "SLEEPING" }
    ]
  }
};

function normalizeAction(value) {
  return String(value || "").trim().toUpperCase();
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function selectTopNeed(needs) {
  const candidates = (needs || [])
    .filter(need => GOAL_PRESSURE_CODES.has(String(need.code || "").toUpperCase()))
    .map(need => ({ ...need, value: Number(need.value), priorityWeight: Number(need.priorityWeight || 1) }))
    .filter(need => Number.isFinite(need.value) && need.value > 0.30)
    .sort((a, b) => (b.value * b.priorityWeight) - (a.value * a.priorityWeight));
  return candidates[0] || null;
}

async function getActiveGoal(simulationId, entityId) {
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,title,goal_type AS goalType,priority,progress,status,motivation,result
     FROM goals
     WHERE simulation_id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND status IN ('DRAFT','ACTIVE','PAUSED')
     ORDER BY priority DESC,created_simulation_at ASC
     LIMIT 1`,
    [simulationId, entityId]
  );
  return rows[0] || null;
}

async function getPlanForGoal(simulationId, entityId, goalId) {
  if (!goalId) return null;
  const [plans] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,version,title,status,strategy
     FROM plans
     WHERE simulation_id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND goal_id=UUID_TO_BIN(?)
       AND status IN ('DRAFT','ACTIVE','PAUSED')
     ORDER BY created_simulation_at DESC
     LIMIT 1`,
    [simulationId, entityId, goalId]
  );
  if (!plans.length) return null;

  const plan = plans[0];
  const [steps] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,sequence,title,description,status,
            intended_start_simulation_at AS intendedStart,
            deadline_simulation_at AS deadline,result,version
     FROM plan_steps
     WHERE plan_id=UUID_TO_BIN(?)
     ORDER BY sequence ASC`,
    [plan.id]
  );

  return {
    ...plan,
    strategy: parseJson(plan.strategy, {}),
    steps: steps.map(step => ({
      ...step,
      result: parseJson(step.result, null)
    }))
  };
}

async function createPlanForGoal({ simulationId, entityId, goalId, simulationTime, needCode, pressure, priority }) {
  const template = GOAL_TEMPLATES[needCode];
  if (!template?.steps?.length || !goalId) return null;

  const existing = await getPlanForGoal(simulationId, entityId, goalId);
  if (existing) return existing;

  const planId = uuid();
  await pool.query(
    `INSERT INTO plans
      (id,simulation_id,entity_id,goal_id,title,status,strategy,created_simulation_at,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,
    [
      planId,
      simulationId,
      entityId,
      goalId,
      template.title,
      JSON.stringify({
        source: "AUTONOMOUS_NEED",
        need: needCode,
        initialPressure: Number(pressure),
        priority: Number(priority)
      }),
      simulationTime
    ]
  );

  for (let i = 0; i < template.steps.length; i += 1) {
    const step = template.steps[i];
    let activityTypeId = null;
    const actionType = normalizeAction(step.actionType);
    if (actionType) {
      const [activityRows] = await pool.query(
        `SELECT id FROM activity_types WHERE code=? AND active=1 LIMIT 1`,
        [actionType]
      );
      activityTypeId = activityRows[0]?.id || null;
    }

    await pool.query(
      `INSERT INTO plan_steps
        (id,plan_id,sequence,title,description,status,activity_type_id,
         intended_start_simulation_at,deadline_simulation_at,result,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,'PENDING',UUID_TO_BIN(?),NULL,NULL,?,1)`,
      [
        uuid(),
        planId,
        i + 1,
        step.title,
        step.description,
        activityTypeId,
        JSON.stringify({ actionType, attempts: 0 })
      ]
    );
  }

  await pool.query(
    `UPDATE plan_steps
     SET status='ACTIVE',version=version+1
     WHERE plan_id=UUID_TO_BIN(?) AND sequence=1 AND status='PENDING'`,
    [planId]
  );

  return getPlanForGoal(simulationId, entityId, goalId);
}

async function ensureGoalPlan({ simulationId, entityId, simulationTime, needs }) {
  const activeGoal = await getActiveGoal(simulationId, entityId);
  if (activeGoal) {
    let motivation = parseJson(activeGoal.motivation, {});
    const needCode = normalizeAction(motivation.need);
    let plan = await getPlanForGoal(simulationId, entityId, activeGoal.id);
    if (!plan && GOAL_TEMPLATES[needCode]) {
      plan = await createPlanForGoal({
        simulationId,
        entityId,
        goalId: activeGoal.id,
        simulationTime,
        needCode,
        pressure: motivation.pressure,
        priority: activeGoal.priority
      });
    }
    return { goal: activeGoal, plan, created: false };
  }

  const topNeed = selectTopNeed(needs);
  if (!topNeed) return { goal: null, plan: null, created: false };

  const template = GOAL_TEMPLATES[String(topNeed.code).toUpperCase()];
  if (!template) return { goal: null, plan: null, created: false };

  const goalId = uuid();
  const priority = Math.max(0.1, Math.min(1, Number(topNeed.priorityWeight || 0.5)));
  await pool.query(
    `INSERT INTO goals
      (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,
       created_simulation_at,motivation,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',0,?,CAST(? AS JSON),1)`,
    [
      goalId,
      simulationId,
      entityId,
      template.title,
      template.description,
      template.goalType,
      priority,
      simulationTime,
      JSON.stringify({
        need: String(topNeed.code).toUpperCase(),
        pressure: Number(topNeed.value),
        priorityWeight: Number(topNeed.priorityWeight || 1),
        source: "AUTONOMOUS_NEED"
      })
    ]
  );

  const plan = await createPlanForGoal({
    simulationId,
    entityId,
    goalId,
    simulationTime,
    needCode: String(topNeed.code).toUpperCase(),
    pressure: topNeed.value,
    priority
  });

  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,title,description,goal_type AS goalType,priority,status,progress,motivation,result
     FROM goals WHERE id=UUID_TO_BIN(?) LIMIT 1`,
    [goalId]
  );

  return { goal: rows[0] || null, plan, created: true };
}

function selectActiveStep(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps.slice().sort((a, b) => Number(a.sequence) - Number(b.sequence)) : [];
  return steps.find(step => step.status === "ACTIVE")
    || steps.find(step => step.status === "PENDING")
    || null;
}

async function advancePlanForAction({
  simulationId,
  entityId,
  goalId,
  actionType,
  outcome,
  simulationTime,
  actionResult = null
}) {
  if (!goalId) return { changed: false, completed: false, progress: null, planId: null };

  const plan = await getPlanForGoal(simulationId, entityId, goalId);
  if (!plan) return { changed: false, completed: false, progress: null, planId: null };

  const step = selectActiveStep(plan);
  if (!step) return { changed: false, completed: true, progress: 1, planId: plan.id };

  const normalizedAction = normalizeAction(actionType);
  const expectedAction = normalizeAction(parseJson(step.result, {})?.actionType || step.actionType);
  const successful = outcome === "SUCCESS";
  const partial = outcome === "PARTIAL";
  const failed = outcome === "FAILURE";

  let changed = false;
  if (expectedAction === normalizedAction && successful) {
    const [updated] = await pool.query(
      `UPDATE plan_steps
       SET status='COMPLETED',result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
      [
        JSON.stringify({
          actionType: normalizedAction,
          outcome,
          completedAt: simulationTime,
          actionResult
        }),
        step.id,
        step.version
      ]
    );
    changed = updated.affectedRows === 1;

    if (changed) {
      const nextStep = plan.steps
        .filter(candidate => Number(candidate.sequence) > Number(step.sequence))
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))[0];
      if (nextStep) {
        await pool.query(
          `UPDATE plan_steps
           SET status='ACTIVE',version=version+1
           WHERE id=UUID_TO_BIN(?) AND status='PENDING'`,
          [nextStep.id]
        );
      }
    }
  } else if (expectedAction === normalizedAction && (failed || partial)) {
    const previousResult = parseJson(step.result, {}) || {};
    const attempts = Number(previousResult.attempts || 0) + 1;
    await pool.query(
      `UPDATE plan_steps
       SET status='ACTIVE',result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
      [
        JSON.stringify({
          ...previousResult,
          actionType: normalizedAction,
          outcome,
          attempts,
          lastAttemptAt: simulationTime,
          lastActionResult: actionResult
        }),
        step.id,
        step.version
      ]
    );
  }

  const refreshedPlan = await getPlanForGoal(simulationId, entityId, goalId);
  if (!refreshedPlan) return { changed, completed: false, progress: null, planId: plan.id };

  const totalSteps = refreshedPlan.steps.length;
  const completedSteps = refreshedPlan.steps.filter(candidate => candidate.status === "COMPLETED").length;
  const progress = totalSteps ? completedSteps / totalSteps : 0;
  const planCompleted = totalSteps > 0 && completedSteps === totalSteps;

  if (planCompleted && refreshedPlan.status !== "COMPLETED") {
    await pool.query(
      `UPDATE plans SET status='COMPLETED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED')`,
      [refreshedPlan.id]
    );
  }

  const [goalRows] = await pool.query(
    `SELECT version,status FROM goals WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
    [goalId, entityId]
  );
  if (!goalRows.length) return { changed, completed: false, progress, planId: refreshedPlan.id };

  const goal = goalRows[0];
  const shouldCompleteGoal = planCompleted;
  if (shouldCompleteGoal) {
    await pool.query(
      `UPDATE goals SET progress=1,status='COMPLETED',completed_simulation_at=?,result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')`,
      [
        simulationTime,
        JSON.stringify({
          completionSource: "PLAN",
          planId: refreshedPlan.id,
          completedSteps,
          totalSteps,
          lastAction: normalizedAction,
          lastOutcome: outcome
        }),
        goalId,
        goal.version
      ]
    );
  } else {
    await pool.query(
      `UPDATE goals SET progress=?,result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')`,
      [
        progress,
        JSON.stringify({
          planId: refreshedPlan.id,
          completedSteps,
          totalSteps,
          lastAction: normalizedAction,
          lastOutcome: outcome,
          updatedAt: simulationTime
        }),
        goalId,
        goal.version
      ]
    );
  }

  return {
    changed,
    completed: shouldCompleteGoal,
    progress,
    planId: refreshedPlan.id,
    stepId: step.id,
    stepAction: expectedAction
  };
}

module.exports = {
  GOAL_PRESSURE_CODES,
  GOAL_TEMPLATES,
  selectTopNeed,
  getActiveGoal,
  getPlanForGoal,
  createPlanForGoal,
  ensureGoalPlan,
  selectActiveStep,
  advancePlanForAction
};
