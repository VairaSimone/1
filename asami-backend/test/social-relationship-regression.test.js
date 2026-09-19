const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { conversationOutcomeDeltas,mergeRelationshipDeltas }=require("../src/services/social-relationship-service");

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