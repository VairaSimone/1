const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateTraitNeedModifiers,
  calculateEnvironmentModifier,
  calculateHistoryModifier,
  calculateHabitModifier,
  personalizeNeedDefaults
} = require("../src/services/need-individualization-service");

test("different personalities produce different need dynamics", () => {
  const social = calculateTraitNeedModifiers("SOCIAL_NEED", {
    EXTRAVERSION: .9, SOCIABILITY: .9, EMPATHY: .8, INDEPENDENCE: .2
  });
  const introverted = calculateTraitNeedModifiers("SOCIAL_NEED", {
    EXTRAVERSION: .2, SOCIABILITY: .2, EMPATHY: .4, INDEPENDENCE: .9
  });

  assert.ok(social.decay > introverted.decay);
  assert.ok(social.priority > introverted.priority);
  assert.ok(social.relief > introverted.relief);
});

test("curiosity dynamics follow curiosity-related traits", () => {
  const curious = calculateTraitNeedModifiers("CURIOSITY", {
    CURIOSITY: .95, OPENNESS: .9, CREATIVITY: .9
  });
  const reserved = calculateTraitNeedModifiers("CURIOSITY", {
    CURIOSITY: .15, OPENNESS: .2, CREATIVITY: .2
  });

  assert.ok(curious.decay > reserved.decay);
  assert.ok(curious.priority > reserved.priority);
  assert.ok(curious.relief > reserved.relief);
});

test("environment changes need pressure without random noise", () => {
  const heat = calculateEnvironmentModifier("THIRST", {
    location: { locationType: "HOME", environment: { weather: "HEAT", temperature: 34 } }
  });
  const cold = calculateEnvironmentModifier("THIRST", {
    location: { locationType: "HOME", environment: { weather: "COLD", temperature: 5 } }
  });

  assert.ok(heat > cold);
  assert.equal(
    heat,
    calculateEnvironmentModifier("THIRST", {
      location: { locationType: "HOME", environment: { weather: "HEAT", temperature: 34 } }
    })
  );
});

test("recent successful behavior improves future recovery while failures do the opposite", () => {
  const successful = calculateHistoryModifier("SOCIAL_NEED", [
    { actionType: "TALKING", outcome: "SUCCESS" },
    { actionType: "TALKING", outcome: "SUCCESS" },
    { actionType: "TALKING", outcome: "SUCCESS" }
  ]);
  const failed = calculateHistoryModifier("SOCIAL_NEED", [
    { actionType: "TALKING", outcome: "FAILURE" },
    { actionType: "TALKING", outcome: "FAILURE" },
    { actionType: "TALKING", outcome: "FAILURE" }
  ]);

  assert.ok(successful.relief > 1);
  assert.ok(successful.priority < 1);
  assert.ok(failed.relief < 1);
  assert.ok(failed.priority > 1);
});

test("strong routines only affect their associated need near the routine time", () => {
  const near = calculateHabitModifier("SOCIAL_NEED", [
    {
      strength: .8,
      triggerDefinition: { hour: 12, toleranceHours: 2 },
      actionDefinition: { actionType: "TALKING" }
    }
  ], "2026-10-01T13:00:00.000Z");

  const far = calculateHabitModifier("SOCIAL_NEED", [
    {
      strength: .8,
      triggerDefinition: { hour: 12, toleranceHours: 2 },
      actionDefinition: { actionType: "TALKING" }
    }
  ], "2026-10-01T20:00:00.000Z");

  assert.ok(near.decay < 1);
  assert.ok(near.relief > 1);
  assert.equal(far.decay, 1);
  assert.equal(far.relief, 1);
});

test("initial needs are personalized deterministically from traits", () => {
  const defaultValue = .3;
  const social = personalizeNeedDefaults(defaultValue, "SOCIAL_NEED", {
    EXTRAVERSION: .9, SOCIABILITY: .9, INDEPENDENCE: .2
  });
  const independent = personalizeNeedDefaults(defaultValue, "SOCIAL_NEED", {
    EXTRAVERSION: .2, SOCIABILITY: .2, INDEPENDENCE: .9
  });

  assert.notEqual(social, independent);
  assert.ok(social > defaultValue);
  assert.ok(independent < defaultValue);
  assert.equal(
    social,
    personalizeNeedDefaults(defaultValue, "SOCIAL_NEED", {
      EXTRAVERSION: .9, SOCIABILITY: .9, INDEPENDENCE: .2
    })
  );
});
