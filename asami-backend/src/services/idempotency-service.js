const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

async function runIdempotent(simulationId,operationKey,operationType,fn){
  const [existing]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,status,result FROM simulation_operations
    WHERE simulation_id=UUID_TO_BIN(?) AND operation_key=? LIMIT 1
  `,[simulationId,operationKey]);
  if(existing.length){
    if(existing[0].status==="COMPLETED") return existing[0].result;
    if(existing[0].status==="STARTED")
      throw Object.assign(new Error("Operation already in progress"),{code:"OPERATION_IN_PROGRESS"});
  }
  await pool.query(`
    INSERT INTO simulation_operations(id,simulation_id,operation_key,operation_type,status)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'STARTED')
  `,[uuid(),simulationId,operationKey,operationType]);
  try{
    const result=await fn();
    await pool.query(`
      UPDATE simulation_operations SET status='COMPLETED',result=?,completed_real_at=CURRENT_TIMESTAMP(3)
      WHERE simulation_id=UUID_TO_BIN(?) AND operation_key=?
    `,[JSON.stringify(result),simulationId,operationKey]);
    return result;
  }catch(err){
    await pool.query(`
      UPDATE simulation_operations SET status='FAILED',result=?,completed_real_at=CURRENT_TIMESTAMP(3)
      WHERE simulation_id=UUID_TO_BIN(?) AND operation_key=?
    `,[JSON.stringify({error:err.message}),simulationId,operationKey]);
    throw err;
  }
}
module.exports={runIdempotent};
