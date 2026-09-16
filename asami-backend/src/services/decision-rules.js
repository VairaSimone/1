const ACTIONS = [
  "SLEEPING",
  "EATING",
  "DRINKING",
  "TALKING",
  "PLAYING",
  "RESTING",
  "STUDYING",
  "READING",
  "EXPLORING",
  "WALKING",
  "WORKING",
  "WATCHING"
];

const actionNeeds = {
  EATING: { HUNGER: 2.4 },
  DRINKING: { THIRST: 2.8 },
  TALKING: { SOCIAL_NEED: 1.8, BELONGING: 1.1 },
  PLAYING: { FUN: 1.6 },
  STUDYING: { ACHIEVEMENT: 0.9, CURIOSITY: 0.5 },
  READING: { CURIOSITY: 0.8, ACHIEVEMENT: 0.3 },
  EXPLORING: { CURIOSITY: 1.4 },
  WALKING: { FUN: 0.3, CURIOSITY: 0.3 },
  WORKING: { ACHIEVEMENT: 1.0 },
  WATCHING: { FUN: 0.9 }
};

const actionNeedGates = {
  EATING: ["HUNGER", 0.15],
  DRINKING: ["THIRST", 0.25],
  TALKING: ["SOCIAL_NEED", 0.12],
  PLAYING: ["FUN", 0.18],
  STUDYING: ["ACHIEVEMENT", 0.18],
  READING: ["CURIOSITY", 0.18],
  EXPLORING: ["CURIOSITY", 0.18],
  WORKING: ["ACHIEVEMENT", 0.20]
};

const CRITICAL_NEED_ACTIONS = {
  THIRST: { action: "DRINKING", threshold: 0.80, maxBoost: 1.60, resource: "water" },
  HUNGER: { action: "EATING", threshold: 0.80, maxBoost: 1.40, resource: "food" },
  SLEEPINESS: { action: "SLEEPING", threshold: 0.85, maxBoost: 1.50 }
};

const RESOURCE_REQUIREMENTS = {
  EATING: { resource: "food", amount: 1 },
  DRINKING: { resource: "water", amount: 1 }
};

function needValue(needs, code) {
  const need = needs.find(item => item.code === code);
  return need ? Number(need.value) : 0;
}

function needWeight(needs, code) {
  const need = needs.find(item => item.code === code);
  return Number(need?.priorityWeight || 1);
}

function resourceModifier(action, resourceContext = {}) {
  const requirement = RESOURCE_REQUIREMENTS[action];
  if (!requirement) return 0;

  const localResources = resourceContext.localResources || {};
  const available = Number(localResources[requirement.resource] ?? 0);
  const localBlocked = Boolean(resourceContext.blockedResources?.[requirement.resource]);

  if (available >= requirement.amount) {
    return localBlocked ? -0.2 : 0.08;
  }

  const nearest = resourceContext.nearestResources?.[requirement.resource];
  if (!nearest) return -1.25;

  const travelMinutes = Number(nearest.travelMinutes);
  const finiteTravel = Number.isFinite(travelMinutes) ? travelMinutes : 60;
  const travelPenalty = Math.min(0.55, Math.max(0.05, finiteTravel / 60 * 0.45));
  const knowledgePenalty = localBlocked ? 0.35 : 0;
  return -0.55 - travelPenalty - knowledgePenalty;
}

function criticalNeedModifier(action, needs, resourceContext = {}) {
  for (const [code, policy] of Object.entries(CRITICAL_NEED_ACTIONS)) {
    if (policy.action !== action) continue;

    const value = needValue(needs, code);
    if (!Number.isFinite(value) || value <= policy.threshold) return 0;

    if (policy.resource) {
      const required = RESOURCE_REQUIREMENTS[action];
      const available = Number(resourceContext.localResources?.[policy.resource] ?? 0);
      if (!required || available < required.amount) return 0;
    }

    const urgency = Math.min(1, (value - policy.threshold) / (1 - policy.threshold));
    const shapedUrgency = urgency * urgency;
    return shapedUrgency * policy.maxBoost * needWeight(needs, code);
  }

  return 0;
}

function scoreAction(action, needs, traits, resourceContext = {}) {
  const gate = actionNeedGates[action];
  const gatedNeed = gate ? needValue(needs, gate[0]) : null;
  if (gate && gatedNeed < gate[1]) return 0;

  let score = 0;

  if (action === "SLEEPING") {
    const sleepiness = needValue(needs, "SLEEPINESS");
    const energy = needValue(needs, "ENERGY");
    score += sleepiness * 2.0 * needWeight(needs, "SLEEPINESS");
    score += (1 - energy) * 1.4 * needWeight(needs, "ENERGY");
    if (sleepiness < 0.18 && energy > 0.72) score *= 0.15;
  } else if (action === "RESTING") {
    const energy = needValue(needs, "ENERGY");
    const comfort = needValue(needs, "COMFORT");
    if (energy >= 0.72 && comfort < 0.65) {
      score = 0;
    } else {
      score += Math.max(0, 1 - energy) * needWeight(needs, "ENERGY");
      score += Math.max(0, 0.65 - comfort) * 0.7 * needWeight(needs, "COMFORT");
      if (energy >= 0.82) score *= 0.25;
      else if (energy >= 0.72) score *= 0.5;
    }
  } else {
    for (const [code, weight] of Object.entries(actionNeeds[action] || {})) {
      score += needValue(needs, code) * weight * needWeight(needs, code);
    }
  }

  const traitMap = new Map(traits.map(item => [item.code, Number(item.value)]));
  if (action === "TALKING") {
    score += ((traitMap.get("EXTRAVERSION") || 0.5) + (traitMap.get("SOCIABILITY") || 0.5)) * 0.2;
  }
  if (action === "EXPLORING") {
    score += ((traitMap.get("OPENNESS") || 0.5) + (traitMap.get("CURIOSITY") || 0.5)) * 0.2;
  }
  if (action === "STUDYING") {
    score += ((traitMap.get("CONSCIENTIOUSNESS") || 0.5) + (traitMap.get("DISCIPLINE") || 0.5)) * 0.2;
  }
  if (action === "PLAYING") {
    score += (1 - (traitMap.get("NEUROTICISM") || 0.5)) * 0.1;
  }
  if (action === "WORKING") {
    score += (traitMap.get("CONSCIENTIOUSNESS") || 0.5) * 0.25;
  }

  score += criticalNeedModifier(action, needs, resourceContext);
  return score + resourceModifier(action, resourceContext);
}

module.exports = { ACTIONS, scoreAction, RESOURCE_REQUIREMENTS, criticalNeedModifier };
