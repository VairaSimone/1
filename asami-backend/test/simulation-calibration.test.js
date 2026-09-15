const test=require("node:test");
const assert=require("node:assert/strict");
const {goalActionSatisfiesNeed}=require("../src/services/autonomy-service");
const {developmentDelta}=require("../src/services/development-service");
const {eventProbability}=require("../src/services/world-service");

function approx(actual,expected,tolerance=1e-12){
  assert.ok(Math.abs(actual-expected)<=tolerance,`expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("goal completion only accepts actions that satisfy the goal need",()=>{
  assert.equal(goalActionSatisfiesNeed("HUNGER","EATING"),true);
  assert.equal(goalActionSatisfiesNeed("THIRST","DRINKING"),true);
  assert.equal(goalActionSatisfiesNeed("BELONGING","TALKING"),true);
  assert.equal(goalActionSatisfiesNeed("BELONGING","SLEEPING"),false);
  assert.equal(goalActionSatisfiesNeed("THIRST","TALKING"),false);
});

test("development is duration and domain weighted",()=>{
  const shortDrink=developmentDelta("DRINKING",10/60);
  const study=developmentDelta("STUDYING",90/60);
  assert.ok(study.cognitive>shortDrink.cognitive);
  assert.ok(study.education>shortDrink.education);
  assert.equal(shortDrink.social,0);
  assert.equal(study.physical,0);
});

test("world event probability scales with simulated time instead of tick count",()=>{
  approx(eventProbability(0,0.25),0);
  const oneHour=eventProbability(60,0.25);
  const twoHours=eventProbability(120,0.25);
  assert.ok(oneHour>0 && oneHour<1);
  assert.ok(twoHours>oneHour);
  approx(twoHours,1-Math.exp(-0.5));
});
