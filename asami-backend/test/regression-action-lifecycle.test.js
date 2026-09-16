const test=require("node:test");
const assert=require("node:assert/strict");
const { classifyPhysicalOutcome }=require("../src/services/action-service");
test("missing physical result is treated as successful for non-resource actions",()=>{assert.deepEqual(classifyPhysicalOutcome(undefined),{outcome:"SUCCESS",success:true,failureReason:null});});
test("partial resource consumption is distinct from total failure",()=>{assert.deepEqual(classifyPhysicalOutcome({ok:false,consumed:.5}),{outcome:"PARTIAL",success:false,failureReason:"RESOURCE_PARTIALLY_AVAILABLE"});});
test("zero consumed resource is a failure",()=>{assert.deepEqual(classifyPhysicalOutcome({ok:false,consumed:0}),{outcome:"FAILURE",success:false,failureReason:"RESOURCE_UNAVAILABLE"});});