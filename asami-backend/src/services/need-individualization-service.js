const { pool } = require("../db/pool");

const NEED_PROFILES = Object.freeze({
  HUNGER: {
    decay: { SELF_CARE: -0.16, IMPULSIVITY: 0.08, DISCIPLINE: -0.06 },
    priority: { SELF_CARE: -0.08, IMPULSIVITY: 0.06 },
    relief: { SELF_CARE: 0.10, IMPULSIVITY: 0.05 }
  },
  THIRST: {
    decay: { SELF_CARE: -0.08, IMPULSIVITY: 0.04 },
    priority: { SELF_CARE: -0.05, NEUROTICISM: 0.06 },
    relief: { SELF_CARE: 0.08 }
  },
  SLEEPINESS: {
    decay: { DISCIPLINE: -0.08, PATIENCE: -0.06, NEUROTICISM: 0.10, IMPULSIVITY: 0.07 },
    priority: { DISCIPLINE: 0.06, NEUROTICISM: 0.08 },
    relief: { PATIENCE: 0.10, DISCIPLINE: 0.08 }
  },
  SOCIAL_NEED: {
    decay: { EXTRAVERSION: 0.22, SOCIABILITY: 0.26, EMPATHY: 0.08, INDEPENDENCE: -0.18 },
    priority: { EXTRAVERSION: 0.18, SOCIABILITY: 0.22, INDEPENDENCE: -0.14 },
    relief: { EXTRAVERSION: 0.18, SOCIABILITY: 0.22, EMPATHY: 0.08 }
  },
  FUN: {
    decay: { OPENNESS: 0.16, EXTRAVERSION: 0.10, IMPULSIVITY: 0.16, CONSCIENTIOUSNESS: -0.10 },
    priority: { OPENNESS: 0.12, EXTRAVERSION: 0.10, IMPULSIVITY: 0.12 },
    relief: { OPENNESS: 0.14, IMPULSIVITY: 0.16 }
  },
  CURIOSITY: {
    decay: { CURIOSITY: 0.28, OPENNESS: 0.20, CREATIVITY: 0.14 },
    priority: { CURIOSITY: 0.28, OPENNESS: 0.18, CREATIVITY: 0.10 },
    relief: { CURIOSITY: 0.22, OPENNESS: 0.14, CREATIVITY: 0.10 }
  },
  ACHIEVEMENT: {
    decay: { CONSCIENTIOUSNESS: 0.24, DISCIPLINE: 0.25, CONFIDENCE: 0.10, PATIENCE: 0.08 },
    priority: { CONSCIENTIOUSNESS: 0.22, DISCIPLINE: 0.25, CONFIDENCE: 0.08 },
    relief: { CONSCIENTIOUSNESS: 0.20, DISCIPLINE: 0.22, PATIENCE: 0.08 }
  },
  BELONGING: {
    decay: { EMPATHY: 0.18, SOCIABILITY: 0.20, EXTRAVERSION: 0.12, INDEPENDENCE: -0.20 },
    priority: { EMPATHY: 0.16, SOCIABILITY: 0.20, INDEPENDENCE: -0.16 },
    relief: { EMPATHY: 0.18, SOCIABILITY: 0.20, EXTRAVERSION: 0.10 }
  }
});

const NEED_DEFAULT_TRAIT_OFFSETS = Object.freeze({
  HUNGER: { SELF_CARE: -0.035, IMPULSIVITY: 0.025 },
  THIRST: { SELF_CARE: -0.025, NEUROTICISM: 0.015 },
  SLEEPINESS: { DISCIPLINE: -0.025, PATIENCE: -0.020, NEUROTICISM: 0.030 },
  SOCIAL_NEED: { EXTRAVERSION: 0.055, SOCIABILITY: 0.065, INDEPENDENCE: -0.045 },
  FUN: { OPENNESS: 0.045, EXTRAVERSION: 0.030, IMPULSIVITY: 0.045, CONSCIENTIOUSNESS: -0.025 },
  CURIOSITY: { CURIOSITY: 0.080, OPENNESS: 0.055, CREATIVITY: 0.035 },
  ACHIEVEMENT: { CONSCIENTIOUSNESS: 0.065, DISCIPLINE: 0.070, CONFIDENCE: 0.025 },
  BELONGING: { EMPATHY: 0.050, SOCIABILITY: 0.055, EXTRAVERSION: 0.030, INDEPENDENCE: -0.050 }
});

const NEED_ACTIONS = Object.freeze({
  HUNGER: "EATING",
  THIRST: "DRINKING",
  SLEEPINESS: "SLEEPING",
  SOCIAL_NEED: "TALKING",
  BELONGING: "TALKING",
  FUN: "PLAYING",
  CURIOSITY: "EXPLORING",
  ACHIEVEMENT: "STUDYING"
});

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function traitScore(traits, weights) {
  return Object.entries(weights || {}).reduce((sum, [code, weight]) => {
    const value = clamp01(traits?.[code] ?? 0.5);
    return sum + (value - 0.5) * Number(weight || 0);
  }, 0);
}

function calculateTraitNeedModifiers(code, traits = {}) {
  const profile = NEED_PROFILES[normalize(code)] || {};
  const decay = clamp(1 + traitScore(traits, profile.decay), 0.72, 1.30);
  const priority = clamp(1 + traitScore(traits, profile.priority), 0.75, 1.30);
  const relief = clamp(1 + traitScore(traits, profile.relief), 0.72, 1.30);
  return { decay, priority, relief };
}

function calculateEnvironmentModifier(code, perception = {}) {
  const need = normalize(code);
  const location = perception?.location || {};
  const type = normalize(location.locationType);
  const environment = location.environment || {};
  const weather = normalize(environment.weather || "CLEAR");
  const nearbyCount = Array.isArray(perception?.nearby) ? perception.nearby.length : 0;

  let decay = 1;

  if (need === "THIRST") {
    if (weather === "HEAT") decay *= 1.18;
    else if (weather === "COLD") decay *= 0.96;
    if (Number(environment.temperature) >= 30) decay *= 1.08;
  }

  if (need === "SOCIAL_NEED" || need === "BELONGING") {
    decay *= 1 - Math.min(0.16, nearbyCount * 0.02);
    if (type === "CAFE" || type === "SQUARE" || type === "COMMUNITY") decay *= 0.90;
  }

  if (need === "FUN") {
    if (["PARK", "CAFE", "SQUARE", "GYM", "COMMUNITY"].includes(type)) decay *= 0.90;
    if (type === "HOME" || type === "LIBRARY") decay *= 1.04;
  }

  if (need === "CURIOSITY") {
    if (["LIBRARY", "NATURE", "WORKSHOP", "SCHOOL"].includes(type)) decay *= 0.88;
    if (type === "HOME") decay *= 1.03;
  }

  if (need === "ACHIEVEMENT") {
    if (["LIBRARY", "SCHOOL", "WORKSHOP"].includes(type)) decay *= 0.90;
  }

  return clamp(decay, 0.78, 1.25);
}

function calculateHistoryModifier(code, history = []) {
  const action = NEED_ACTIONS[normalize(code)];
  if (!action || !Array.isArray(history) || !history.length) {
    return { decay: 1, priority: 1, relief: 1 };
  }

  const relevant = history.filter(row => normalize(row.actionType) === action).slice(0, 12);
  if (!relevant.length) return { decay: 1, priority: 1, relief: 1 };

  let success = 0;
  let failure = 0;
  for (const row of relevant) {
    const outcome = normalize(row.outcome || row.result?.outcome || row.status);
    if (outcome === "SUCCESS" || outcome === "COMPLETED") success += 1;
    else if (outcome === "FAILURE" || outcome === "INTERRUPTED" || outcome === "CANCELLED" || outcome === "PARTIAL") failure += 1;
  }

  const observed = success + failure;
  if (!observed) return { decay: 1, priority: 1, relief: 1 };

  const balance = (success - failure) / observed;
  return {
    decay: clamp(1 - balance * 0.06, 0.92, 1.08),
    priority: clamp(1 - balance * 0.08, 0.90, 1.10),
    relief: clamp(1 + balance * 0.12, 0.88, 1.12)
  };
}

function calculateHabitModifier(code, habits = [], simulationTime = null) {
  const action = NEED_ACTIONS[normalize(code)];
  if (!action || !Array.isArray(habits) || !habits.length) {
    return { decay: 1, priority: 1, relief: 1 };
  }

  const now = new Date(simulationTime || 0);
  const hour = now.getUTCHours();
  const matching = habits
    .filter(habit => normalize(habit?.actionDefinition?.actionType) === action)
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))[0];

  if (!matching) return { decay: 1, priority: 1, relief: 1 };

  const strength = clamp01(matching.strength);
  const trigger = matching.triggerDefinition || {};
  const triggerHour = Number(trigger.hour);
  const tolerance = Math.max(1, Math.min(6, Number(trigger.toleranceHours) || 2));

  if (!Number.isFinite(triggerHour)) {
    return { decay: 1, priority: 1, relief: 1 };
  }

  const distance = Math.min(Math.abs(hour - triggerHour), 24 - Math.abs(hour - triggerHour));
  if (distance > tolerance) return { decay: 1, priority: 1, relief: 1 };

  return {
    decay: clamp(1 - strength * 0.18, 0.78, 1),
    priority: clamp(1 - strength * 0.12, 0.82, 1),
    relief: clamp(1 + strength * 0.20, 1, 1.20)
  };
}

function combineModifiers(trait, environment, history, habit) {
  return {
    decay: clamp(trait.decay * environment * history.decay * habit.decay, 0.62, 1.55),
    priority: clamp(trait.priority * history.priority * habit.priority, 0.65, 1.55),
    relief: clamp(trait.relief * history.relief * habit.relief, 0.60, 1.55)
  };
}

function personalizeNeedDefaults(defaultValue, code, traits = {}) {
  const offsets = NEED_DEFAULT_TRAIT_OFFSETS[normalize(code)] || {};
  const offset = traitScore(traits, offsets);
  return clamp01(Number(defaultValue) + offset);
}

async function loadNeedIndividualization(entityId, simulationTime, perception = null, db = pool) {
  const [[traitRows], [habitRows], [historyRows]] = await Promise.all([
    db.query(
      `SELECT td.code,etc.value
       FROM entity_traits_current etc
       JOIN trait_definitions td ON td.id=etc.trait_id
       WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,
      [entityId]
    ),
    db.query(
      `SELECT strength,trigger_definition AS triggerDefinition,action_definition AS actionDefinition
       FROM habits
       WHERE entity_id=UUID_TO_BIN(?) AND status IN ('ACTIVE','WEAKENING')
       ORDER BY strength DESC,updated_simulation_at DESC
       LIMIT 16`,
      [entityId]
    ),
    db.query(
      `SELECT action_type AS actionType,status,result
       FROM actions
       WHERE entity_id=UUID_TO_BIN(?)
         AND status IN ('COMPLETED','FAILED','INTERRUPTED','CANCELLED')
       ORDER BY COALESCE(completed_simulation_at,started_simulation_at) DESC
       LIMIT 24`,
      [entityId]
    )
  ]);

  const traits = Object.fromEntries(traitRows.map(row => [normalize(row.code), clamp01(row.value)]));
  const habits = habitRows.map(row => ({
    strength: Number(row.strength) || 0,
    triggerDefinition: typeof row.triggerDefinition === "object" ? row.triggerDefinition : safeJson(row.triggerDefinition, {}),
    actionDefinition: typeof row.actionDefinition === "object" ? row.actionDefinition : safeJson(row.actionDefinition, {})
  }));
  const history = historyRows.map(row => ({
    actionType: row.actionType,
    status: row.status,
    outcome: safeJson(row.result, {})?.outcome || null
  }));

  const result = new Map();
  for (const code of Object.keys(NEED_PROFILES)) {
    const trait = calculateTraitNeedModifiers(code, traits);
    const environment = calculateEnvironmentModifier(code, perception);
    const historyModifier = calculateHistoryModifier(code, history);
    const habit = calculateHabitModifier(code, habits, simulationTime);
    result.set(code, {
      ...combineModifiers(trait, environment, historyModifier, habit),
      sources: { trait, environment, history: historyModifier, habit }
    });
  }

  return result;
}

function safeJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function personalizeExistingNeedDefaults(entityId, simulationTime, db = pool) {
  const [[traits], [needs]] = await Promise.all([
    db.query(
      `SELECT td.code,etc.value
       FROM entity_traits_current etc
       JOIN trait_definitions td ON td.id=etc.trait_id
       WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,
      [entityId]
    ),
    db.query(
      `SELECT BIN_TO_UUID(enc.need_id) AS needId,nd.code,nd.default_value AS defaultValue,enc.value
       FROM entity_needs_current enc
       JOIN need_definitions nd ON nd.id=enc.need_id
       WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1`,
      [entityId]
    )
  ]);

  const traitMap = Object.fromEntries(traits.map(row => [normalize(row.code), clamp01(row.value)]));
  for (const need of needs) {
    const next = personalizeNeedDefaults(need.defaultValue, need.code, traitMap);
    const current = Number(need.value);
    if (Math.abs(current - Number(need.defaultValue)) > 0.000001) continue;
    if (Math.abs(current - next) < 0.000001) continue;
    await db.query(
      `UPDATE entity_needs_current
       SET value=?,updated_simulation_at=?,version=version+1
       WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?)`,
      [next, simulationTime, entityId, need.needId]
    );
  }
}

module.exports = {
  NEED_PROFILES,
  NEED_ACTIONS,
  calculateTraitNeedModifiers,
  calculateEnvironmentModifier,
  calculateHistoryModifier,
  calculateHabitModifier,
  combineModifiers,
  personalizeNeedDefaults,
  loadNeedIndividualization,
  personalizeExistingNeedDefaults
};
