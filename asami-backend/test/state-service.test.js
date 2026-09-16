const test=require("node:test");
const assert=require("node:assert/strict");
const {clamp}=require("../src/services/state-rules");
const {emotionAppraisal}=require("../src/services/state-service");

test("clamp never leaves simulation ranges",()=>{
  assert.equal(clamp(-1),0);
  assert.equal(clamp(2),1);
  assert.equal(clamp(.42),.42);
});

test("critical thirst creates substantially stronger negative emotional pressure than moderate thirst",()=>{
  const moderate=emotionAppraisal("WALKING",[{code:"THIRST",new:.45}],{event:false});
  const critical=emotionAppraisal("WALKING",[{code:"THIRST",new:.95}],{event:false});
  assert.ok(critical.FRUSTRATION>moderate.FRUSTRATION*4);
  assert.ok(critical.ANXIETY>moderate.ANXIETY*4);
});

test("high curiosity creates exploratory emotional pressure",()=>{
  const low=emotionAppraisal("RESTING",[{code:"CURIOSITY",new:.3}],{event:false});
  const high=emotionAppraisal("RESTING",[{code:"CURIOSITY",new:.95}],{event:false});
  assert.equal(low.EXCITEMENT,0);
  assert.ok(high.EXCITEMENT>0.04);
});
