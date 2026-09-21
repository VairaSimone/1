const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { conversationOutcomeDeltas,mergeRelationshipDeltas,relationshipFormationAccepted,socialInteractionOutcome }=require("../src/services/social-relationship-service");

test("conversation outcome is merged with baseline into one relationship transition",()=>{
  const merged=mergeRelationshipDeltas({familiarity:.06,trust:.02,respect:.01},{familiarity:.04,trust:.025,affection:.03});
  assert.equal(merged.familiarity,.1);
  assert.equal(merged.trust,.045);
  assert.equal(merged.respect,.01);
  assert.equal(merged.affection,.03);
});

test("social interaction no longer applies a second conversation score update",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/services/social-relationship-service.js"),"utf8");
  const start=source.indexOf("async function processSocialInteraction(");
  const end=source.indexOf("\nasync function maintainRelationships",start);
  const process=source.slice(start,end);
  assert.ok(process.includes("relationshipDeltas=mergeRelationshipDeltas"));
  assert.equal(process.includes("applyConversationOutcome("),false);
});

test("conversation outcome deltas preserve positive, neutral and negative semantics",()=>{
  assert.deepEqual(conversationOutcomeDeltas("POSITIVE"),{familiarity:.04,affection:.03,trust:.025,closeness:.025,conflict:-.015,irritation:-.02});
  assert.deepEqual(conversationOutcomeDeltas("NEGATIVE"),{familiarity:.02,affection:-.025,trust:-.035,closeness:-.02,conflict:.05,irritation:.04});
  assert.deepEqual(conversationOutcomeDeltas("NEUTRAL"),{familiarity:.015,closeness:.008});
});
test("social relationship formation is selective",()=>{
  const weak=relationshipFormationAccepted({compatibility:.42,receptiveness:.40,simulationAt:"2026-09-21T12:00:00.000Z",sourceEntityId:"a",targetEntityId:"b"});
  const strong=relationshipFormationAccepted({compatibility:.90,receptiveness:.85,simulationAt:"2026-09-21T12:00:00.000Z",sourceEntityId:"a",targetEntityId:"c"});
  assert.equal(weak,false);
  assert.equal(strong,true);
});

test("social interaction can produce deterioration instead of only positive outcomes",()=>{
  const outcomes=new Set();
  for(let hour=0;hour<24;hour++)outcomes.add(socialInteractionOutcome({
    compatibility:.45,receptiveness:.38,simulationAt:"2026-09-21T"+String(hour).padStart(2,"0")+":00:00.000Z",sourceEntityId:"a",targetEntityId:"b"
  }));
  assert.ok(outcomes.has("NEGATIVE"));
  assert.ok(outcomes.has("NEUTRAL"));
});

test("remote social contexts are batched and autonomy has no per-actor remote SQL fallback",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/services/social-relationship-service.js"),"utf8");
  const autonomy=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");
  assert.match(source,/async function buildRemoteSocialContexts/);
  assert.match(source,/allPersonIds\.length\?await pool\.query/);
  assert.match(autonomy,/buildRemoteSocialContexts\(simulationId,\[entityId\]/);
  assert.doesNotMatch(autonomy,/function chooseRemoteSocialTarget/);
  assert.doesNotMatch(autonomy,/return chooseRemoteSocialTarget\(/);
});

test("social starvation requires no locally or remotely valid target",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");
  assert.match(source,/validLocalCandidates/);
  assert.match(source,/validRemoteCandidates/);
  assert.match(source,/!validLocalCandidates\.length&&!validRemoteCandidates\.length/);
});
