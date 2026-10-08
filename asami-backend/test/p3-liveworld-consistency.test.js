const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const {resolvePreferredSleepLocation,sleepLocationRank}=require("../src/services/sleep-location-service");
const {simulationPhase}=require("../src/services/world-observer-service");
const {RealtimeHub}=require("../src/realtime/hub");

function source(relative){
  return fs.readFileSync(path.join(__dirname,"..","..",relative),"utf8");
}

test("sleep location follows HOME -> BEDROOM -> SAFE_PLACE -> OTHER hierarchy",()=>{
  const locations=[
    {locationId:"other",locationType:"PARK",data:{worldCode:"PARK",connections:["home"]}},
    {locationId:"safe",locationType:"SAFE_PLACE",data:{worldCode:"SAFE_PLACE",connections:["home"]}},
    {locationId:"bed",locationType:"BEDROOM",data:{worldCode:"BEDROOM",connections:["home"]}},
    {locationId:"home",locationType:"HOME",data:{worldCode:"HOME",connections:["bed","safe","other"]}}
  ];
  const policy=resolvePreferredSleepLocation({locations,originId:"other",context:{isAsami:true}});
  assert.equal(policy.targetLocationId,"home");
  assert.equal(policy.rank,0);
  const residentPolicy=resolvePreferredSleepLocation({locations,originId:"other",context:{isAsami:false}});
  assert.equal(residentPolicy.rank,1);
  assert.equal(residentPolicy.targetLocationId,"bed");
  assert.equal(sleepLocationRank(locations[2],{isAsami:true}),1);
  assert.equal(sleepLocationRank(locations[1]),2);
  assert.equal(sleepLocationRank(locations[0]),3);
});

test("unusual sleep is allowed only with explicit contextual motivation",()=>{
  const locations=[
    {locationId:"park",locationType:"PARK",data:{worldCode:"PARK",connections:[]}}
  ];
  const normal=resolvePreferredSleepLocation({locations,originId:"park",context:{}});
  assert.equal(normal.allowUnusual,false);
  const contextual=resolvePreferredSleepLocation({
    locations,
    originId:"park",
    context:{sleepPolicy:{allowUnusual:true,reason:"Emergency shelter unavailable"}}
  });
  assert.equal(contextual.allowUnusual,true);
  assert.equal(contextual.targetLocationId,"park");
});

test("backend phase uses Europe/Rome consistently at UTC/CEST boundaries",()=>{
  assert.equal(simulationPhase("2026-01-15T19:00:00.000Z").phase,"evening");
  assert.equal(simulationPhase("2026-01-15T22:00:00.000Z").phase,"night");
  assert.equal(simulationPhase("2026-07-15T19:00:00.000Z").localHour,21);
  assert.equal(simulationPhase("2026-07-15T19:00:00.000Z").phase,"night");
  assert.equal(simulationPhase("2026-07-15T16:00:00.000Z").localHour,18);
  assert.equal(simulationPhase("2026-07-15T16:00:00.000Z").phase,"evening");
});

test("realtime envelope exposes eventSequence and simulationVersion",()=>{
  const hub=new RealtimeHub();
  const sent=[];
  const ws={
    readyState:1,
    on(event,handler){this.handlers=this.handlers||{};this.handlers[event]=handler;},
    send(payload,callback){sent.push(JSON.parse(payload));if(callback)callback();}
  };
  hub.setSimulationVersion("sim-1",42);
  hub.attach(ws,"sim-1");
  hub.publish("sim-1","simulation.tick",{simulationTime:"2026-01-01T00:00:00.000Z"});
  assert.equal(sent.length,1);
  assert.equal(sent[0].sequence,1);
  assert.equal(sent[0].eventSequence,1);
  assert.equal(sent[0].simulationVersion,42);
});

test("frontend uses pressure rather than raw value and rejects stale realtime state",()=>{
  const liveWorld=source("asami-frontend/src/pages/LiveWorld.tsx");
  const hook=source("asami-frontend/src/hooks/useSimulation.ts");
  assert.match(liveWorld,/needPressure\(b\.code, b\.value\) - needPressure\(a\.code, a\.value\)/);
  assert.match(liveWorld,/const phase = displayWorld\?\.phase \?\? 'day'/);
  assert.match(hook,/latestRealtimeSimulationVersion/);
  assert.match(hook,/latestRealtimeWorldStateAt/);
  assert.match(hook,/msg\.eventSequence \?\? msg\.sequence/);
  assert.match(hook,/simulationVersion/);
  assert.match(hook,/atMs < lastStateAt/);
  assert.match(hook,/lastEntityStateAt/);
});

test("sleep guard exists both before planning output becomes action and at action boundary",()=>{
  const decision=source("asami-backend/src/services/decision-service.js");
  const action=source("asami-backend/src/services/action-service.js");
  assert.match(decision,/applySleepLocationPreference/);
  assert.match(decision,/chosen==="SLEEPING"/);
  assert.match(decision,/selectedTargetLocationId=sleepPolicy\.targetLocationId/);
  assert.match(action,/normalizedAction==="SLEEPING"/);
  assert.match(action,/resolvePreferredSleepLocation/);
});
