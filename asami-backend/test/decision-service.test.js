const test=require("node:test");
const assert=require("node:assert/strict");
const {scoreAction}=require("../src/services/decision-rules");

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
