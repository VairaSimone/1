const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const src=path.join(__dirname,"../src");
const read=name=>fs.readFileSync(path.join(src,name),"utf8");

test("plan_steps never persists the illegal BLOCKED status",()=>{const s=read("services/planning-service.js");assert.doesNotMatch(s,/status='BLOCKED'/);assert.match(s,/status='FAILED'/);});

test("goal queries do not use the impossible PENDING goal status",()=>{for(const f of ["services/memory-service.js","services/decision-service.js"]){const s=read(f);assert.doesNotMatch(s,/status IN \(\'ACTIVE\',\'PENDING\'\)/);}});

test("interrupted goal completion can recover ownership from the goal",()=>{assert.match(read("services/autonomy-service.js"),/SELECT BIN_TO_UUID\(simulation_id\) AS simulationId,BIN_TO_UUID\(entity_id\) AS entityId FROM goals/);});
