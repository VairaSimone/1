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


const { isMarketStructure, isProducerStructure }=require("../src/services/society-service");
const { normalizeEffect }=require("../src/services/emergent-definition-service");

test("emergent market detection is data-driven",()=>{
  assert.equal(isMarketStructure({type:"MARKET",attributes:"{}"}),true);
  assert.equal(isMarketStructure({type:"STRANGE_STRUCTURE",attributes:JSON.stringify({definition:{category:"COMMERCE"}})}),true);
  assert.equal(isMarketStructure({type:"STRANGE_STRUCTURE",attributes:"{}"}),false);
});

test("production is recognized from an emergent activity category",()=>{
  assert.equal(isProducerStructure({
    type:"STRANGE_STRUCTURE",
    attributes:JSON.stringify({definition:{activities:[{category:"PRODUCTION"}]}})
  }),true);
});

test("production effects carry bounded inputs as data",()=>{
  const effect=normalizeEffect({
    type:"PRODUCTION",
    goodCode:"FOOD",
    quantity:2,
    resourceInputs:{water:0.5},
    inventoryInputs:{}
  });
  assert.equal(effect.type,"PRODUCTION");
  assert.equal(effect.goodCode,"FOOD");
  assert.equal(effect.quantity,2);
  assert.equal(effect.resourceInputs.water,0.5);
});
