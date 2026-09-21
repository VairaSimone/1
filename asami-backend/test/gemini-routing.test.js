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
