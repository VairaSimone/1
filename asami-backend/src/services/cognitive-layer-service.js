const DEFAULT_LEVELS = Object.freeze({ CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 });
const REACTIVE_NEEDS = new Set(["HUNGER", "THIRST", "SLEEPINESS", "SAFETY"]);
const DELIBERATIVE_NEEDS = new Set(["SOCIAL_NEED", "BELONGING", "FUN", "CURIOSITY", "ACHIEVEMENT"]);

function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function needPriority(value) {
  const v = clamp01(value);
  if (v >= 0.85) return "CRITICAL";
  if (v >= 0.60) return "HIGH";
  if (v >= 0.35) return "MEDIUM";
  return "LOW";
}

function buildReactiveLayer(needs = []) {
  const items = (needs || [])
    .filter(need => REACTIVE_NEEDS.has(normalize(need.code)))
    .map(need => ({
      code: normalize(need.code),
      value: clamp01(need.value),
      level: needPriority(need.value),
      priorityWeight: Number(need.priorityWeight || 1)
    }))
    .sort((a, b) => DEFAULT_LEVELS[b.level] - DEFAULT_LEVELS[a.level] || b.value - a.value);

  const critical = items.find(item => item.level === "CRITICAL") || null;
  const high = items.find(item => item.level === "HIGH") || null;
  return {
    kind: "REACTIVE",
    blocking: Boolean(critical),
    priority: critical ? "CRITICAL" : high ? "HIGH" : items.length ? items[0].level : "LOW",
    topNeed: critical || high || items[0] || null,
    needs: items
  };
}

function buildDeliberativeLayer({ needs = [], goals = [], activePlanStep = null, memories = [], social = null } = {}) {
  const deliberativeNeeds = (needs || [])
    .filter(need => DELIBERATIVE_NEEDS.has(normalize(need.code)))
    .map(need => ({ code: normalize(need.code), value: clamp01(need.value), priorityWeight: Number(need.priorityWeight || 1) }))
    .sort((a, b) => (b.value * b.priorityWeight) - (a.value * a.priorityWeight));

  const activeGoal = (goals || [])
    .filter(goal => Number(goal.progress || 0) < 1)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;

  return {
    kind: "DELIBERATIVE",
    goal: activeGoal ? {
      id: activeGoal.id,
      title: activeGoal.title,
      priority: Number(activeGoal.priority || 0),
      progress: Number(activeGoal.progress || 0),
      motivation: Number(activeGoal.motivation || 0)
    } : null,
    activePlanStep: activePlanStep ? {
      id: activePlanStep.id,
      sequence: Number(activePlanStep.sequence || 0),
      title: activePlanStep.title,
      actionType: normalize(activePlanStep.result?.actionType || activePlanStep.actionType),
      status: normalize(activePlanStep.status)
    } : null,
    dominantNeeds: deliberativeNeeds.slice(0, 4),
    socialOpportunityCount: Array.isArray(social?.candidates) ? social.candidates.length : 0,
    memoryCount: Array.isArray(memories) ? memories.length : 0,
    objective: activeGoal ? "ADVANCE_GOAL" : deliberativeNeeds.length ? "REDUCE_DELIBERATIVE_PRESSURE" : "MAINTAIN_STATE"
  };
}

function getHabitAction(habit) {
  return normalize(habit?.actionDefinition?.actionType || habit?.actionType);
}

function habitTriggerMatch(habit, simulationTime) {
  const trigger = habit?.triggerDefinition || {};
  if (normalize(trigger.type) !== "TIME_WINDOW") return 0.5;
  const date = new Date(simulationTime);
  if (Number.isNaN(date.getTime())) return 0;
  const currentHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  const targetHour = Number(trigger.hour);
  if (!Number.isFinite(targetHour)) return 0;
  let distance = Math.abs(currentHour - targetHour);
  distance = Math.min(distance, 24 - distance);
  const tolerance = Math.max(0.25, Number(trigger.toleranceHours || 2));
  if (distance > tolerance) return 0;
  return 1 - distance / tolerance;
}

function buildHabitLayer({ habits = [], needs = [], simulationTime } = {}) {
  const reactive = buildReactiveLayer(needs);
  const candidates = (habits || [])
    .map(habit => {
      const triggerMatch = habitTriggerMatch(habit, simulationTime);
      const strength = clamp01(habit.strength);
      return { id: habit.id, name: habit.name, actionType: getHabitAction(habit), strength, triggerMatch, score: strength * triggerMatch };
    })
    .filter(candidate => candidate.actionType && candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = candidates[0] || null;
  return { kind: "HABIT", blockedByReactive: reactive.blocking, candidates, selected: reactive.blocking ? null : top && top.score >= 0.55 ? top : null };
}

function composeCognitiveLayers({ needs = [], goals = [], activePlanStep = null, memories = [], social = null, habits = [], simulationTime } = {}) {
  const reactive = buildReactiveLayer(needs);
  const deliberative = buildDeliberativeLayer({ needs, goals, activePlanStep, memories, social });
  const habit = buildHabitLayer({ habits, needs, simulationTime });
  return {
    reactive,
    deliberative,
    habit,
    precedence: ["REACTIVE", "DELIBERATIVE", "HABIT"],
    winner: reactive.blocking ? "REACTIVE" : habit.selected && !deliberative.goal ? "HABIT" : "DELIBERATIVE"
  };
}

function habitActionBonus(cognitiveLayers, actionType) {
  const selected = cognitiveLayers?.habit?.selected;
  if (!selected || normalize(selected.actionType) !== normalize(actionType)) return 0;
  return 0.18 * clamp01(selected.score);
}

function shouldBlockByReactive(cognitiveLayers, actionType) {
  const reactive = cognitiveLayers?.reactive;
  if (!reactive?.blocking) return false;
  const critical = reactive.topNeed?.code;
  const mapping = { HUNGER: "EATING", THIRST: "DRINKING", SLEEPINESS: "SLEEPING", SAFETY: "RESTING" };
  return Boolean(critical && mapping[critical] && normalize(actionType) !== mapping[critical]);
}

module.exports = { needPriority, buildReactiveLayer, buildDeliberativeLayer, buildHabitLayer, composeCognitiveLayers, habitActionBonus, shouldBlockByReactive };
