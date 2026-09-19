const test=require("node:test");
const assert=require("node:assert/strict");
const {calculateSkillLearningGain}=require("../src/services/action-service");

const T0="2026-09-19T10:00:00.000Z";
const T1="2026-09-19T11:00:00.000Z";
const T2="2026-09-19T12:30:00.000Z";

test("navigation learning is spaced and walking gains less than exploration",()=>{
  const first=calculateSkillLearningGain({skill:"NAVIGATION",actionType:"WALKING",proficiency:.1,lastUsedSimulationAt:null,simulationTime:T0});
  const tooSoon=calculateSkillLearningGain({skill:"NAVIGATION",actionType:"WALKING",proficiency:.1,lastUsedSimulationAt:T0,simulationTime:T1});
  const exploration=calculateSkillLearningGain({skill:"NAVIGATION",actionType:"EXPLORING",proficiency:.1,lastUsedSimulationAt:null,simulationTime:T0});
  assert.ok(first>0);
  assert.equal(tooSoon,0);
  assert.ok(exploration>first);
});

test("learning slows as proficiency approaches mastery",()=>{
  const early=calculateSkillLearningGain({skill:"NAVIGATION",actionType:"EXPLORING",proficiency:.1,lastUsedSimulationAt:null,simulationTime:T2});
  const late=calculateSkillLearningGain({skill:"NAVIGATION",actionType:"EXPLORING",proficiency:.9,lastUsedSimulationAt:null,simulationTime:T2});
  assert.ok(early>late);
  assert.equal(calculateSkillLearningGain({skill:"NAVIGATION",actionType:"EXPLORING",proficiency:1,lastUsedSimulationAt:null,simulationTime:T2}),0);
});

test("invalid simulation time cannot create skill gain",()=>{
  assert.equal(calculateSkillLearningGain({skill:"NAVIGATION",actionType:"WALKING",proficiency:.2,simulationTime:"invalid"}),0);
});
