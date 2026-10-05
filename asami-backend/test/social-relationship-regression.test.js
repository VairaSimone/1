const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { conversationOutcomeDeltas,mergeRelationshipDeltas,relationshipFormationAccepted,socialInteractionOutcome,shouldEndRelationshipAfterInteraction,relationshipContinuityScore,historicalRelationshipIsReconnectable }=require("../src/services/social-relationship-service");

test("conversation outcome is merged with baseline into one relationship transition",()=>{
  const merged=mergeRelationshipDeltas({familiarity:.06,trust:.02,respect:.01},{familiarity:.04,trust:.025,affection:.03});
  assert.equal(merged.familiarity,.1);
  assert.equal(merged.trust,.045);
  assert.equal(merged.respect,.01);
  assert.equal(merged.affection,.03);
});

test("historical social bonds decay gradually instead of resetting to zero",()=>{
  const recent={
    type:"FRIEND",
    familiarity:.62,
    trust:.42,
    affection:.38,
    closeness:.34,
    attraction:.20,
    endedSimulationAt:"2026-10-20T00:00:00.000Z"
  };
  const continuity=relationshipContinuityScore(recent,"2026-10-25T00:00:00.000Z");
  const farContinuity=relationshipContinuityScore(recent,"2027-01-23T00:00:00.000Z");
  assert.ok(continuity>0);
  assert.ok(continuity>farContinuity);
});

test("historical relationship reconnection ignores bonds ended in severe conflict",()=>{
  const healthy={type:"FRIEND",trust:.42,affection:.38,closeness:.34,familiarity:.62,conflict:.30,irritation:.30,endedSimulationAt:"2026-10-20T00:00:00.000Z"};
  const hostile={...healthy,conflict:.80};
  assert.equal(historicalRelationshipIsReconnectable(healthy,"2026-10-25T00:00:00.000Z"),true);
  assert.equal(historicalRelationshipIsReconnectable(hostile,"2026-10-25T00:00:00.000Z"),false);
});

test("social continuity reactivates ended non-partner relationships and uses last interaction for decay",()=>{
  const relationshipService=fs.readFileSync(path.join(__dirname,"../src/services/relationship-service.js"),"utf8");
  const socialService=fs.readFileSync(path.join(__dirname,"../src/services/social-relationship-service.js"),"utf8");
  assert.match(relationshipService,/withTransaction\(async conn=>/);
  assert.match(relationshipService,/status='ENDED'/);
  assert.match(relationshipService,/rt\.code IN \('ACQUAINTANCE','FRIEND'\)/);
  assert.match(relationshipService,/status='ACTIVE'/);
  assert.match(socialService,/endedRelationship/);
  assert.match(socialService,/relationshipContinuityScore/);
  assert.match(socialService,/lastInteractionSimulationAt/);
  assert.match(socialService,/relationshipIntent==="RECONCILE"/);
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

test("newly formed relationships are not ended just because trust starts below the termination threshold",()=>{
  assert.equal(shouldEndRelationshipAfterInteraction({
    previousRelationship:null,
    updatedRelationship:{trust:.04,conflict:.04},
    interactionOutcome:"POSITIVE"
  }),false);
  assert.equal(shouldEndRelationshipAfterInteraction({
    previousRelationship:null,
    updatedRelationship:{trust:0,conflict:.05},
    interactionOutcome:"NEGATIVE"
  }),false);
});

test("established relationships can still end when trust crosses downward or conflict becomes severe",()=>{
  assert.equal(shouldEndRelationshipAfterInteraction({
    previousRelationship:{trust:.16},
    updatedRelationship:{trust:.11,conflict:.20},
    interactionOutcome:"NEGATIVE"
  }),true);
  assert.equal(shouldEndRelationshipAfterInteraction({
    previousRelationship:{trust:.04},
    updatedRelationship:{trust:.04,conflict:.79},
    interactionOutcome:"NEUTRAL"
  }),true);
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
