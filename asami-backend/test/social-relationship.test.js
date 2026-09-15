const test=require("node:test");
const assert=require("node:assert/strict");
const {compatibilityFromTraits,deriveSocialIntent}=require("../src/services/social-relationship-service");

test("compatibility is high for similar traits and lower for incompatible profiles",()=>{
  const a=[{code:"EXTRAVERSION",value:.8},{code:"EMPATHY",value:.7},{code:"OPENNESS",value:.6}];
  const similar=[{code:"EXTRAVERSION",value:.75},{code:"EMPATHY",value:.68},{code:"OPENNESS",value:.62}];
  const incompatible=[{code:"EXTRAVERSION",value:.1},{code:"EMPATHY",value:.1},{code:"OPENNESS",value:.1}];
  assert.ok(compatibilityFromTraits(a,similar)>compatibilityFromTraits(a,incompatible));
});

test("social decision explicitly chooses to stay single when no romantic candidate is suitable",()=>{
  const intent=deriveSocialIntent({actionType:"TALKING",targetId:"b",partner:null,candidates:[{id:"b",compatibility:.2,romanticScore:.1}]});
  assert.equal(intent,"STAY_SINGLE");
});

test("social decision explicitly pursues a compatible romantic candidate",()=>{
  const intent=deriveSocialIntent({actionType:"TALKING",targetId:"b",partner:null,candidates:[{id:"b",compatibility:.8,romanticScore:.75}]});
  assert.equal(intent,"PURSUE_RELATIONSHIP");
});

test("social decision explicitly attempts to reconcile a strong ended partnership",()=>{
  const intent=deriveSocialIntent({actionType:"TALKING",targetId:"b",partner:null,candidates:[{id:"b",compatibility:.7,romanticScore:.4,endedRelationship:{type:"PARTNER",affection:.7,trust:.7,closeness:.7}}]});
  assert.equal(intent,"RECONCILE");
});

test("a partnered entity can explicitly pursue another person, activating betrayal handling",()=>{
  const intent=deriveSocialIntent({actionType:"TALKING",targetId:"c",partner:{partnerId:"b"},candidates:[{id:"c",compatibility:.9,romanticScore:.9}]});
  assert.equal(intent,"PURSUE_RELATIONSHIP");
});
