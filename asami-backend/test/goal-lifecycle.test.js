const test=require("node:test");
const assert=require("node:assert/strict");
const { isCriticalNeed }=require("../src/simulation/engine");
const { selectActiveStep }=require("../src/services/planning-service");

test("critical direction is high for pressure needs and low for reserve needs",()=>{assert.equal(isCriticalNeed("THIRST",.81),true);assert.equal(isCriticalNeed("THIRST",.79),false);assert.equal(isCriticalNeed("ENERGY",.14),true);assert.equal(isCriticalNeed("ENERGY",.16),false);assert.equal(isCriticalNeed("SAFETY",.19),true);assert.equal(isCriticalNeed("SAFETY",.21),false);});
test("a plan always resolves its next executable step",()=>{assert.equal(selectActiveStep({steps:[{sequence:1,status:"BLOCKED"},{sequence:2,status:"ACTIVE"}]}).sequence,2);});
