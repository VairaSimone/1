const test=require("node:test");
const assert=require("node:assert/strict");
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
