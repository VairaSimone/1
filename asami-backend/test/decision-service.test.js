const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {scoreAction,criticalNeedModifier}=require("../src/services/decision-rules");

test("need pressure makes the corresponding action preferable",()=>{
  const needs=[{code:"HUNGER",value:.95,priorityWeight:1},{code:"THIRST",value:.1,priorityWeight:1}];
  assert.ok(scoreAction("EATING",needs,[])>scoreAction("DRINKING",needs,[]));
});

test("personality affects social score",()=>{
  const needs=[{code:"SOCIAL_NEED",value:.5,priorityWeight:1}];
  const outgoing=scoreAction("TALKING",needs,[{code:"EXTRAVERSION",value:.9},{code:"SOCIABILITY",value:.9}]);
  const shy=scoreAction("TALKING",needs,[{code:"EXTRAVERSION",value:.1},{code:"SOCIABILITY",value:.1}]);
  assert.ok(outgoing>shy);
});

test("critical thirst cannot be treated as an ordinary social opportunity when water is available",()=>{
  const needs=[
    {code:"THIRST",value:1,priorityWeight:1},
    {code:"SOCIAL_NEED",value:.395,priorityWeight:1},
    {code:"BELONGING",value:.342,priorityWeight:1}
  ];
  const resourceContext={localResources:{water:1}};
  const drinking=scoreAction("DRINKING",needs,[],resourceContext);
  const talking=scoreAction("TALKING",needs,[],resourceContext);
  assert.ok(drinking>talking);
  assert.ok(criticalNeedModifier("DRINKING",needs,resourceContext)>1);
});

test("critical food need is protected only when food is locally available",()=>{
  const needs=[{code:"HUNGER",value:.95,priorityWeight:1},{code:"SOCIAL_NEED",value:.8,priorityWeight:1}];
  const availableFood={localResources:{food:1}};
  const unavailableFood={localResources:{food:0},nearestResources:{food:{travelMinutes:10}}};
  assert.ok(scoreAction("EATING",needs,[],availableFood)>scoreAction("TALKING",needs,[],availableFood));
  assert.equal(criticalNeedModifier("EATING",needs,unavailableFood),0);
});

test("activity diversity bonus rewards admissible underused activities",()=>{
  const { activityDiversityBonus } = require("../src/services/decision-rules");
  assert.equal(activityDiversityBonus("READING",[]),.24);
  assert.equal(activityDiversityBonus("READING",["READING"]),.13);
  assert.equal(activityDiversityBonus("READING",["READING","READING","READING"]),0);
  assert.equal(activityDiversityBonus("EATING",[]),0);
});

test("expected success probability separates evidence-rich actions from uncertain actions",()=>{
  const { calibratedSuccessProbability } = require("../src/services/decision-service");
  const uncertain=calibratedSuccessProbability({action:"EXPLORING",candidates:[{action:"EXPLORING",score:1,targetLocationId:null}],context:{recentActions:[]}});
  const evidenceRich=calibratedSuccessProbability({action:"WALKING",candidates:[{action:"WALKING",score:1,targetLocationId:"loc-1"}],context:{recentActions:["WALKING","WALKING","WALKING","WALKING"],resourceContext:{}}});
  assert.ok(evidenceRich>uncertain);
  assert.ok(uncertain>=.45&&uncertain<=.94);
  assert.ok(evidenceRich>=.45&&evidenceRich<=.94);
});

test("decision service contains outcome calibration updates",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/services/decision-service.js"),"utf8");
  assert.match(source,/async function calibrateDecisionOutcome/);
  assert.match(source,/calibrationSamples/);
  assert.match(source,/calibrationErrorEma/);
});
