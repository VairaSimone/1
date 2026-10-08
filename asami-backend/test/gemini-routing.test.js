const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const geminiSource=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
const envSource=fs.readFileSync(path.join(__dirname,"../src/config/env.js"),"utf8");
const chatSource=fs.readFileSync(path.join(__dirname,"../src/services/chat-service.js"),"utf8");
const stateSource=fs.readFileSync(path.join(__dirname,"../src/services/state-service.js"),"utf8");
const memorySource=fs.readFileSync(path.join(__dirname,"../src/services/memory-service.js"),"utf8");
const engineSource=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
const actionSource=fs.readFileSync(path.join(__dirname,"../src/services/action-service.js"),"utf8");
const perceptionSource=fs.readFileSync(path.join(__dirname,"../src/services/perception-service.js"),"utf8");
const entityRepoSource=fs.readFileSync(path.join(__dirname,"../src/repositories/entity-repo.js"),"utf8");
const autonomySource=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");

test("Gemini strips unsupported JSON Schema string formats before provider submission",()=>{
  assert.match(geminiSource,/const providerSupportedStringFormats = new Set\(\["date-time","date","time"\]\)/);
  assert.match(geminiSource,/if \(key === "format" && !providerSupportedStringFormats\.has\(String\(value\)\)\) continue/);
  assert.match(geminiSource,/z\.string\(\)\.uuid\(\)/);
});

test("Gemini uses a stable multi-model fallback chain",()=>{
  assert.match(envSource,/GEMINI_MODEL[\s\S]*default\("gemini-3\.8-flash"\)/);
  assert.match(envSource,/GEMINI_FALLBACK_MODELS/);
  assert.match(envSource,/GEMINI_AUTONOMY_MAX_MODELS: z\.preprocess/);
  assert.match(envSource,/\.max\(2\)\.default\(2\)/);
  assert.match(geminiSource,/this\.models=\[this\.model,"gemini-3\.1-flash-lite"/);
  assert.match(geminiSource,/this\.models=\[this\.model,"gemini-3\.1-flash-lite",\.\.\.\(Array\.isArray\(env\.GEMINI_FALLBACK_MODELS\)/);
  assert.match(envSource,/gemini-3\.1-flash-lite/);
});

test("Gemini transient failures are isolated per model",()=>{
  assert.match(geminiSource,/this\.modelStates=new Map\(\)/);
  assert.match(geminiSource,/failureStreak:0,blockedUntil:0,reason:null/);
  assert.match(geminiSource,/_blockModel\(model,transientCooldown,fallbackReason,kind\)/);
  assert.match(geminiSource,/const fallbackModel=models\[modelIndex\+1\]\|\|null/);
  assert.match(geminiSource,/Gemini model unavailable; trying fallback model/);
  assert.doesNotMatch(geminiSource,/budget\.blockProvider\(transientCooldown,transientReason\)/);
});

test("Gemini stops after all configured models fail transiently",()=>{
  assert.match(geminiSource,/reason:lastTransientFailure\?\.reason\|\|"ALL_GEMINI_MODELS_FAILED"/);
  assert.match(geminiSource,/all Gemini models unavailable; deterministic fallback used/);
  assert.match(geminiSource,/fallbackDepth:models\.length/);
});

test("Gemini request accounting identifies the model that answered",()=>{
  assert.match(geminiSource,/lastRequestStatus=\{[\s\S]*?model,[\s\S]*?fallbackDepth:modelIndex/);
  assert.match(geminiSource,/logger\.debug\(\{[\s\S]*?model,[\s\S]*?fallbackDepth:modelIndex,[\s\S]*?\},"Gemini request succeeded"\)/);
});

test("Autonomy availability depends on model availability",()=>{
  assert.match(geminiSource,/if\(!this\._hasAvailableModel\("autonomy"\)\)return false/);
  assert.match(geminiSource,/_availableModels\(kind="autonomy"\)/);
});


test("Autonomy output ceiling cannot be configured below the safe structured-output floor",()=>{
  assert.match(envSource,/GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING: z\.preprocess/);
  assert.match(envSource,/Math\.max\(2048,n\)/);
  assert.match(envSource,/\.int\(\)\.min\(2048\)/);
});

test("Malformed or truncated Gemini structured output fails over to the next model",()=>{
  assert.match(geminiSource,/code==="AI_INVALID_OUTPUT"/);
  assert.match(geminiSource,/finishReason==="MAX_TOKENS"\|\|finishReason==="LENGTH"/);
  assert.match(geminiSource,/schema\.parse\(JSON\.parse\(raw\)\)/);
  assert.match(geminiSource,/failure\.kind==="INVALID_OUTPUT"/);
  assert.match(geminiSource,/Gemini produced invalid structured output; trying fallback model/);
});


test("Gemini provider rate and quota limits are isolated per model",()=>{
  assert.doesNotMatch(geminiSource,/budget\.blockProvider\(failure\.retryAfterMs/);
  assert.match(geminiSource,/this\._blockModel\(model,modelCooldown,fallbackReason,kind\)/);
  assert.match(geminiSource,/Gemini model limit reached; trying fallback model/);
  assert.match(geminiSource,/if\(!this\._hasAvailableModel\("autonomy"\)\)return false/);
});

test("Gemini never sends a provider deadline shorter than the 10-second minimum",()=>{
  assert.match(geminiSource,/MIN_PROVIDER_DEADLINE_MS = 10000/);
  assert.match(geminiSource,/reason:"GEMINI_DEADLINE_TOO_SHORT"/);
  assert.match(geminiSource,/remainingBudgetMs<MIN_PROVIDER_DEADLINE_MS/);
  assert.match(geminiSource,/Math\.max\(MIN_PROVIDER_DEADLINE_MS,Math\.min\(/);
  assert.doesNotMatch(geminiSource,/Math\.max\(1,Math\.min\(30000,configuredTimeoutMs,timeoutBudgetMs\)\)/);
  const modelDeclaration=geminiSource.indexOf("const model=models[modelIndex];");
  const deadlineGuard=geminiSource.indexOf('reason:"GEMINI_DEADLINE_TOO_SHORT"');
  assert.ok(modelDeclaration>=0 && modelDeclaration<deadlineGuard);
});
  

test("Gemini startup exposes the effective autonomy output ceiling",()=>{
  assert.match(geminiSource,/autonomyOutputTokenCeiling:env\.GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING/);
});


test("Dialogue uses a bounded latency and model fallback policy",()=>{
  assert.match(envSource,/GEMINI_DIALOGUE_MODEL: z\.string\(\)\.default\("gemini-3\.1-flash-lite"\)/);
  assert.match(envSource,/GEMINI_DIALOGUE_FALLBACK_MODELS: z\.preprocess/);
  assert.match(envSource,/GEMINI_DIALOGUE_FALLBACK_MODELS: z\.preprocess/);
  assert.match(envSource,/GEMINI_DIALOGUE_TIMEOUT_MS: z\.preprocess/);
  assert.match(envSource,/GEMINI_DIALOGUE_MAX_MODELS: z\.coerce\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(envSource,/GEMINI_DIALOGUE_COMPACT_OUTPUT_TOKEN_CEILING: z\.coerce\.number/);
  assert.match(geminiSource,/maxModels=null,timeoutMsOverride=null,outputTokenCeilingOverride=null/);
  assert.match(geminiSource,/kind==="dialogue"\?this\.dialogueModels:this\.models/);
  assert.match(geminiSource,/this\._availableModels\(kind\)/);
  assert.match(geminiSource,/kind==="dialogue"/);
  assert.match(geminiSource,/timeoutMs=kind==="dialogue"/);
  assert.match(geminiSource,/requestDeadlineAt/);
  assert.match(geminiSource,/GEMINI_DIALOGUE_MAX_LATENCY_MS/);
  assert.match(geminiSource,/thinkingLevel:advanced\?"low":"minimal"/);
  assert.match(geminiSource,/dialogueCompactOutputTokenCeiling:env\.GEMINI_DIALOGUE_COMPACT_OUTPUT_TOKEN_CEILING/);
  assert.match(geminiSource,/configuredTimeoutMs/);
  assert.match(geminiSource,/maxModels:env\.GEMINI_DIALOGUE_MAX_MODELS/);
});

test("Dialogue compacts context and only requests advanced cognition when needed",()=>{
  assert.match(geminiSource,/function dialogueNeedsAdvancedCognition\(context\)/);
  assert.match(geminiSource,/function compactDialogueContext\(context/);
  assert.match(geminiSource,/AdvancedDialogueSchema/);
  assert.match(geminiSource,/This is ordinary conversation/);
  assert.match(geminiSource,/This message has meaningful cognitive relevance/);
});

test("Dialogue retries with the compact schema after truncated output",()=>{
  assert.match(geminiSource,/Retrying Gemini dialogue with compact schema/);
  assert.match(geminiSource,/reason==="AI_INVALID_OUTPUT"/);
  assert.match(geminiSource,/let raw=""/);
  assert.match(geminiSource,/COMPACT_DIALOGUE_SCHEMA/);
  assert.match(geminiSource,/outputTokenCeilingOverride:compactOutputTokens/);
});

test("Chat isolates Gemini failures so deterministic delivery can still complete",()=>{
  assert.match(chatSource,/generated=await gemini\.dialogue\(context,\{simulationId,entityId:asamiEntityId,simulationTime\}\)/);
  assert.match(chatSource,/Gemini dialogue failed; deterministic reply will be used/);
  assert.match(chatSource,/const reply=generated\?\.reply\|\|deterministicReply\(context,content\)/);
});


test("Gemini budget is isolated between autonomy and dialogue",()=>{
  assert.match(envSource,/GEMINI_AUTONOMY_DAILY_BUDGET_USD: z\.coerce\.number/);
  assert.match(envSource,/GEMINI_DIALOGUE_DAILY_BUDGET_USD: z\.coerce\.number/);
  assert.match(fs.readFileSync(path.join(__dirname,"../src/services/gemini-budget-service.js"),"utf8"),/kind VARCHAR\(20\)/);
  assert.match(fs.readFileSync(path.join(__dirname,"../src/services/gemini-budget-service.js"),"utf8"),/budgetKind = kind === "dialogue" \? "DIALOGUE" : "AUTONOMY"/);
});


test("Gemini autonomy budget gate backs off after a local daily-budget block",()=>{
  const budgetSource=fs.readFileSync(path.join(__dirname,"../src/services/gemini-budget-service.js"),"utf8");
  assert.match(budgetSource,/const budgetBlockedUntil = new Map\(\)/);
  assert.match(budgetSource,/budgetBlockedUntil\.set\(budgetKind/);
  assert.match(budgetSource,/retryAfterMs/);
});


test("Chat ordering is chronological with turn metadata only as a same-time tie breaker",()=>{
  const frontend=fs.readFileSync(path.join(__dirname,"../../asami-frontend/src/hooks/useSimulation.ts"),"utf8");
  const routes=fs.readFileSync(path.join(__dirname,"../src/api/routes.js"),"utf8");
  const chat=fs.readFileSync(path.join(__dirname,"../src/services/chat-service.js"),"utf8");
  assert.match(frontend,/const aTime = new Date\(a\.simulationAt\)\.getTime\(\)[\s\S]*const aSequence = chatSequence\(a\)/);
  assert.match(routes,/ORDER BY[\s\S]*m\.simulation_created_at ASC[\s\S]*turnSequence/);
  assert.match(chat,/ORDER BY[\s\S]*m\.simulation_created_at ASC[\s\S]*turnSequence/);
});

test("Conversation context is grounded in authoritative identity and durable timeline",()=>{
  assert.match(entityRepoSource,/LEFT JOIN persons p ON p\.entity_id=e\.id/);
  assert.match(entityRepoSource,/birth_simulation_at AS birthSimulationAt/);
  assert.match(chatSource,/function buildIdentity\(entity, simulationTime\)/);
  assert.match(chatSource,/identity:buildIdentity\(entity,effectiveTime\)/);
  assert.match(chatSource,/authoritativeFacts/);
  assert.match(chatSource,/earlier Asami replies are NOT proof|previous reply conflicts with authoritative state/);
  assert.match(chatSource,/rn<=3 OR rn>GREATEST\(3,total-12\)/);
});

test("Autonomy uses a slower periodic review and a separate high-value cooldown",()=>{
  assert.match(envSource,/GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES/);
  assert.match(envSource,/GEMINI_AUTONOMY_HIGH_VALUE_MIN_INTERVAL_MINUTES/);
  assert.match(envSource,/return 1440/);
  assert.match(envSource,/return 120/);
  assert.match(autonomySource,/highValueInterval/);
});

test("Repeated identical Gemini triggers are deduplicated per entity",()=>{
  assert.match(autonomySource,/lastGeminiTriggerKeyByEntity/);
  assert.match(autonomySource,/triggerKey===lastGeminiTriggerKeyByEntity\.get/);
  assert.match(autonomySource,/key:"PERIODIC:/);
});

test("Autonomy failure reflection consumes real interruptions instead of an unused recentOutcomes field",()=>{
  assert.match(autonomySource,/context\.recentInterruptions/);
  assert.match(autonomySource,/FAILURE_REFLECTION/);
  assert.match(autonomySource,/SOCIAL_CONFLICT/);
});

test("Autonomy budget cooldown no longer suppresses high-value Gemini opportunities",()=>{
  const budgetSource=fs.readFileSync(path.join(__dirname,"../src/services/gemini-budget-service.js"),"utf8");
  assert.match(budgetSource,/function isLocallyBlocked\(kind="AUTONOMY"\)/);
  assert.match(budgetSource,/budgetKind==="AUTONOMY" && highValue/);
  assert.match(autonomySource,/getGeminiTrigger\(entity,context,memories\)/);
  assert.doesNotMatch(autonomySource,/geminiTrigger=localBudgetBlocked\?null/);
});

test("Autonomy caps provider fallback fanout to two models",()=>{
  assert.match(geminiSource,/autonomyMaxModels=Math\.max\(1,Math\.min\(2/);
  assert.match(geminiSource,/maxModels:autonomyMaxModels/);
});

test("Routine dialogue uses minimal thinking and compact structured output",()=>{
  assert.match(geminiSource,/thinkingLevel:advanced\?"low":"minimal"/);
  assert.match(geminiSource,/GEMINI_AUTONOMY_COMPACT_OUTPUT_TOKEN_CEILING/);
  assert.match(envSource,/GEMINI_AUTONOMY_COMPACT_OUTPUT_TOKEN_CEILING: z\.coerce\.number/);
  assert.match(envSource,/\.min\(1024\)\.max\(4096\)/);
});

test("Autonomy uses advanced output only for high-value decisions",()=>{
  assert.match(geminiSource,/function decisionNeedsAdvancedCognition\(context\)/);
  assert.match(geminiSource,/const schema=advanced\?AdvancedDecisionSchema:DecisionSchema/);
  assert.match(geminiSource,/autonomyMaxModels=Math\.max\(1,Math\.min\(2/);
  assert.match(geminiSource,/Do not output strategy or planProposal/);
});

test("Entity state writes are batched per state family",()=>{
  assert.match(stateSource,/UPDATE entity_needs_current[\s\S]*CASE need_id/);
  assert.match(stateSource,/UPDATE entity_emotions_current[\s\S]*CASE emotion_id/);
  assert.match(stateSource,/const initializedEntityState = new Set\(\)/);
  assert.match(stateSource,/initializedEntityState\.has\(key\)/);
});

test("Tick actor reads are batched",()=>{
  assert.match(actionSource,/async function getActiveActions\(simulationId,entityIds=\[\]\)/);
  assert.match(perceptionSource,/async function perceiveBatch\(simulationId,entityIds=\[\],simulationTime\)/);
  assert.match(engineSource,/actionService\.getActiveActions\(sim\.id,actors\)/);
  assert.match(engineSource,/perceiveBatch\(sim\.id,actors,nextTime\)/);
  assert.match(engineSource,/needsOverride: latestNeeds/);
});

test("Memory recall updates are performed in one query",()=>{
  assert.match(memorySource,/UPDATE memories[\s\S]*id IN \(\$\{placeholders\}\)/);
  assert.doesNotMatch(memorySource,/for \(const memory of memories\.slice\(0, Math\.min\(8, memories\.length\)\)\) await pool\.query/);
});

test("simulation identity reaches Gemini budget reservation",()=>{
  assert.match(geminiSource,/async generateJson\(prompt,schema,[\s\S]*simulationId=null,entityId=null,simulationTime=null/);
  assert.match(geminiSource,/budget\.reserve\(\{prompt,outputTokenCeiling:requestedOutputTokenCeiling,[\s\S]*minimumOutputTokenCeiling,[\s\S]*highValue,[\s\S]*simulationId,entityId,simulationTime\}\)/);
  assert.match(geminiSource,/async chooseDecision\(context,\{simulationId=null,entityId=null,simulationTime=null\}/);
  assert.match(geminiSource,/async dialogue\(context,\{simulationId=null,entityId=null,simulationTime=null\}/);
});
