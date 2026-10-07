const test=require("node:test");
const assert=require("node:assert/strict");
const {
  compactActionResult,
  compactPlanStepResult,
  compactDecisionActualOutcome
}=require("../src/services/storage-compaction");

test("action result compaction removes oversized diagnostic subtrees but preserves operational fields",()=>{
  const input={
    eventId:"event-1",
    outcome:"SUCCESS",
    success:true,
    actionId:"action-1",
    actionType:"DRINKING",
    targetEntityId:"entity-2",
    targetLocationId:"location-2",
    resource:{ok:true,resource:"water",consumed:1,remaining:5,actionType:"DRINKING"},
    needChanges:[
      {code:"THIRST",old:0.9,new:0.4,delta:-0.5,individualization:{history:{decay:0.94},trait:{relief:1.12}}}
    ],
    socialInteraction:{huge:"payload that must not be copied"}
  };
  const compact=compactActionResult(input);
  assert.equal(compact.outcome,"SUCCESS");
  assert.equal(compact.actionId,"action-1");
  assert.deepEqual(compact.resource,{ok:true,resource:"water",consumed:1,remaining:5,actionType:"DRINKING"});
  assert.deepEqual(compact.needChanges,[{code:"THIRST",old:0.9,new:0.4,delta:-0.5}]);
  assert.equal(Object.prototype.hasOwnProperty.call(compact,"socialInteraction"),false);
});

test("plan-step compaction preserves counters and compacted action result",()=>{
  const compact=compactPlanStepResult({
    actionType:"SLEEPING",
    outcome:"PARTIAL",
    attempts:2,
    completions:1,
    requiredCompletions:3,
    avoidLocationIds:["a"],
    actionResult:{actionId:"x",actionType:"SLEEPING",needChanges:[{code:"ENERGY",old:0.1,new:0.4,delta:0.3,individualization:{history:{x:1}}}]}
  });
  assert.equal(compact.actionType,"SLEEPING");
  assert.equal(compact.completions,1);
  assert.equal(compact.actionResult.actionId,"x");
  assert.deepEqual(compact.actionResult.needChanges,[{code:"ENERGY",old:0.1,new:0.4,delta:0.3}]);
});

test("decision actual outcome compaction preserves top-level outcome and compacts its action summary",()=>{
  const compact=compactDecisionActualOutcome({
    outcome:"SUCCESS",
    actionSummary:{
      actionId:"x",
      actionType:"TALKING",
      status:"COMPLETED",
      target:{targetEntityId:"y",name:"Person",details:{huge:true}},
      parameters:{actionType:"TALKING",targetEntityId:"y",conversationPayload:"huge"},
      result:{outcome:"SUCCESS",success:true,socialInteraction:{huge:"payload"}}
    }
  });
  assert.equal(compact.outcome,"SUCCESS");
  assert.equal(compact.actionSummary.actionId,"x");
  assert.equal(compact.actionSummary.target.targetEntityId,"y");
  assert.equal(compact.actionSummary.parameters.targetEntityId,"y");
  assert.equal(Object.prototype.hasOwnProperty.call(compact.actionSummary.result,"socialInteraction"),false);
});
