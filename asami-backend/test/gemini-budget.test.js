const test=require("node:test");
const assert=require("node:assert/strict");
const budget=require("../src/services/gemini-budget-service");

test("budget can shrink output ceiling instead of rejecting a request",()=>{
  const result=budget.calculateAffordableOutputTokenCeiling({
    requestedCeiling:2048,
    minimumOutputTokenCeiling:768,
    inputTokens:2000,
    dailyRemainingUsd:0.008,
    monthlyRemainingUsd:1
  });
  assert.ok(result>=768);
  assert.ok(result<2048);
});

test("budget rejects only when even the minimum output cannot fit",()=>{
  const result=budget.calculateAffordableOutputTokenCeiling({
    requestedCeiling:2048,
    minimumOutputTokenCeiling:1024,
    inputTokens:5000,
    dailyRemainingUsd:0.0001,
    monthlyRemainingUsd:1
  });
  assert.equal(result,0);
});
