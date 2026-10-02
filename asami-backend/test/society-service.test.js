const test=require("node:test");
const assert=require("node:assert/strict");
const {gini}=require("../src/services/society-service");
const {scoreDynamicActivity}=require("../src/services/world-capability-service");

test("gini is zero for equal wealth",()=>assert.equal(gini([10,10,10,10]),0));
test("gini rises with unequal wealth",()=>assert.ok(gini([1,1,1,20])>gini([10,10,10,10])));
test("dynamic work capability is driven by achievement",()=>{
  const activity={code:"WORK_JOB",parameters:{needWeights:{ACHIEVEMENT:2},gate:["ACHIEVEMENT",.2],durationMinutes:120}};
  assert.ok(scoreDynamicActivity(activity,[{code:"ACHIEVEMENT",value:.8}],[])>
    scoreDynamicActivity(activity,[{code:"ACHIEVEMENT",value:.3}],[]));
});
