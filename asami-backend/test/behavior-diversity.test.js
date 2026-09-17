const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyRecentActionPenalty,
  individualityBias,
  chooseStochasticCandidate,
  resolvePlanCommitment,
  deriveProactivity
} = require("../src/services/decision-service");
const { scoreAction, personalityActionBias } = require("../src/services/decision-rules");

test("recent-action penalty breaks short deterministic loops", () => {
  const candidates = [
    { action: "DRINKING", score: 2.00 },
    { action: "TALKING", score: 1.92 },
    { action: "EXPLORING", score: 1.70 }
  ];
  const ranked = applyRecentActionPenalty(candidates, ["TALKING", "DRINKING", "TALKING", "DRINKING"]);
  assert.notEqual(ranked[0].action, "TALKING");
  assert.ok(ranked.find(c => c.action === "EXPLORING").score > ranked.find(c => c.action === "DRINKING").score);
});

test("individuality is stable but differs between entities", () => {
  const a = individualityBias("00000000-0000-4000-8000-000000000001", "TALKING");
  const b = individualityBias("00000000-0000-4000-8000-000000000002", "TALKING");
  assert.notEqual(a, b);
  assert.equal(a, individualityBias("00000000-0000-4000-8000-000000000001", "TALKING"));
});

test("personality materially changes action utility", () => {
  const social = [
    { code: "EXTRAVERSION", value: .9 }, { code: "SOCIABILITY", value: .9 },
    { code: "EMPATHY", value: .8 }, { code: "CONFIDENCE", value: .75 },
    { code: "INDEPENDENCE", value: .25 }, { code: "AGREEABLENESS", value: .75 },
    { code: "NEUROTICISM", value: .2 }
  ];
  const studious = [
    { code: "CONSCIENTIOUSNESS", value: .9 }, { code: "DISCIPLINE", value: .95 },
    { code: "PATIENCE", value: .85 }, { code: "CURIOSITY", value: .8 }, { code: "IMPULSIVITY", value: .2 }
  ];
  const needs = [
    { code: "SOCIAL_NEED", value: .55, priorityWeight: 1 },
    { code: "BELONGING", value: .5, priorityWeight: 1 },
    { code: "ACHIEVEMENT", value: .5, priorityWeight: 1 },
    { code: "CURIOSITY", value: .5, priorityWeight: 1 },
    { code: "FUN", value: .5, priorityWeight: 1 }
  ];
  assert.ok(scoreAction("TALKING", needs, social) > scoreAction("TALKING", needs, studious));
  assert.ok(scoreAction("STUDYING", needs, studious) > scoreAction("STUDYING", needs, social));
  assert.notEqual(personalityActionBias("TALKING", social), personalityActionBias("TALKING", studious));
});

test("active plan commitment overrides ordinary alternatives", () => {
  const commitment = resolvePlanCommitment({
    needs: [
      { code: "SOCIAL_NEED", value: .42, priorityWeight: 1 },
      { code: "THIRST", value: .3, priorityWeight: 1 }
    ],
    candidates: [
      { action: "DRINKING", score: 2.2 },
      { action: "TALKING", score: 1.1 },
      { action: "EXPLORING", score: 1.0 }
    ],
    activePlanStep: { status: "ACTIVE", actionType: "TALKING", result: null }
  });
  assert.equal(commitment.action, "TALKING");
  assert.equal(commitment.candidate.action, "TALKING");
});

test("bounded stochastic choice can leave the deterministic top when options are close", () => {
  const choice = chooseStochasticCandidate([
    { action: "TALKING", score: 1.00 },
    { action: "EXPLORING", score: .98 },
    { action: "PLAYING", score: .96 }
  ], { temperature: .48, random: () => .999 });
  assert.equal(choice.action, "PLAYING");
});

test("internal pressure still produces proactive signals", () => {
  const result = deriveProactivity({
    needs: [{ code: "FUN", value: .61 }, { code: "CURIOSITY", value: .72 }],
    goals: []
  });
  assert.equal(result.mode, "PROACTIVE");
  assert.equal(result.priority, "HIGH");
  assert.ok(result.signals.some(signal => signal.type === "NEED"));
});
