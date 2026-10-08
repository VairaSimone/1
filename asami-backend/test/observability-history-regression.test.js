const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const cognitive=require("../src/services/decision-cognitive-finalization-service");
const {compactDecisionContext,calculateDynamicStructuredOutputTokenCeiling,DecisionSchema,AdvancedDecisionSchema}=require("../src/ai/gemini");
const world=require("../src/services/world-observer-service");
const analysis=require("../src/services/analysis-service");

test("cognitive invariant window matches the 14-day artifact retention boundary",()=>{
  const window=cognitive.cognitiveArtifactWindow("2026-10-08T12:00:00.000Z",5);
  assert.equal(window.valid,true);
  assert.equal(window.retentionDays,14);
  assert.equal(window.artifactCutoff,"2026-09-24 12:00:00.000");
  assert.ok(new Date(window.artifactCutoff.replace(" ","T")+"Z")<new Date("2026-10-08T12:00:00.000Z"));
});

test("Gemini decision context is materially smaller and preserves authoritative candidates",()=>{
  const context={
    simulationTime:"2026-10-08T12:00:00.000Z",
    entity:{id:"00000000-0000-0000-0000-000000000001",displayName:"Asami"},
    needs:Array.from({length:20},(_,i)=>({code:"NEED_"+i,value:.5,priorityWeight:1})),
    traits:Array.from({length:20},(_,i)=>({code:"TRAIT_"+i,value:.5})),
    goals:Array.from({length:15},(_,i)=>({id:"00000000-0000-0000-0000-00000000000"+i,title:"Goal "+i,status:"ACTIVE",priority:.5,progress:.2,motivation:{need:"X",longText:"x".repeat(500)}})),
    candidates:Array.from({length:20},(_,i)=>({action:"ACTION_"+i,score:i/20,targetLocationId:null,targetEntityId:null,result:"x".repeat(400)})),
    allowedActionTypes:Array.from({length:20},(_,i)=>"ACTION_"+i),
    recentActions:Array.from({length:20},(_,i)=>({actionType:"ACTION_"+i,outcome:"SUCCESS",at:"2026-10-08T11:00:00Z",payload:"x".repeat(500)})),
    recoveryBlocks:[],resourceContext:{currentLocationId:"x",currentResources:{food:1,water:1},blockedResources:{},nearestResources:{},emergencyResources:[]},
    social:{candidates:Array.from({length:20},(_,i)=>({id:"e"+i,name:"N"+i,familiarity:.5,closeness:.5,affection:.5,trust:.5,compatibility:.5}))},
    geminiTrigger:{type:"AMBIGUITY",priority:"HIGH",reason:"test"},
    giantUnusedField:"x".repeat(50000)
  };
  const compact=compactDecisionContext(context,{advanced:true});
  assert.equal(compact.candidates.length,10);
  assert.equal(compact.needs.length,12);
  assert.equal(compact.social.candidates.length,8);
  assert.equal(compact.giantUnusedField,undefined);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(context).length*.45);
});

test("dynamic structured output ceiling allocates extra room to advanced reasoning without unbounded growth",()=>{
  const prompt="choose an action ".repeat(120);
  const routine=calculateDynamicStructuredOutputTokenCeiling({
    kind:"autonomy",prompt,schema:DecisionSchema,thinkingLevel:"low",configuredCeiling:1536,minimumOutputTokenCeiling:768
  });
  const advanced=calculateDynamicStructuredOutputTokenCeiling({
    kind:"autonomy",prompt,schema:AdvancedDecisionSchema,thinkingLevel:"medium",configuredCeiling:2048,minimumOutputTokenCeiling:1024
  });
  assert.ok(routine>=1536&&routine<=4096);
  assert.ok(advanced>=2048&&advanced<=4096);
});

test("action retention clears the physical decision pointer while preserving action summary audit",()=>{
  const source=fs.readFileSync(require("node:path").join(__dirname,"../src/services/safe-retention-service.js"),"utf8");
  assert.match(source,/UPDATE decisions d SET d\.action_id=NULL/);
  assert.match(source,/JSON_EXTRACT\(d\.actual_outcome,'\$\.actionSummary'\)/);
  assert.match(source,/auditReferencesCleared/);
});

test("world replay declares and enforces a retention-bounded history window",()=>{
  assert.ok(world.replayWindowDays()>=1);
  const source=fs.readFileSync(require("node:path").join(__dirname,"../src/services/world-observer-service.js"),"utf8");
  assert.match(source,/e\.created_simulation_at <= \?/);
  assert.match(source,/replayWindowDays/);
  assert.match(source,/reconstructionWindow: "ACTION_EVENT_RETENTION"/);
});

test("analysis system health exposes retention, AI, cognition and temporal integrity",()=>{
  assert.equal(analysis.worstHealth("OK","WARNING"),"WARNING");
  assert.equal(analysis.worstHealth("OK","CRITICAL"),"CRITICAL");
  const source=fs.readFileSync(require("node:path").join(__dirname,"../src/services/analysis-service.js"),"utf8");
  assert.match(source,/retention_debt_age_hours/);
  assert.match(source,/getSimulationDecisionCoverage/);
  assert.match(source,/getTerminalCognitiveInvariant/);
  assert.match(source,/systemHealth/);
});

test("LiveWorld separates objective, destination and target",()=>{
  const source=fs.readFileSync(require("node:path").join(__dirname,"../../asami-frontend/src/pages/LiveWorld.tsx"),"utf8");
  assert.match(source,/>Obiettivo</);
  assert.match(source,/>Destinazione</);
  assert.match(source,/>Bersaglio</);
  assert.match(source,/selected\.goal\?\.title/);
});
