const test=require("node:test");
const assert=require("node:assert/strict");
const { getCriticalInterruptionNeed,getInterruptionReason }=require("../src/simulation/engine");
test("critical interruption ignores healthy reserve values",()=>{assert.equal(getCriticalInterruptionNeed("WORKING",[{code:"ENERGY",value:.95},{code:"SAFETY",value:1}]),null);});
test("critical interruption catches depleted energy",()=>{const result=getCriticalInterruptionNeed("WORKING",[{code:"ENERGY",value:.1}]);assert.equal(result.code,"ENERGY");});
test("critical interruption catches unsafe state",()=>{const result=getCriticalInterruptionNeed("STUDYING",[{code:"SAFETY",value:.1}]);assert.equal(result.code,"SAFETY");});
test("sleep is not interrupted by healthy safety",()=>{assert.equal(getInterruptionReason("SLEEPING",[{code:"SAFETY",value:1},{code:"ENERGY",value:.8},{code:"SLEEPINESS",value:.9}],{recentEvents:[]}),null);});
const fs=require("node:fs");
const path=require("node:path");
test("interrupted actions are persisted and published as INTERRUPTED",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  const start=source.indexOf("async function interruptActiveAction");
  const end=source.indexOf("class SimulationEngine",start);
  assert.ok(start>=0&&end>start);
  const section=source.slice(start,end);
  assert.match(section,/UPDATE actions SET status='INTERRUPTED'/);
  assert.doesNotMatch(section,/UPDATE actions SET status='COMPLETED'/);
  assert.match(source,/action: \{ \.\.\.active, status: "INTERRUPTED", interrupted: true \}/);
});

test("simulation clock and tick creation share one transaction",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/repositories/simulation-repo.js"),"utf8");
  const start=source.indexOf("async function advanceAndCreateTick");
  const end=source.indexOf("async function updateCurrentTimeOptimistic",start);
  assert.ok(start>=0&&end>start);
  const section=source.slice(start,end);
  assert.match(section,/return withTransaction\(async conn =>/);
  assert.match(section,/UPDATE simulations/);
  assert.match(section,/INSERT INTO simulation_ticks/);
});
