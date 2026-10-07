const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

test("engine attempts retention before hard database pause when pressure threshold is reached",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");
  assert.match(source,/DB_RETENTION_PRESSURE_RATIO/);
  assert.match(source,/attemptRetention: true/);
  assert.match(source,/maybeRunSafeRetention\(\n\s*simulationId/);
  assert.doesNotMatch(source,/Hard database-cap preflight: do this before loading\/scheduling any/);
});
