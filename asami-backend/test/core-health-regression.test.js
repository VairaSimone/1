const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const retention=require("../src/services/safe-retention-service");
const planning=require("../src/services/planning-service");
const cognition=require("../src/services/cognitive-v2-service");
const {RealtimeHub}=require("../src/realtime/hub");
const {EventEmitter}=require("node:events");

test("retention catch-up stays active until backlog and debt age are both recovered",()=>{
  assert.deepEqual(
    retention.deriveRetentionCatchUpState({}, {backlogAfter:6000,debtAgeHours:2,producedRows:100,deletedRows:50}),
    {catchUpActive:true,catchUpLevel:2}
  );
  assert.deepEqual(
    retention.deriveRetentionCatchUpState({catchUpActive:true,catchUpLevel:3},{backlogAfter:1500,debtAgeHours:2,producedRows:100,deletedRows:200}),
    {catchUpActive:true,catchUpLevel:3}
  );
  assert.deepEqual(
    retention.deriveRetentionCatchUpState({catchUpActive:true,catchUpLevel:3},{backlogAfter:900,debtAgeHours:5,producedRows:100,deletedRows:200}),
    {catchUpActive:false,catchUpLevel:0}
  );
  assert.equal(retention.getAdaptiveRetentionProfile(0,3).level,3);
});

test("persistent goal strategy rotation is bounded to known activity types",()=>{
  for(const [goalType,key] of [["LONG_TERM","GROWTH"],["LONG_TERM","KNOWLEDGE"],["LONG_TERM","RELATIONSHIPS"],["PERSONAL","SOCIAL_CONNECTION"],["PERSONAL","CREATIVE_EXPLORATION"],["PERSONAL","EXPLORATION"]]){
    const variants=planning.buildPersistentStrategyVariants(goalType,key);
    assert.ok(variants.length>=3);
    for(const variant of variants){
      for(const action of variant){
        assert.ok(["TALKING","EXPLORING","LEARNING","READING","STUDYING","WORKING","PLAYING","WALKING","CREATING","HELPING","TEACHING"].includes(action),`${goalType}/${key} contains unsupported action ${action}`);
      }
    }
  }
  const source=fs.readFileSync(path.join(__dirname,"../src/services/planning-service.js"),"utf8");
  assert.match(source,/persistent goal stagnation triggered strategy change/);
  assert.match(source,/ineffectiveApproaches/);
  assert.match(source,/progress=GREATEST\(progress/);
});

test("desire fulfillment decays independently from cumulative progress",()=>{
  assert.equal(cognition.decayDesireFulfillment(1,"2026-01-01 00:00:00","2026-01-04 00:00:00"),0.5);
  assert.equal(cognition.decayDesireFulfillment(1,"2026-01-01 00:00:00","2026-01-01 00:00:00"),1);
  const source=fs.readFileSync(path.join(__dirname,"../src/services/cognitive-v2-service.js"),"utf8");
  assert.match(source,/current_fulfillment/);
  assert.match(source,/currentFulfillment/);
  assert.doesNotMatch(source,/Number\(desire\.progress\|\|0\)\)<1/);
});

test("realtime hub publishes monotonic sequence numbers",()=>{
  const hub=new RealtimeHub();
  const messages=[];
  const ws=new EventEmitter();
  ws.readyState=1;
  ws.send=(message,callback)=>{messages.push(JSON.parse(message));if(callback)callback();};
  hub.attach(ws,"sim-1");
  hub.publish("sim-1","entity.state",{entityId:"e1"});
  hub.publish("sim-1","entity.state",{entityId:"e1"});
  assert.equal(messages[0].sequence,1);
  assert.equal(messages[1].sequence,2);
});
