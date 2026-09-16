const test=require("node:test");
const assert=require("node:assert/strict");
const { getCriticalInterruptionNeed,getInterruptionReason }=require("../src/simulation/engine");
test("critical interruption ignores healthy reserve values",()=>{assert.equal(getCriticalInterruptionNeed("WORKING",[{code:"ENERGY",value:.95},{code:"SAFETY",value:1}]),null);});
test("critical interruption catches depleted energy",()=>{const result=getCriticalInterruptionNeed("WORKING",[{code:"ENERGY",value:.1}]);assert.equal(result.code,"ENERGY");});
test("critical interruption catches unsafe state",()=>{const result=getCriticalInterruptionNeed("STUDYING",[{code:"SAFETY",value:.1}]);assert.equal(result.code,"SAFETY");});
test("sleep is not interrupted by healthy safety",()=>{assert.equal(getInterruptionReason("SLEEPING",[{code:"SAFETY",value:1},{code:"ENERGY",value:.8},{code:"SLEEPINESS",value:.9}],{recentEvents:[]}),null);});