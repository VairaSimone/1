const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const src=path.join(__dirname,"../src");
const read=name=>fs.readFileSync(path.join(src,name),"utf8");

test("autonomous actions preserve goal provenance through the source goal FK",()=>{
  const action=read("services/action-service.js");
  assert.match(action,/source_goal_id/);
  assert.match(action,/SELECT goal_id FROM intentions/);
});

test("generated entity references are validated against the active simulation",()=>{
  const personality=read("services/personality-service.js");
  assert.match(personality,/resolveEntityIdInSimulation/);
  assert.match(personality,/rawTargetEntityId/);
  assert.match(personality,/rawSubjectEntityId/);
  assert.match(personality,/rawObjectEntityId/);
});
