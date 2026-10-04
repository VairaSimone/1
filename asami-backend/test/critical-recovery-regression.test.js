const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const src=path.join(__dirname,"../src");
const read=name=>fs.readFileSync(path.join(src,name),"utf8");

test("sleep uses a dedicated high tolerance threshold for hunger and thirst interrupts",()=>{
  const source=read("simulation/engine.js");
  assert.match(source,/const SLEEP_INTERRUPTION_THRESHOLDS = Object\.freeze\(\{/);
  assert.match(source,/THIRST: 0\.95/);
  assert.match(source,/HUNGER: 0\.95/);
  assert.match(source,/SAFETY: 0\.20/);
  assert.match(source,/action === "SLEEPING"\s*\?\s*SLEEP_INTERRUPTION_THRESHOLDS\[code\]/);
  assert.match(source,/const critical = direction === "HIGH"/);
});

test("interruption recovery keeps hysteresis until the need is materially relieved",()=>{
  const source=read("services/decision-service.js");
  const start=source.indexOf("function recoveryBlockForInterruption");
  const end=source.indexOf("\nfunction activeRecoveryBlocks",start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/THIRST:\.55/);
  assert.match(section,/HUNGER:\.55/);
  assert.match(section,/releaseBelow/);
  assert.match(section,/hysteresis:true/);

  const activeStart=source.indexOf("function activeRecoveryBlocks");
  const activeEnd=source.indexOf("\nfunction applyRecoveryBlocks",activeStart);
  const activeSection=source.slice(activeStart,activeEnd);
  assert.match(activeSection,/value<=block\.releaseBelow/);
});

test("resource failures are scoped to the matching plan step and trigger ordinary replanning",()=>{
  const source=read("services/planning-service.js");
  assert.match(source,/function resourceForAction\(actionType\)/);
  assert.match(source,/function stepRequiresResource\(step,resource\)/);
  const start=source.indexOf("async function advancePlanForAction");
  const end=source.indexOf("\nmodule.exports=",start);
  const section=source.slice(start,end);
  const guard=section.indexOf("const resourceBlock=isResourceBlockedFailure");
  assert.ok(guard>=0);
  const guardSection=section.slice(guard,guard+1500);
  assert.match(guardSection,/expectedAction!==normalizedAction/);
  assert.match(guardSection,/!stepRequiresResource\(step,resourceBlock\.resource\)/);
  assert.match(guardSection,/resourceFailureIgnored:true/);
  assert.doesNotMatch(guardSection,/await blockGoalForResource\(/);
  assert.match(section,/blockedReason:resourceBlock\s*\?\s*"RESOURCE_UNAVAILABLE_REQUIRES_REPLAN"/);
});

test("legacy blocked resource goals are revalidated against physical reachability",()=>{
  const source=read("services/planning-service.js");
  const start=source.indexOf("async function ensureGoalPlan");
  const end=source.indexOf("\nfunction selectActiveStep",start);
  const section=source.slice(start,end);
  assert.match(section,/const reachable=resource\s*\n\s*\?await isCriticalResourceReachable\(simulationId,entityId,resource\)/);
  assert.doesNotMatch(section,/const reachable=resource==="food"/);
});
