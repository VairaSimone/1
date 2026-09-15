const test=require("node:test");
const assert=require("node:assert/strict");

function validDecision(x){
  return x && typeof x.selectedActionType==="string" &&
    typeof x.reason==="string" && typeof x.confidence==="number" &&
    x.confidence>=0 && x.confidence<=1;
}

test("cognitive result validation rejects invalid confidence",()=>{
  assert.equal(validDecision({selectedActionType:"EATING",reason:"ok",confidence:1.2}),false);
  assert.equal(validDecision({selectedActionType:"EATING",reason:"ok",confidence:.8}),true);
});
