const test = require("node:test");
const assert = require("node:assert/strict");
const { emotionAppraisal } = require("../src/services/state-service");
const { chooseSocialTargetCandidate, applySocialFeasibility } = require("../src/services/decision-service");
const socialService = require("../src/services/social-relationship-service");

test("routine success is emotionally neutral when it creates no meaningful relief", () => {
  const result = emotionAppraisal("WALKING", [
    { code: "HUNGER", new: 0.22, delta: 0 },
    { code: "THIRST", new: 0.18, delta: 0 },
    { code: "SLEEPINESS", new: 0.12, delta: 0 }
  ], { event: true, outcome: "SUCCESS", expectedOutcome: { outcome: "SUCCESS" } });

  assert.equal(result.JOY, 0);
  assert.equal(result.CALM, 0);
});

test("high physiological pressure suppresses positive affect even after success", () => {
  const result = emotionAppraisal("WALKING", [
    { code: "HUNGER", new: 0.80, delta: 0.10 },
    { code: "THIRST", new: 0.90, delta: 0.10 },
    { code: "SLEEPINESS", new: 0.10, delta: 0 }
  ], { event: true, outcome: "SUCCESS", expectedOutcome: { outcome: "SUCCESS" } });

  assert.ok(result.JOY < 0);
  assert.ok(result.CALM < 0);
});

test("social feasibility removes abstract talking when nobody is available", () => {
  const noTarget = applySocialFeasibility([
    { action: "TALKING", score: 1.2 },
    { action: "WALKING", score: 0.8 }
  ], { social: { candidates: [] } }, "entity-a");

  const talking = noTarget.find(candidate => candidate.action === "TALKING");
  assert.equal(talking.score, 0);
  assert.equal(talking.socialUnavailable, true);
});

test("social feasibility attaches a real target and prefers a known compatible person", () => {
  const context = {
    social: {
      candidates: [
        { id: "person-a", name: "Sara", familiarity: 0.70, closeness: 0.50, affection: 0.45, trust: 0.60, compatibility: 0.90, romanticScore: 0.20 },
        { id: "person-b", name: "Luca", familiarity: 0.05, closeness: 0.05, affection: 0.02, trust: 0.10, compatibility: 0.40, romanticScore: 0.10 }
      ]
    }
  };

  const target = chooseSocialTargetCandidate(context, "entity-a");
  assert.equal(target.id, "person-a");

  const candidates = applySocialFeasibility([
    { action: "TALKING", score: 1.0 },
    { action: "WALKING", score: 0.6 }
  ], context, "entity-a");
  const talking = candidates.find(candidate => candidate.action === "TALKING");
  assert.equal(talking.targetEntityId, "person-a");
  assert.equal(talking.targetName, "Sara");
  assert.equal(talking.socialTarget, true);
});

test("social service exposes autonomous interaction processing", () => {
  assert.equal(typeof socialService.processSocialInteraction, "function");
});
