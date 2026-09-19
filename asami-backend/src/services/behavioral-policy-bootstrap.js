const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { criticalNeedState, CRITICAL_NEED_ACTIONS } = require("./decision-rules");

const PHYSIOLOGICAL_NEEDS = new Set(["HUNGER", "THIRST", "SLEEPINESS", "ENERGY", "SAFETY"]);
const PHYSIOLOGICAL_ACTIONS = new Set(["EATING", "DRINKING", "SLEEPING", "RESTING"]);
const HABIT_ELIGIBLE_ACTIONS = new Set([
  "TALKING", "PLAYING", "WALKING", "EXPLORING", "STUDYING", "READING", "WORKING", "WATCHING"
]);
const ALL_DRIVERS = Object.freeze([
  "REACTIVE",
  "GOAL_DIRECTED",
  "EXPLORATORY",
  "SOCIAL_INITIATED",
  "HABITUAL",
  "DELIBERATIVE"
]);

const STAGE_PROFILES = Object.freeze({
  NEWBORN: {
    aliases: ["NEWBORN"],
    allowedActionTypes: ["EATING", "DRINKING", "SLEEPING", "RESTING", "PLAYING", "WATCHING"],
    languageLevel: 0.08,
    socialAutonomy: 0.05,
    memoryCapacity: 32,
    decisionHorizon: 1,
    actionDurationScale: 0.55
  },
  INFANT: {
    aliases: ["INFANT", "BABY"],
    allowedActionTypes: ["EATING", "DRINKING", "SLEEPING", "RESTING", "PLAYING", "WATCHING"],
    languageLevel: 0.18,
    socialAutonomy: 0.10,
    memoryCapacity: 48,
    decisionHorizon: 1,
    actionDurationScale: 0.60
  },
  TODDLER: {
    aliases: ["TODDLER"],
    allowedActionTypes: ["EATING", "DRINKING", "SLEEPING", "RESTING", "PLAYING", "WATCHING", "WALKING", "TALKING", "EXPLORING"],
    languageLevel: 0.42,
    socialAutonomy: 0.28,
    memoryCapacity: 72,
    decisionHorizon: 2,
    actionDurationScale: 0.72
  },
  CHILD: {
    aliases: ["CHILD", "EARLY_CHILDHOOD", "MIDDLE_CHILDHOOD"],
    allowedActionTypes: ["EATING", "DRINKING", "SLEEPING", "RESTING", "PLAYING", "WATCHING", "WALKING", "TALKING", "EXPLORING", "READING", "STUDYING"],
    languageLevel: 0.72,
    socialAutonomy: 0.52,
    memoryCapacity: 128,
    decisionHorizon: 3,
    actionDurationScale: 0.84
  },
  ADOLESCENT: {
    aliases: ["ADOLESCENT", "TEEN", "TEENAGER"],
    allowedActionTypes: ["EATING", "DRINKING", "SLEEPING", "RESTING", "PLAYING", "WATCHING", "WALKING", "TALKING", "EXPLORING", "READING", "STUDYING", "WORKING"],
    languageLevel: 0.92,
    socialAutonomy: 0.78,
    memoryCapacity: 256,
    decisionHorizon: 5,
    actionDurationScale: 0.96
  },
  ADULT: {
    aliases: ["ADULT", "YOUNG_ADULT", "MATURE_ADULT"],
    allowedActionTypes: "ALL",
    languageLevel: 1,
    socialAutonomy: 1,
    memoryCapacity: 512,
    decisionHorizon: 8,
    actionDurationScale: 1
  },
  ELDER: {
    aliases: ["ELDER", "ELDERLY", "SENIOR"],
    allowedActionTypes: "ALL",
    languageLevel: 1,
    socialAutonomy: 0.92,
    memoryCapacity: 512,
    decisionHorizon: 7,
    actionDurationScale: 1
  }
});

let installed = false;

function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function defaultAdultAgeYears() {
  const configured = Number(process.env.ASAMI_DEFAULT_AGE_YEARS);
  return Number.isFinite(configured) && configured >= 18 && configured <= 90 ? configured : 25;
}

function ageDateBefore(startedSimulationAt, years) {
  const date = new Date(startedSimulationAt || Date.now());
  if (!Number.isFinite(date.getTime())) return new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date;
}

function inferStageCode(ageDays) {
  const age = Math.max(0, Number(ageDays) || 0);
  if (age < 0.5) return "NEWBORN";
  if (age < 730) return "INFANT";
  if (age < 1825) return "TODDLER";
  if (age < 4745) return "CHILD";
  if (age < 6575) return "ADOLESCENT";
  return "ADULT";
}

function normalizeStageProfile(stageCode, configuration = {}) {
  const normalizedStage = normalize(stageCode) || "ADULT";
  const profile = Object.values(STAGE_PROFILES).find(item => item.aliases.includes(normalizedStage)) || STAGE_PROFILES.ADULT;
  const config = parseJson(configuration, {});
  const capabilityConfig = config.capabilities && typeof config.capabilities === "object" ? config.capabilities : config;
  const configuredActions = Array.isArray(capabilityConfig.allowedActionTypes)
    ? capabilityConfig.allowedActionTypes.map(normalize).filter(Boolean)
    : null;
  const allowedActionTypes = configuredActions?.length
    ? configuredActions
    : profile.allowedActionTypes === "ALL" ? "ALL" : profile.allowedActionTypes.slice();

  return {
    stage: normalizedStage,
    allowedActionTypes,
    languageLevel: clamp(capabilityConfig.languageLevel ?? profile.languageLevel),
    socialAutonomy: clamp(capabilityConfig.socialAutonomy ?? profile.socialAutonomy),
    memoryCapacity: Math.max(16, Math.round(Number(capabilityConfig.memoryCapacity ?? profile.memoryCapacity))),
    decisionHorizon: Math.max(1, Math.round(Number(capabilityConfig.decisionHorizon ?? profile.decisionHorizon))),
    actionDurationScale: clamp(capabilityConfig.actionDurationScale ?? profile.actionDurationScale, 0.25, 1.5)
  };
}

async function loadDevelopmentProfile(simulationId, entityId, simulationTime) {
  const [personRows] = await pool.query(`
    SELECT p.birth_simulation_at AS birthSimulationAt,
           e.created_simulation_at AS createdSimulationAt
    FROM persons p
    JOIN entities e ON e.id=p.entity_id
    WHERE p.entity_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?)
    LIMIT 1
  `, [entityId, simulationId]);

  if (!personRows.length) return normalizeStageProfile("ADULT");

  const row = personRows[0];
  const birthAt = row.birthSimulationAt || row.createdSimulationAt || simulationTime;
  const ageDays = Math.max(0, (new Date(simulationTime).getTime() - new Date(birthAt).getTime()) / 86400000);

  const [stageRows] = await pool.query(`
    SELECT code,name,min_age_days AS minAge,max_age_days AS maxAge,configuration
    FROM development_stages
    WHERE active=1
      AND min_age_days<=?
      AND (max_age_days IS NULL OR max_age_days>?)
    ORDER BY min_age_days DESC
    LIMIT 1
  `, [ageDays, ageDays]);

  const stage = stageRows[0] || { code: inferStageCode(ageDays), name: inferStageCode(ageDays), configuration: {} };
  const profile = normalizeStageProfile(stage.code, stage.configuration);
  return {
    ...profile,
    name: stage.name || profile.stage,
    ageDays,
    birthSimulationAt: birthAt,
    ageYears: ageDays / 365.2425
  };
}

function allowedActionSet(profile, allActions) {
  const normalizedAll = (allActions || []).map(normalize);
  if (profile?.allowedActionTypes === "ALL") return new Set(normalizedAll);
  const configured = new Set((profile?.allowedActionTypes || []).map(normalize));
  return new Set(normalizedAll.filter(action => configured.has(action)));
}

function physiologicalPressure(needs = []) {
  const critical = criticalNeedState(needs);
  if (!critical) return null;
  const policy = CRITICAL_NEED_ACTIONS[normalize(critical.code)] || {};
  return { ...critical, direction: policy.direction || null };
}
function getNeedValue(needs, code) {
  return Number((needs || []).find(need => normalize(need.code) === normalize(code))?.value || 0);
}

function getGoal(context) {
  return (context?.goals || [])
    .filter(goal => Number(goal.progress || 0) < 0.98)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;
}

function matureHabitFromContext(context) {
  const candidates = [context?.behavioralHabit, ...(context?.cognitiveProfile?.habits || [])].filter(Boolean);
  return candidates
    .filter(habit => Number(habit.strength || 0) >= 0.68 && (habit.maturity?.mature !== false))
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))[0] || null;
}

function classifyBehavioralDriver(context = {}) {
  const critical = physiologicalPressure(context.needs);
  const goal = getGoal(context);
  const planAction = normalize(context.activePlanStep?.result?.actionType || context.activePlanStep?.actionType);
  const motivation = parseJson(goal?.motivation, {});
  const motivationPressure = Number(motivation?.pressure);
  const goalMotivation = Number.isFinite(motivationPressure)
    ? motivationPressure
    : Number(goal?.priority || 0);
  const goalQualified = Boolean(
    goal &&
    (planAction || (Number(goal.priority || 0) >= 0.7 && goalMotivation >= 0.35)) &&
    Number(goal.progress || 0) < 1 &&
    !["COMPLETED", "ABANDONED", "CANCELLED"].includes(normalize(goal.status))
  );

  const curiosity = getNeedValue(context.needs, "CURIOSITY");
  const exploration = context.explorationDestination;
  const exploratoryQualified = Boolean(
    !critical &&
    curiosity >= 0.68 &&
    exploration &&
    Number(exploration.novelty || 0) >= 0.78 &&
    Number(exploration.score || 0) >= 0.75
  );

  const socialNeed = Math.max(getNeedValue(context.needs, "SOCIAL_NEED"), getNeedValue(context.needs, "BELONGING"));
  const socialCandidates = Array.isArray(context.social?.candidates) ? context.social.candidates : [];
  const socialQualified = Boolean(
    !critical &&
    !goalQualified &&
    !exploratoryQualified &&
    socialNeed >= 0.62 &&
    socialCandidates.length > 0
  );

  const habit = matureHabitFromContext(context);
  const habitQualified = Boolean(!critical && !goalQualified && !exploratoryQualified && !socialQualified && habit);

  const certainty = Number(context.cognitiveProfile?.mentalState?.certainty ?? 0.65);
  const rumination = Number(context.cognitiveProfile?.mentalState?.rumination ?? 0);
  const candidates = Array.isArray(context.candidates) ? context.candidates : [];
  const margin = candidates.length > 1 ? Number(candidates[0]?.score || 0) - Number(candidates[1]?.score || 0) : 1;
  const deliberativeQualified = Boolean(
    context.geminiTrigger ||
    rumination >= 0.65 ||
    certainty <= 0.35 ||
    margin < 0.12
  );

  if (critical) return { driver: "REACTIVE", critical, habit: null, evidence: { criticalNeed: critical } };
  if (goalQualified) return { driver: "GOAL_DIRECTED", critical: null, habit: null, evidence: { goalId: goal.id, priority: Number(goal.priority || 0), planAction: planAction || null } };
  if (exploratoryQualified) return { driver: "EXPLORATORY", critical: null, habit: null, evidence: { novelty: Number(exploration.novelty || 0), score: Number(exploration.score || 0), curiosity } };
  if (socialQualified) return { driver: "SOCIAL_INITIATED", critical: null, habit: null, evidence: { socialNeed, candidateCount: socialCandidates.length } };
  if (habitQualified) return { driver: "HABITUAL", critical: null, habit, evidence: { habitId: habit.id || null, strength: Number(habit.strength || 0) } };
  return {
    driver: "DELIBERATIVE",
    critical: null,
    habit: null,
    evidence: { ambiguity: margin < 0.12, certainty, rumination, geminiTrigger: context.geminiTrigger?.type || null, deliberativeQualified }
  };
}

function buildProactivity(context, chosenAction = null) {
  const classification = classifyBehavioralDriver(context);
  const driver = classification.driver;
  const chosen = normalize(chosenAction || context.chosenAction || context.selectedActionType);
  const previous = normalize(context.recentActions?.[0]);
  const nonPhysiological = chosen ? !PHYSIOLOGICAL_ACTIONS.has(chosen) : false;
  const goalEvidence = driver === "GOAL_DIRECTED" && Boolean(chosen);
  const explorationEvidence = driver === "EXPLORATORY" && Boolean(chosen === "EXPLORING" || context.explorationDestination);
  const socialEvidence = driver === "SOCIAL_INITIATED" && chosen === "TALKING";
  const noveltyEvidence = driver === "SOCIAL_INITIATED" && Number(context.social?.candidates?.[0]?.familiarity || 0) < 0.35;
  const reflectionEvidence = driver === "DELIBERATIVE" && Boolean(context.geminiTrigger || classification.evidence?.ambiguity || classification.evidence?.rumination >= 0.65);
  const habitEvidence = driver === "HABITUAL" && Boolean(classification.habit);
  const proactiveScore = clamp(
    (goalEvidence ? 0.74 : 0) +
    (explorationEvidence ? 0.82 : 0) +
    (socialEvidence ? 0.68 : 0) +
    (noveltyEvidence ? 0.16 : 0) +
    (reflectionEvidence ? 0.58 : 0) +
    (habitEvidence ? 0.24 : 0)
  );
  const isProactive = driver !== "REACTIVE" && nonPhysiological && (
    goalEvidence || explorationEvidence || socialEvidence || noveltyEvidence || reflectionEvidence
  ) && chosen !== previous;

  const triggerMap = {
    REACTIVE: "CRITICAL_NEED",
    GOAL_DIRECTED: "INTERNAL_GOAL",
    EXPLORATORY: "NOVELTY_OPPORTUNITY",
    SOCIAL_INITIATED: "INTERNAL_SOCIAL_DRIVE",
    HABITUAL: "LEARNED_ROUTINE",
    DELIBERATIVE: "REFLECTION"
  };
  const priority = driver === "REACTIVE"
    ? "CRITICAL"
    : isProactive && proactiveScore >= 0.7
      ? "HIGH"
      : driver === "DELIBERATIVE"
        ? "MEDIUM"
        : "LOW";

  return {
    mode: driver,
    driver,
    isProactive,
    proactiveScore: Number(proactiveScore.toFixed(3)),
    priority,
    trigger: triggerMap[driver],
    signals: classification.evidence,
    chosenAction: chosen || null,
    previousAction: previous || null,
    autonomous: driver !== "REACTIVE"
  };
}

function circularHourStats(rows = []) {
  const hours = rows.map(row => {
    const date = new Date(row.startedAt);
    return date.getUTCHours() + date.getUTCMinutes() / 60;
  });
  if (!hours.length) return { concentration: 0, meanHour: null };
  const sin = hours.reduce((sum, hour) => sum + Math.sin(hour * Math.PI / 12), 0) / hours.length;
  const cos = hours.reduce((sum, hour) => sum + Math.cos(hour * Math.PI / 12), 0) / hours.length;
  const concentration = Math.sqrt(sin * sin + cos * cos);
  let mean = Math.atan2(sin, cos) * 12 / Math.PI;
  if (mean < 0) mean += 24;
  return { concentration, meanHour: mean };
}

function habitMaturity(evidence) {
  if (!evidence || Number(evidence.observations || 0) < 12) {
    return { mature: false, reasons: ["INSUFFICIENT_OBSERVATIONS"] };
  }

  const reasons = [];
  const observations = Number(evidence.observations || 0);
  const distinctDays = Number(evidence.distinctDays || 0);
  const spanDays = Number(evidence.spanDays || 0);
  const maxGapDays = Number(evidence.maxGapDays || 0);
  const timeConcentration = Number(evidence.timeConcentration || 0);
  const contextConsistency = Number(evidence.contextConsistency || 0);
  const rewardRate = Number(evidence.rewardRate || 0);
  const decisionDominance = Number(evidence.decisionDominance || 0);

  if (distinctDays < 4) reasons.push("INSUFFICIENT_DISTINCT_DAYS");
  if (spanDays < 2) reasons.push("INSUFFICIENT_TEMPORAL_SPAN");
  if (maxGapDays > 6) reasons.push("TEMPORALLY_UNSTABLE");

  // A routine can be stable because of time OR because of place.
  // Requiring both was too strict for naturally variable behavior.
  const patternConsistency = Math.max(timeConcentration, contextConsistency);
  if (patternConsistency < 0.55) reasons.push("PATTERN_CONTEXT_UNSTABLE");

  if (rewardRate < 0.65) reasons.push("WEAK_REWARD_SIGNAL");
  if (decisionDominance < 0.55) reasons.push("BETTER_ALTERNATIVES_EXIST");

  return {
    mature: reasons.length === 0,
    reasons,
    patternConsistency
  };
}

async function loadHabitEvidence({ simulationId, entityId, simulationTime, actionType }) {
  const action = normalize(actionType);
  if (!HABIT_ELIGIBLE_ACTIONS.has(action)) return null;
  const [rows] = await pool.query(`
    SELECT a.started_simulation_at AS startedAt,
           a.result,
           BIN_TO_UUID(a.decision_id) AS decisionId,
           (
             SELECT BIN_TO_UUID(h.location_id)
             FROM entity_location_history h
             WHERE h.simulation_id=a.simulation_id
               AND h.entity_id=a.entity_id
               AND h.entered_simulation_at<=a.started_simulation_at
             ORDER BY h.entered_simulation_at DESC
             LIMIT 1
           ) AS contextLocationId
    FROM actions a
    WHERE a.simulation_id=UUID_TO_BIN(?)
      AND a.entity_id=UUID_TO_BIN(?)
      AND a.action_type=?
      AND a.status='COMPLETED'
      AND a.started_simulation_at>=DATE_SUB(?,INTERVAL 30 DAY)
    ORDER BY a.started_simulation_at DESC
    LIMIT 40
  `, [simulationId, entityId, action, simulationTime]);

  if (!rows.length) return null;
  const decisionIds = [...new Set(rows.map(row => row.decisionId).filter(Boolean))];
  const optionRows = decisionIds.length
    ? (await pool.query(`
        SELECT BIN_TO_UUID(decision_id) AS decisionId,
               BIN_TO_UUID(id) AS optionId,
               option_code AS optionCode,
               evaluation
        FROM decision_options
        WHERE decision_id IN (${decisionIds.map(() => "UUID_TO_BIN(?)").join(",")})
      `, decisionIds))[0]
    : [];
  const optionsByDecision = new Map();
  for (const row of optionRows) {
    const list = optionsByDecision.get(row.decisionId) || [];
    list.push({
      id: row.optionId,
      code: normalize(row.optionCode),
      evaluation: parseJson(row.evaluation, {})
    });
    optionsByDecision.set(row.decisionId, list);
  }

  const observations = rows.map(row => {
    const result = parseJson(row.result, {}) || {};
    const outcome = normalize(result.outcome || "SUCCESS");
    const reward = outcome === "SUCCESS" ? 1 : outcome === "PARTIAL" ? 0.5 : 0;
    const options = optionsByDecision.get(row.decisionId) || [];
    const selected = options.find(option => option.code === action) || options.find(option => option.evaluation?.selected === true);
    const selectedScore = Number(selected?.evaluation?.score);
    const bestScore = options.reduce((best, option) => Math.max(best, Number(option.evaluation?.score ?? -Infinity)), -Infinity);
    const dominated = !Number.isFinite(selectedScore) || !Number.isFinite(bestScore) ? null : selectedScore >= bestScore - 0.02;
    return {
      startedAt: row.startedAt,
      contextLocationId: row.contextLocationId || null,
      reward,
      dominated
    };
  });

  const distinctDays = new Set(observations.map(item => new Date(item.startedAt).toISOString().slice(0, 10))).size;
  const ordered = observations.slice().sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const spanDays = ordered.length > 1 ? (new Date(ordered[ordered.length - 1].startedAt) - new Date(ordered[0].startedAt)) / 86400000 : 0;
  let maxGapDays = 0;
  for (let i = 1; i < ordered.length; i++) {
    maxGapDays = Math.max(maxGapDays, (new Date(ordered[i].startedAt) - new Date(ordered[i - 1].startedAt)) / 86400000);
  }
  const { concentration: timeConcentration, meanHour } = circularHourStats(observations);
  const located = observations.filter(item => item.contextLocationId);
  const locationCounts = new Map();
  for (const item of located) locationCounts.set(item.contextLocationId, (locationCounts.get(item.contextLocationId) || 0) + 1);
  const dominantLocationCount = Math.max(0, ...locationCounts.values());
  const contextConsistency = located.length ? dominantLocationCount / located.length : 0;
  const rewardRate = observations.reduce((sum, item) => sum + item.reward, 0) / observations.length;
  const decisionRows = observations.filter(item => item.dominated !== null);
  const decisionDominance = decisionRows.length ? decisionRows.filter(item => item.dominated).length / decisionRows.length : 0;
  const maturity = habitMaturity({
    observations: observations.length,
    distinctDays,
    spanDays,
    maxGapDays,
    timeConcentration,
    contextConsistency,
    rewardRate,
    decisionDominance
  });

  return {
    observations: observations.length,
    distinctDays,
    spanDays,
    maxGapDays,
    timeConcentration,
    contextConsistency,
    rewardRate,
    decisionDominance,
    meanHour,
    dominantLocationId: [...locationCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    maturity
  };
}

function habitStrengthFromEvidence(evidence = {}) {
  const rawStrength =
    0.42 +
    Math.min(0.10, Math.max(0, Number(evidence.observations || 0) - 12) * 0.008) +
    Number(evidence.rewardRate || 0) * 0.10 +
    Number(evidence.decisionDominance || 0) * 0.08 +
    Math.max(Number(evidence.timeConcentration || 0), Number(evidence.contextConsistency || 0)) * 0.06;

  // A matured habit must cross the same activation gate used by the
  // HABITUAL driver; otherwise it is created and immediately ignored.
  return clamp(Math.max(0.70, rawStrength), 0, 0.86);
}

async function recordMatureHabit({ simulationId, entityId, simulationTime, actionType, evidence, development }) {
  const action = normalize(actionType);
  const maturity = evidence.maturity;
  if (!maturity?.mature || !HABIT_ELIGIBLE_ACTIONS.has(action)) return null;
  if (development && !allowedActionSet(development, [action]).has(action)) return null;

  const name = `${action.replaceAll("_", " ").toLowerCase()} routine`;
  const hour = Math.round(Number(evidence.meanHour || 0)) % 24;
  const triggerDefinition = {
    type: "TIME_WINDOW",
    hour,
    toleranceHours: 1.5,
    contextLocationId: evidence.dominantLocationId,
    maturity: {
      mature: true,
      observations: evidence.observations,
      distinctDays: evidence.distinctDays,
      spanDays: Number(evidence.spanDays.toFixed(2)),
      rewardRate: Number(evidence.rewardRate.toFixed(3)),
      decisionDominance: Number(evidence.decisionDominance.toFixed(3)),
      contextConsistency: Number(evidence.contextConsistency.toFixed(3)),
      timeConcentration: Number(evidence.timeConcentration.toFixed(3)),
      patternConsistency: Number(Math.max(evidence.timeConcentration, evidence.contextConsistency).toFixed(3))
    }
  };
  const actionDefinition = { actionType: action };
  const computedStrength = habitStrengthFromEvidence(evidence);
  const frequency = `${evidence.observations} repetitions across ${evidence.distinctDays} days with stable timing and context`;

  const [existing] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,strength,version
    FROM habits
    WHERE entity_id=UUID_TO_BIN(?)
      AND name=?
      AND status IN ('ACTIVE','WEAKENING')
    LIMIT 1
  `, [entityId, name]);

  if (!existing.length) {
    const id = uuid();
    await pool.query(`
      INSERT INTO habits
        (id,entity_id,name,description,strength,frequency,trigger_definition,action_definition,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?, 'ACTIVE',?,?,1)
    `, [
      id,
      entityId,
      name,
      "A learned routine supported by repeated outcomes, stable context and repeated selection over alternatives.",
      computedStrength,
      frequency,
      JSON.stringify(triggerDefinition),
      JSON.stringify(actionDefinition),
      simulationTime,
      simulationTime
    ]);
    return id;
  }

  const habit = existing[0];
  const nextStrength = Math.min(0.86, Math.max(Number(habit.strength), computedStrength) + 0.008);
  const [updated] = await pool.query(`
    UPDATE habits
    SET strength=?,frequency=?,trigger_definition=?,action_definition=?,status='ACTIVE',updated_simulation_at=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=?
  `, [
    nextStrength,
    frequency,
    JSON.stringify(triggerDefinition),
    JSON.stringify(actionDefinition),
    simulationTime,
    habit.id,
    habit.version
  ]);
  return updated.affectedRows ? habit.id : null;
}

async function weakenPrematureHabit(entityId, actionType) {
  const action = normalize(actionType);
  const name = `${action.replaceAll("_", " ").toLowerCase()} routine`;
  await pool.query(`
    UPDATE habits
    SET strength=LEAST(strength,0.34),status='WEAKENING',version=version+1
    WHERE entity_id=UUID_TO_BIN(?)
      AND name=?
      AND status='ACTIVE'
  `, [entityId, name]);
}

function applyDriverPolicy(context, classification, development) {
  const next = {
    ...context,
    candidates: (context.candidates || []).map(candidate => ({ ...candidate }))
  };
  next.behavioralDriver = classification.driver;
  next.development = development;
  next.decisionHorizon = development?.decisionHorizon || 1;

  // An active plan is a commitment, not just another scoring signal.
  // Keep it in the decision context unless a higher-priority critical need
  // explicitly overrides it. Dropping the step here caused WALKING/EATING
  // plans to lose their EATING step after the first movement completed.
  if (classification.driver !== "GOAL_DIRECTED" && !context.activePlanStep) delete next.activePlanStep;
  if (classification.driver !== "EXPLORATORY") delete next.explorationDestination;

  const candidates = next.candidates;
  if (classification.driver === "SOCIAL_INITIATED") {
    for (const candidate of candidates) {
      if (normalize(candidate.action) === "TALKING") candidate.score = Number(candidate.score || 0) + 0.18;
    }
  }
  if (classification.driver === "HABITUAL" && classification.habit) {
    const action = normalize(classification.habit.actionDefinition?.actionType || classification.habit.actionType);
    for (const candidate of candidates) {
      if (normalize(candidate.action) === action) {
        candidate.score = Number(candidate.score || 0) + Math.min(0.24, 0.12 + Number(classification.habit.strength || 0) * 0.12);
        candidate.habitCommitted = true;
      }
    }
  }
  return next;
}

async function persistBehavioralDecision(decisionId, context, result) {
  if (!decisionId) return;
  const proactivity = buildProactivity(context, result?.actionType);
  const { compactDecisionContext } = require("./decision-service");
  const updatedContext = compactDecisionContext({
    ...context,
    behavioralDriver: proactivity.driver,
    proactivity,
    chosenAction: result?.actionType || null
  });
  await pool.query(`
    UPDATE decisions
    SET trigger_type=?,context=?
    WHERE id=UUID_TO_BIN(?)
  `, [proactivity.trigger, JSON.stringify(updatedContext), decisionId]);

  const [rows] = await pool.query(`
    SELECT selected_option_id AS selectedOptionId
    FROM decisions
    WHERE id=UUID_TO_BIN(?)
    LIMIT 1
  `, [decisionId]);
  const selectedOptionId = rows[0]?.selectedOptionId;
  if (!selectedOptionId) return;
  await pool.query(`
    UPDATE decision_options
    SET evaluation=JSON_SET(COALESCE(evaluation,JSON_OBJECT()),'$.behavioralDriver',?,'$.proactivity',CAST(? AS JSON))
    WHERE id=UUID_TO_BIN(?)
  `, [proactivity.driver, JSON.stringify(proactivity), selectedOptionId]);
}

function patchPlanProposal(aiChoice, decisionHorizon) {
  if (!aiChoice?.planProposal || !Array.isArray(aiChoice.planProposal.steps)) return aiChoice;
  return {
    ...aiChoice,
    planProposal: {
      ...aiChoice.planProposal,
      steps: aiChoice.planProposal.steps.slice(0, Math.max(1, Number(decisionHorizon || 1)))
    }
  };
}

async function installDevelopmentAndDecisionGate(decisionService) {
  const originalBuildDecisionContext = decisionService.buildDecisionContext;
  const originalMakeDecision = decisionService.makeDecision;

  decisionService.buildDecisionContext = async function enhancedBuildDecisionContext(simulationId, entityId, simulationTime) {
    const context = await originalBuildDecisionContext(simulationId, entityId, simulationTime);
    const development = await loadDevelopmentProfile(simulationId, entityId, simulationTime || context.simulationTime || new Date());
    const actionSet = allowedActionSet(development, context.allowedActionTypes || []);
    let candidates = (context.candidates || []).filter(candidate => actionSet.has(normalize(candidate.action)));

    if (!candidates.length) {
      const fallback = ["RESTING", "SLEEPING", "DRINKING", "EATING"].find(action => actionSet.has(action));
      if (fallback) candidates = [{ action: fallback, score: 0 }];
    }

    context.allowedActionTypes = [...actionSet];
    context.candidates = candidates;
    context.development = development;
    context.decisionHorizon = development.decisionHorizon;
    context.capabilityGate = {
      stage: development.stage,
      ageDays: Number(development.ageDays || 0),
      allowedActionTypes: [...actionSet],
      languageLevel: development.languageLevel,
      socialAutonomy: development.socialAutonomy,
      memoryCapacity: development.memoryCapacity,
      decisionHorizon: development.decisionHorizon,
      actionDurationScale: development.actionDurationScale
    };

    if (Array.isArray(context.cognitiveProfile?.habits)) {
      context.cognitiveProfile = {
        ...context.cognitiveProfile,
        habits: context.cognitiveProfile.habits.filter(habit => {
          const action = normalize(habit.actionDefinition?.actionType || habit.actionType);
          const maturity = habit.triggerDefinition?.maturity;
          return actionSet.has(action) && Number(habit.strength || 0) >= 0.68 && maturity?.mature === true;
        })
      };
    }

    return context;
  };

  decisionService.makeDecision = async function enhancedBehavioralDecision(args = {}) {
    const context = { ...(args.context || {}) };
    const development = context.development || await loadDevelopmentProfile(args.simulationId, args.entityId, args.simulationTime);
    const classification = classifyBehavioralDriver(context);
    const policyContext = applyDriverPolicy(context, classification, development);
    const patchedAiChoice = patchPlanProposal(args.aiChoice, development.decisionHorizon);
    const result = await originalMakeDecision({ ...args, context: policyContext, aiChoice: patchedAiChoice });

    const finalContext = {
      ...policyContext,
      development,
      behavioralDriver: classification.driver
    };
    const proactivity = buildProactivity(finalContext, result?.actionType);
    const finalResult = {
      ...result,
      behavioralDriver: proactivity.driver,
      proactivity,
      development: {
        stage: development.stage,
        ageDays: Number(development.ageDays || 0),
        decisionHorizon: development.decisionHorizon
      }
    };

    await persistBehavioralDecision(result?.decisionId, finalContext, finalResult);
    return finalResult;
  };
}

async function installHabitGate(habitService) {
  habitService.recordHabitEvidence = async function recordMatureHabitEvidence(args = {}) {
    const action = normalize(args.actionType);
    if (!HABIT_ELIGIBLE_ACTIONS.has(action)) return null;

    const development = await loadDevelopmentProfile(args.simulationId, args.entityId, args.simulationTime);
    if (!allowedActionSet(development, [action]).has(action)) return null;

    const evidence = await loadHabitEvidence(args);
    if (!evidence) return null;
    if (!evidence.maturity?.mature) {
      await weakenPrematureHabit(args.entityId, action);
      return null;
    }

    return recordMatureHabit({ ...args, development, evidence });
  };
}

function install() {
  if (installed) return;
  const decisionService = require("./decision-service");
  const habitService = require("./habit-service");
  const simulationRepo = require("../repositories/simulation-repo");

  const originalCreateSimulation = simulationRepo.createSimulation;
  simulationRepo.createSimulation = async function createAdultAsamiSimulation(args = {}) {
    const asami = { ...(args.asami || {}) };
    if (!asami.birthSimulationAt) {
      const startedAt = args.startedSimulationAt || new Date();
      asami.birthSimulationAt = ageDateBefore(startedAt, defaultAdultAgeYears());
      asami.attributes = {
        ...(asami.attributes || {}),
        lifecycle: {
          ...(asami.attributes?.lifecycle || {}),
          defaultAgeYears: defaultAdultAgeYears(),
          agePolicy: "ADULT_BY_DEFAULT"
        }
      };
    }
    return originalCreateSimulation({ ...args, asami });
  };

  installDevelopmentAndDecisionGate(decisionService).catch(error => {
    setImmediate(() => { throw error; });
  });
  installHabitGate(habitService).catch(error => {
    setImmediate(() => { throw error; });
  });

  installed = true;
}

// Exported for deterministic regression tests; production uses it through the habit gate.
module.exports = {
  install,
  ALL_DRIVERS,
  STAGE_PROFILES,
  defaultAdultAgeYears,
  ageDateBefore,
  inferStageCode,
  normalizeStageProfile,
  classifyBehavioralDriver,
  buildProactivity,
  physiologicalPressure,
  circularHourStats,
  habitMaturity,
  habitStrengthFromEvidence
};
