const test=require("node:test");
const assert=require("node:assert/strict");
const { pool }=require("../src/db/pool");
const { persistConflicts }=require("../src/services/cognitive-v2-service");

function mockDb(rows){
  const original=pool.query;
  const calls=[];
  pool.query=async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes("FROM cognitive_conflicts"))return [rows];
    if(sql.startsWith("UPDATE cognitive_conflicts"))return [{affectedRows:1}];
    if(sql.startsWith("INSERT INTO cognitive_conflicts"))return [{affectedRows:1}];
    throw new Error("Unexpected SQL");
  };
  return {calls,restore:()=>{pool.query=original;}};
}

test("stale active conflicts are resolved when no longer generated",async()=>{
  const db=mockDb([{id:"conflict-1",fingerprint:"NEED:CURIOSITY|NEED:SLEEPINESS",version:4,status:"ACTIVE"}]);
  try{
    const result=await persistConflicts("sim-1","entity-1","2026-09-19T12:00:00.000Z",[]);
    assert.equal(result.active,0);
    assert.equal(result.resolved,1);
    assert.equal(db.calls.length,2);
    assert.match(db.calls[1].sql,/status=\x27RESOLVED\x27/);
    assert.match(String(db.calls[1].values[0]),/DRIVERS_NO_LONGER_COMPETE/);
  }finally{db.restore();}
});

test("resolved conflict is reopened instead of duplicating its fingerprint",async()=>{
  const fingerprint="NEED:CURIOSITY|NEED:SLEEPINESS";
  const db=mockDb([{id:"conflict-1",fingerprint,version:7,status:"RESOLVED"}]);
  try{
    const result=await persistConflicts("sim-1","entity-1","2026-09-19T13:00:00.000Z",[{left:{type:"NEED",code:"CURIOSITY",intensity:.8},right:{type:"NEED",code:"SLEEPINESS",intensity:.78},intensity:.79}]);
    assert.equal(result.active,1);
    assert.equal(result.reopened,1);
    assert.equal(db.calls.length,2);
    assert.match(db.calls[1].sql,/status=\x27ACTIVE\x27/);
    assert.equal(db.calls[1].values[0].includes(""type":"NEED""),true);
  }finally{db.restore();}
});

test("active conflict is refreshed when the competing motives still exist",async()=>{
  const fingerprint="NEED:CURIOSITY|NEED:SLEEPINESS";
  const db=mockDb([{id:"conflict-1",fingerprint,version:9,status:"ACTIVE"}]);
  try{
    const result=await persistConflicts("sim-1","entity-1","2026-09-19T14:00:00.000Z",[{left:{type:"NEED",code:"CURIOSITY",intensity:.9},right:{type:"NEED",code:"SLEEPINESS",intensity:.8},intensity:.85}]);
    assert.equal(result.active,1);
    assert.equal(result.resolved,0);
    assert.equal(result.reopened,0);
    assert.equal(db.calls.length,2);
  }finally{db.restore();}
});