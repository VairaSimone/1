const test=require("node:test");
const assert=require("node:assert/strict");
const {classifyGeminiError}=require("../src/ai/gemini");

test("Gemini quota errors are distinguished from rate limits",()=>{
  assert.deepEqual(classifyGeminiError(Object.assign(new Error("RESOURCE_EXHAUSTED quota exceeded"),{code:429})),{kind:"QUOTA",retryAfterMs:0});
  assert.equal(classifyGeminiError(Object.assign(new Error("Too many requests"),{status:429})).kind,"RATE_LIMIT");
  assert.equal(classifyGeminiError(new Error("daily quota exceeded")).kind,"QUOTA");
});

test("Gemini retry delays are extracted from provider responses",()=>{
  assert.equal(classifyGeminiError(new Error('RESOURCE_EXHAUSTED retryDelay="12.5s"')).retryAfterMs,12500);
  assert.equal(classifyGeminiError({status:429,response:{headers:{"retry-after":"7"}}}).retryAfterMs,7000);
});

test("non-provider failures remain separate from rate/quota fallback",()=>{
  assert.equal(classifyGeminiError(Object.assign(new Error("Gemini timeout"),{code:"AI_TIMEOUT"})).kind,"TIMEOUT");
  assert.equal(classifyGeminiError(new Error("invalid JSON")).kind,"ERROR");
});

test("autonomy skips Gemini while the provider circuit breaker is active",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/autonomy-service.js"),"utf8");
  assert.match(source,/geminiBudget\.providerBlockRemainingMs\(\)>0/);
});
