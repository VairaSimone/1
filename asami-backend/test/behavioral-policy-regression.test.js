const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STAGE_PROFILES,
  defaultAdultAgeYears,
  ageDateBefore,
  normalizeStageProfile,
  classifyBehavioralDriver,
  buildProactivity,
  habitMaturity
} = require("../src/services/behavioral-policy-bootstrap");

const baseContext = () => ({
  needs: [
    { code: "HUNGER", value: 0.2 },
    { code: "THIRST", value: 0.2 },
    { code: "SOCIAL_NEED", value: 0.1 },
    { code: "BELONGING", value: 0.1 },
    { code: "CURIOSITY", value: 0.1 }
  ],
  goals: [],
  social: { candidates: [] },
  candidates: [
    { action: "PLAYING", score: 0.8 },
    { action: "WALKING", score: 0.7 },
    { action: "READING", score: 0.6 }
  ],
  recentActions: ["WALKING"],
  cognitiveProfile: { mentalState: { certainty: 0.8, rumination: 0 } }
});

test("new simulations default Asami to an adult age", () => {
  assert.equal(defaultAdultAgeYears(), 25);
  const started = new Date("2030-01-01T00:00:00.000Z");
  const birth = ageDateBefore(started, 25);
  assert.equal(birth.toISOString(), "2005-01-01T00:00:00.000Z");
});

test("adult capability profile exposes the full action domain", () => {
  const adult = normalizeStageProfile("ADULT");
  assert.equal(adult.allowedActionTypes, "ALL");
  assert.equal(adult.languageLevel, 1);
  assert.equal(adult.socialAutonomy, 1);
  assert.equal(adult.memoryCapacity, 512);
  assert.equal(adult.decisionHorizon, 8);
  assert.equal(adult.actionDurationScale, 1);
  assert.ok(STAGE_PROFILES.INFANT.allowedActionTypes.includes("PLAYING"));
  assert.equal(STAGE_PROFILES.INFANT.allowedActionTypes.includes("WORKING"), false);
  assert.equal(STAGE_PROFILES.INFANT.allowedActionTypes.includes("STUDYING"), false);
});

test("critical physiological pressure is reactive and not proactive", () => {
  const context = { ...baseContext(), needs: [{ code: "THIRST", value: 0.95 }] };
  const classification = classifyBehavioralDriver(context);
  const proactivity = buildProactivity(context, "DRINKING");
  assert.equal(classification.driver, "REACTIVE");
  assert.equal(proactivity.mode, "REACTIVE");
  assert.equal(proactivity.isProactive, false);
});

test("goal-directed behavior requires a meaningful active goal", () => {
  const context = {
    ...baseContext(),
    goals: [{ id: "g1", title: "Finish project", priority: 0.9, progress: 0.3, motivation: 0.85 }],
    activePlanStep: { id: "s1", actionType: "READING", status: "ACTIVE" }
  };
  assert.equal(classifyBehavioralDriver(context).driver, "GOAL_DIRECTED");
});

test("exploration needs high curiosity and a genuinely novel opportunity", () => {
  const context = {
    ...baseContext(),
    needs: baseContext().needs.map(need => need.code === "CURIOSITY" ? { ...need, value: 0.88 } : need),
    explorationDestination: { locationId: "loc-2", novelty: 0.92, score: 1.1 }
  };
  assert.equal(classifyBehavioralDriver(context).driver, "EXPLORATORY");
  const proactivity = buildProactivity(context, "EXPLORING");
  assert.equal(proactivity.isProactive, true);
  assert.ok(proactivity.proactiveScore >= 0.7);
});

test("social initiation needs a real social opportunity and substantial social pressure", () => {
  const context = {
    ...baseContext(),
    needs: baseContext().needs.map(need => need.code === "SOCIAL_NEED" ? { ...need, value: 0.75 } : need),
    social: { candidates: [{ id: "person-1", familiarity: 0.2 }] }
  };
  assert.equal(classifyBehavioralDriver(context).driver, "SOCIAL_INITIATED");
});

test("habit maturity rejects short early repetitions", () => {
  const premature = habitMaturity({
    observations: 8,
    distinctDays: 7,
    spanDays: 7,
    maxGapDays: 2,
    timeConcentration: 0.9,
    contextConsistency: 0.9,
    rewardRate: 1,
    decisionDominance: 1
  });
  assert.equal(premature.mature, false);
  assert.ok(premature.reasons.includes("INSUFFICIENT_OBSERVATIONS"));
});

test("habit maturity requires temporal, contextual and reward stability", () => {
  const mature = habitMaturity({
    observations: 18,
    distinctDays: 11,
    spanDays: 16,
    maxGapDays: 3.5,
    timeConcentration: 0.82,
    contextConsistency: 0.75,
    rewardRate: 0.85,
    decisionDominance: 0.78
  });
  assert.equal(mature.mature, true);
});

test("ordinary arbitration remains deliberate without being mislabeled proactive", () => {
  const context = {
    ...baseContext(),
    candidates: [
      { action: "PLAYING", score: 0.9 },
      { action: "WALKING", score: 0.65 },
      { action: "READING", score: 0.4 }
    ]
  };
  const proactivity = buildProactivity(context, "PLAYING");
  assert.equal(proactivity.mode, "DELIBERATIVE");
  assert.equal(proactivity.isProactive, false);
});
