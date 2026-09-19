const test=require("node:test");
const assert=require("node:assert/strict");
const {shouldPromoteToFriend}=require("../src/services/social-relationship-service");

test("a strong repeated acquaintance can mature into friendship",()=>{
  assert.equal(shouldPromoteToFriend({
    relationship:{
      type:"ACQUAINTANCE",
      familiarity:.55,
      trust:.25,
      affection:.17,
      closeness:.12,
      conflict:.10,
      irritation:.10
    },
    interactionCount:6,
    ageHours:18
  }),true);
});

test("friendship does not mature from too few interactions or too little time",()=>{
  const relationship={type:"ACQUAINTANCE",familiarity:.8,trust:.4,affection:.4,closeness:.4,conflict:.1,irritation:.1};
  assert.equal(shouldPromoteToFriend({relationship,interactionCount:5,ageHours:24}),false);
  assert.equal(shouldPromoteToFriend({relationship,interactionCount:8,ageHours:8}),false);
});

test("negative interaction patterns block friendship maturation",()=>{
  assert.equal(shouldPromoteToFriend({
    relationship:{type:"ACQUAINTANCE",familiarity:.7,trust:.3,affection:.3,closeness:.25,conflict:.5,irritation:.1},
    interactionCount:8,
    ageHours:24
  }),false);
  assert.equal(shouldPromoteToFriend({
    relationship:{type:"ACQUAINTANCE",familiarity:.7,trust:.3,affection:.3,closeness:.25,conflict:.1,irritation:.55},
    interactionCount:8,
    ageHours:24
  }),false);
});
