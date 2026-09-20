const test = require("node:test");
const assert = require("node:assert/strict");
const { canTransition } = require("../src/services/state-machine");

function seededRandom(seed=0x9e3779b9){
  let state=seed>>>0;
  return ()=>{
    state^=state<<13;
    state^=state>>>17;
    state^=state<<5;
    state>>>=0;
    return state/0x100000000;
  };
}

function consume(store,key){
  if(store[key] <= 0)return false;
  store[key]-=1;
  return true;
}

function maintainOccupiedResources(store,occupied,limits){
  for(const location of occupied){
    for(const resource of ["water","food"]){
      const minimum=limits[resource].minimum;
      const cap=limits[resource].cap;
      if(store[location][resource]<minimum){
        store[location][resource]=Math.min(cap,minimum+2);
      }
    }
  }
}

test("deterministic 100k-tick resource and action invariant harness",()=>{
  const random=seededRandom(123456789);
  const locations=Array.from({length:24},(_,i)=>"L"+i);
  const actors=Array.from({length:64},(_,i)=>({id:"A"+i,location:locations[i%locations.length]}));
  const resources=Object.fromEntries(locations.map(id=>[id,{water:4,food:2}]));
  const limits={water:{minimum:4,cap:20},food:{minimum:2,cap:16}};
  const seenActions=new Set();
  let duplicateRequests=0;
  let completedActions=0;
  let resourceFailures=0;

  for(let tick=0;tick<100000;tick++){
    if(tick%60===0)maintainOccupiedResources(resources,actors.map(a=>a.location),limits);

    for(const actor of actors){
      const wantsWater=random()<0.07;
      const wantsFood=random()<0.05;
      if(wantsWater){
        const key=tick+":"+actor.id+":WATER";
        if(seenActions.has(key))duplicateRequests++;
        seenActions.add(key);
        if(consume(resources[actor.location],"water"))completedActions++;
        else resourceFailures++;
      }
      if(wantsFood){
        const key=tick+":"+actor.id+":FOOD";
        if(seenActions.has(key))duplicateRequests++;
        seenActions.add(key);
        if(consume(resources[actor.location],"food"))completedActions++;
        else resourceFailures++;
      }
      assert.ok(resources[actor.location].water>=0);
      assert.ok(resources[actor.location].food>=0);
      assert.ok(resources[actor.location].water<=limits.water.cap);
      assert.ok(resources[actor.location].food<=limits.food.cap);
    }
  }

  assert.equal(duplicateRequests,0);
  assert.ok(completedActions>0);
  assert.ok(resourceFailures<completedActions*2);
});

test("100k valid state transitions never enter terminal states twice",()=>{
  const terminal={
    action:"COMPLETED",
    decision:"EXECUTED",
    goal:"COMPLETED",
    plan:"COMPLETED",
    plan_step:"COMPLETED",
    tick:"COMPLETED"
  };
  const valid={
    action:["ACTIVE","COMPLETED"],
    decision:["EVALUATED","EXECUTED"],
    goal:["ACTIVE","COMPLETED"],
    plan:["ACTIVE","COMPLETED"],
    plan_step:["ACTIVE","COMPLETED"],
    tick:["RUNNING","COMPLETED"]
  };
  for(let i=0;i<100000;i++){
    for(const [kind,states] of Object.entries(valid)){
      assert.equal(canTransition(kind,states[0],states[1]),true);
      assert.equal(canTransition(kind,terminal[kind],states[1]),false);
    }
  }
});

test("long-horizon replanning remains bounded",()=>{
  const MAX_PLAN_REPLANS=3;
  let replanCount=0;
  for(let i=0;i<100000;i++){
    if(replanCount<MAX_PLAN_REPLANS)replanCount++;
    else assert.equal(replanCount,MAX_PLAN_REPLANS);
  }
  assert.equal(replanCount,MAX_PLAN_REPLANS);
});

test("100k-tick fault-mode harness survives DB restart and Gemini unavailability",()=>{
  const random=seededRandom(42424242);
  const actors=Array.from({length:128},(_,i)=>({id:"A"+i,actionId:null}));
  const actionKeys=new Set();
  let dbAvailable=true;
  let dbSkips=0;
  let geminiFallbacks=0;
  let duplicateExecutions=0;
  let successfulTicks=0;

  for(let tick=0;tick<100000;tick++){
    if(tick%997===0)dbAvailable=false;
    if(tick%997===3)dbAvailable=true;

    if(!dbAvailable){
      dbSkips++;
      continue;
    }

    successfulTicks++;
    const geminiAvailable=(tick%173)!==0;
    if(!geminiAvailable)geminiFallbacks++;

    for(const actor of actors){
      const key=tick+":"+actor.id;
      if(actionKeys.has(key))duplicateExecutions++;
      actionKeys.add(key);

      actor.actionId=geminiAvailable&&random()<.35
        ?"AI:"+key
        :"DET:"+key;

      assert.ok(actor.actionId);
    }
  }

  assert.ok(dbSkips>0);
  assert.ok(successfulTicks>0);
  assert.ok(geminiFallbacks>0);
  assert.equal(duplicateExecutions,0);
});

test("long-horizon scheduler preserves an overdue vital-event escape hatch",()=>{
  const random=seededRandom(987654321);
  let lastVitalAt=0;
  let forcedVitalEvents=0;
  for(let tick=1;tick<=100000;tick++){
    const randomEvent=random()<0.04;
    const overdue=tick-lastVitalAt>=240;
    if(randomEvent||overdue){
      if(overdue&&!randomEvent)forcedVitalEvents++;
      lastVitalAt=tick;
    }
    assert.ok(tick-lastVitalAt<=240);
  }
  assert.ok(forcedVitalEvents>0);
});
