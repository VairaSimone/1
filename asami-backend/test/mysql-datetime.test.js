const test=require("node:test");
const assert=require("node:assert/strict");
const { normalizeSimulationTimestamp, normalizeMysqlValues }=require("../src/db/pool");

test("normalizes ISO simulation timestamps to MySQL DATETIME(3)",()=>{
  assert.equal(normalizeSimulationTimestamp("2026-10-05T23:23:12.840Z"),"2026-10-05 23:23:12.840");
  assert.equal(normalizeSimulationTimestamp("2026-10-05T23:23:12.84Z"),"2026-10-05 23:23:12.840");
});

test("preserves non-timestamp strings",()=>{
  assert.equal(normalizeSimulationTimestamp("AUTONOMOUS"),"AUTONOMOUS");
  assert.equal(normalizeSimulationTimestamp('{"at":"2026-10-05T23:23:12.840Z"}'),' {"at":"2026-10-05T23:23:12.840Z"}'.trim());
});

test("normalizes query parameter arrays without changing Date or Buffer values",()=>{
  const date=new Date("2026-10-05T23:23:12.840Z");
  const buffer=Buffer.from("id");
  const values=normalizeMysqlValues(["2026-10-05T23:23:12.840Z",date,buffer,"x"]);
  assert.equal(values[0],"2026-10-05 23:23:12.840");
  assert.equal(values[1],date);
  assert.equal(values[2],buffer);
  assert.equal(values[3],"x");
});
