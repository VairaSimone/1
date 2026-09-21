const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const geminiSource=fs.readFileSync(path.join(__dirname,"../src/ai/gemini.js"),"utf8");
const envSource=fs.readFileSync(path.join(__dirname,"../src/config/env.js"),"utf8");

test("Gemini uses a stable multi-model fallback chain",()=>{
  assert.match(envSource,/GEMINI_MODEL[\s\S]*default\("gemini-3\.8-flash"\)/);
  assert.match(envSource,/GEMINI_FALLBACK_MODELS/);
  assert.match(geminiSource,/this\.models=\[this\.model,\.\.\.\(Array\.isArray\(env\.GEMINI_FALLBACK_MODELS\)/);
});

test("Gemini transient failures are isolated per model",()=>{
  assert.match(geminiSource,/this\.modelStates=new Map\(\)/);
  assert.match(geminiSource,/failureStreak:0,blockedUntil:0,reason:null/);
  assert.match(geminiSource,/_blockModel\(model,transientCooldown,fallbackReason\)/);
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

test("Autonomy availability ignores a single blocked model",()=>{
  assert.match(geminiSource,/if\(budget\.providerBlockRemainingMs\(\)>0\|\|!this\._hasAvailableModel\(\)\)return false/);
  assert.match(geminiSource,/\._availableModels\(\)/);
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
  assert.match(geminiSource,/this\._blockModel\(model,modelCooldown,fallbackReason\)/);
  assert.match(geminiSource,/Gemini model limit reached; trying fallback model/);
  assert.match(geminiSource,/if\(!this\._hasAvailableModel\(\)\)return false/);
});

test("Gemini startup exposes the effective autonomy output ceiling",()=>{
  assert.match(geminiSource,/autonomyOutputTokenCeiling:env\.GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING/);
});
