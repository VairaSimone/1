const test = require("node:test");
const assert = require("node:assert/strict");

const behavioral = require("../src/services/behavioral-policy-bootstrap");
const decision = require("../src/services/decision-service");
const queue = require("../src/services/cognitive-queue");


test("critical thirst hard-forces drinking even when sleeping has the highest score", () => {
  const recovery = decision.resolveCriticalResourceRecovery({
    needs: [
      { code: "THIRST", value: 0.95, priorityWeight: 1 },
      { code: "SLEEPINESS", value: 0.99, priorityWeight: 1 }
    ],
    resourceContext: {
      localResources: { water: 3 },
      actions: { DRINKING: { localAvailable: 3 } }
    },
    candidates: [
      { action: "SLEEPING", score: 8 },
      { action: "DRINKING", score: 1 },
      { action: "WALKING", score: 2 }
    ]
  });

  assert.equal(recovery.selectedAction, "DRINKING");
  assert.equal(recovery.mode, "DIRECT");
  assert.equal(recovery.candidate.action, "DRINKING");
});

test("critical hunger routes walking to a known resource when food is not local", () => {
  const recovery = decision.resolveCriticalResourceRecovery({
    needs: [{ code: "HUNGER", value: 0.92, priorityWeight: 1 }],
    resourceContext: {
      localResources: { food: 0 },
      actions: {
        EATING: {
          localAvailable: 0,
          nearestLocation: {
            locationId: "food-market",
            travelMinutes: 7
          }
        }
      },
      nearestResources: {
        food: {
          locationId: "food-market",
          travelMinutes: 7
        }
      }
    },
    candidates: [
      { action: "SLEEPING", score: 6 },
      { action: "WALKING", score: 0.2 }
    ]
  });

  assert.equal(recovery.selectedAction, "WALKING");
  assert.equal(recovery.candidate.targetLocationId, "food-market");
  assert.equal(recovery.candidate.resourceIntent.resource, "food");
  assert.equal(recovery.candidate.resourceIntent.destinationLocationId, "food-market");
  assert.equal(recovery.candidate.resourceIntent.reason, "CRITICAL_NEED_RESOURCE_RECOVERY");
});

test("critical resource recovery fails closed instead of falling back to sleep", () => {
  assert.throws(
    () => decision.resolveCriticalResourceRecovery({
      needs: [{ code: "THIRST", value: 0.91, priorityWeight: 1 }],
      resourceContext: {
        localResources: { water: 0 },
        actions: { DRINKING: { localAvailable: 0, nearestLocation: null } },
        nearestResources: { water: null }
      },
      candidates: [
        { action: "SLEEPING", score: 10 },
        { action: "WALKING", score: 1 }
      ]
    }),
    error => error?.code === "CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE"
  );
});

test("active plan with JSON motivation is classified as goal-directed", () => {
  const classification = behavioral.classifyBehavioralDriver({
    needs: [{ code: "HUNGER", value: 0.62 }],
    goals: [{
      id: "goal-1",
      priority: 1,
      progress: 0.5,
      status: "ACTIVE",
      motivation: JSON.stringify({ need: "HUNGER", pressure: 0.62 })
    }],
    activePlanStep: { id: "step-2", status: "ACTIVE", actionType: "EATING" },
    candidates: [
      { action: "EATING", score: 1 },
      { action: "WALKING", score: 0.8 }
    ]
  });

  assert.equal(classification.driver, "GOAL_DIRECTED");
  assert.equal(classification.evidence.goalId, "goal-1");
  assert.equal(classification.evidence.planAction, "EATING");
});

test("recovery block prevents returning to sleep while thirst remains high", () => {
  const interruption = {
    id: "action-1",
    actionType: "SLEEPING",
    at: "2026-09-18T10:00:00.000Z",
    result: JSON.stringify({
      outcome: "PARTIAL",
      interruption: { type: "CRITICAL_NEED", code: "THIRST", value: 0.91 }
    })
  };

  const blocks = decision.activeRecoveryBlocks([interruption], [
    { code: "THIRST", value: 0.88 }
  ]);

  const candidates = decision.applyRecoveryBlocks([
    { action: "SLEEPING", score: 4 },
    { action: "DRINKING", score: 1 },
    { action: "WALKING", score: 0.5 }
  ], blocks);

  assert.equal(candidates.find(x => x.action === "SLEEPING").score, 0);
  assert.equal(candidates.find(x => x.action === "SLEEPING").recoveryBlocked, true);
  assert.equal(candidates.find(x => x.action === "DRINKING").score, 1);
});

test("active plan commitment still selects its step over stochastic alternatives", () => {
  const result = decision.resolvePlanCommitment({
    needs: [{ code: "HUNGER", value: 0.62 }],
    activePlanStep: { id: "step-2", status: "ACTIVE", actionType: "EATING" },
    candidates: [
      { action: "WALKING", score: 4 },
      { action: "EATING", score: 1.2 },
      { action: "PLAYING", score: 2 }
    ]
  });

  assert.equal(result.action, "EATING");
});

test("experience policy influence is bounded but stronger than the previous 0.35 cap", () => {
  const profile = {
    preferences: [
      { targetType: "ACTION:DRINKING", preferenceValue: -1, strength: 0.7, confidence: 0.9 },
      { targetType: "LOCATION_ACTION:HOME:DRINKING", preferenceValue: -1, strength: 0.8, confidence: 0.9 }
    ],
    beliefs: [
      { predicate: "ACTION_OUTCOME_DRINKING", objectValue: { outcome: "FAILURE", locationId: "home" }, confidence: 0.9 }
    ]
  };

  const modifier = require("../src/services/experience-learning-service")
    .cognitiveExperienceModifier(profile, "DRINKING", { locationType: "HOME", locationId: "home" });

  assert.ok(modifier >= -0.65 && modifier <= 0.65);
  assert.ok(modifier < -0.35);
});

test("shared cognitive queue serializes per entity and retries optimistic locks", async () => {
  const events = [];
  let attempts = 0;

  const first = queue.enqueue("asami", async () => {
    events.push("first:start");
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push("first:end");
    return "first";
  });

  const second = queue.enqueue("asami", async () => {
    attempts += 1;
    events.push(`second:attempt-${attempts}`);
    if (attempts === 1) {
      throw Object.assign(new Error("version conflict"), { code: "OPTIMISTIC_LOCK" });
    }
    events.push("second:success");
    return "second";
  }, { retries: 2, baseDelayMs: 1 });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:attempt-1",
    "second:attempt-2",
    "second:success"
  ]);
});

test("critical thirst recovery overrides a walking recovery block",()=>{const result=decision.resolveCriticalResourceRecovery({needs:[{code:"THIRST",value:.93,priorityWeight:1}],resourceContext:{localResources:{water:0},actions:{DRINKING:{localAvailable:0,nearestLocation:{locationId:"water-source",travelMinutes:4}}},nearestResources:{water:{locationId:"water-source",travelMinutes:4}}},candidates:[{action:"WALKING",score:0,recoveryBlocked:true},{action:"SLEEPING",score:9}]});assert.equal(result.selectedAction,"WALKING");assert.equal(result.candidate.recoveryBlocked,false);assert.equal(result.candidate.targetLocationId,"water-source");});
test("critical thirst overrides an energy recovery block on WALKING",()=>{
  const protectedActions=decision.criticalProtectedActions(
    [{code:"THIRST",value:.93,priorityWeight:1}],
    {localResources:{water:0},actions:{DRINKING:{localAvailable:0,nearestLocation:null}}}
  );
  const candidates=decision.applyRecoveryBlocks(
    [{action:"WALKING",score:1},{action:"SLEEPING",score:4}],
    [{code:"ENERGY",needValue:.1,releaseBelow:.35,blockedActions:["WALKING"]}],
    protectedActions
  );
  const walking=candidates.find(candidate=>candidate.action==="WALKING");
  assert.equal(walking.recoveryBlocked,false);
  assert.equal(walking.score,1);
});
