const test=require("node:test");
const assert=require("node:assert/strict");
const {clamp}=require("../src/services/state-rules");

test("clamp never leaves simulation ranges",()=>{
  assert.equal(clamp(-1),0);
  assert.equal(clamp(2),1);
  assert.equal(clamp(.42),.42);
});
