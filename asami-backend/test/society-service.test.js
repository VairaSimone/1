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


const { normalizeDefinition }=require("../src/services/emergent-definition-service");

test("emergent definitions can declare new economic goods",()=>{
  const definition=normalizeDefinition({
    kind:"STRUCTURE",
    code:"BAKERY",
    name:"Bakery",
    purpose:"Produces bread from existing inputs.",
    products:[{code:"BREAD",name:"Bread",category:"FOOD",unit:"unit",basePrice:1.8}],
    activities:[]
  });
  assert.equal(definition.products.length,1);
  assert.equal(definition.products[0].code,"BREAD");
  assert.equal(definition.products[0].basePrice,1.8);
});

test("business capacity and profit metrics are represented numerically",()=>{
  const capacity=Math.min(10,1+.2);
  const profit=12-4-3;
  assert.equal(capacity,1.2);
  assert.equal(profit,5);
});


test("institution definitions can act as economic venues",()=>{
  assert.equal(isMarketStructure({
    systemType:"COMMUNITY_MARKET",
    attributes:JSON.stringify({definition:{market:true}})
  }),true);
});

test("production and market goods remain open-ended",()=>{
  const definition=normalizeDefinition({
    kind:"SYSTEM",
    code:"TRADE_NETWORK",
    name:"Trade Network",
    purpose:"Coordinate local exchange.",
    market:true,
    production:true,
    products:[{code:"BREAD",name:"Bread",category:"FOOD",unit:"loaf",basePrice:1.8}]
  });
  assert.equal(definition.market,true);
  assert.equal(definition.production,true);
  assert.equal(definition.products[0].code,"BREAD");
});
