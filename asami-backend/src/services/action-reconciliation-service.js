const { pool } = require("../db/pool");
const { advancePlanForAction } = require("./planning-service");
const { markActionPostProcessingComplete } = require("./action-service");
const logger = require("../lib/logger");

async function reconcileCompletedActions(simulationId,{limit=100}={}) {
  if(!simulationId)return{checked:0,reconciled:0};
  const safeLimit=Math.max(1,Math.min(500,Number(limit)||100));
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(a.id) AS actionId,
            BIN_TO_UUID(a.entity_id) AS entityId,
            BIN_TO_UUID(a.decision_id) AS decisionId,
            BIN_TO_UUID(a.source_intention_id) AS intentionId,
            BIN_TO_UUID(a.source_goal_id) AS goalId,
            a.action_type AS actionType,
            a.status AS status,
            a.completed_simulation_at AS completedSimulationAt,
            a.result,
            a.version,
            d.status AS decisionStatus,
            i.status AS intentionStatus
     FROM actions a
     LEFT JOIN decisions d ON d.id=a.decision_id
     LEFT JOIN intentions i ON i.id=a.source_intention_id
     WHERE a.simulation_id=UUID_TO_BIN(?)
       AND a.status IN ('COMPLETED','INTERRUPTED')
       AND a.post_processing_status='PENDING'
     ORDER BY a.completed_simulation_at ASC
     LIMIT ?`,
    [simulationId,safeLimit]
  );
  let reconciled=0;
  for(const row of rows){
    try{
      const result=typeof row.result==="string" ? (()=>{try{return JSON.parse(row.result||"{}");}catch{return{};}})() : row.result||{};
      const terminalStatus=String(row.status||"COMPLETED").toUpperCase();
      if(terminalStatus==="INTERRUPTED"){
        if(row.decisionId && ["CREATED","EVALUATED"].includes(String(row.decisionStatus||"").toUpperCase())){
          await pool.query(
            `UPDATE decisions SET status='EXECUTED',actual_outcome=COALESCE(actual_outcome,?)
             WHERE id=UUID_TO_BIN(?) AND status IN ('CREATED','EVALUATED')`,
            [JSON.stringify({
              actionId:row.actionId,
              outcome:result.outcome||"PARTIAL",
              success:false,
              failureReason:result.failureReason||"ACTION_INTERRUPTED",
              interrupted:true,
              recoveredBy:"ACTION_RECONCILER"
            }),row.decisionId]
          );
        }
        if(row.intentionId && String(row.intentionStatus||"").toUpperCase()==="ACTIVE"){
          await pool.query(
            `UPDATE intentions SET status='CANCELLED',version=version+1
             WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
            [row.intentionId]
          );
        }
        await markActionPostProcessingComplete(row.actionId);
        reconciled+=1;
        continue;
      }
      if(row.decisionId && ["CREATED","EVALUATED"].includes(String(row.decisionStatus||"").toUpperCase())){
        await pool.query(
          `UPDATE decisions
           SET status='EXECUTED',
               actual_outcome=COALESCE(actual_outcome,?)
           WHERE id=UUID_TO_BIN(?) AND status IN ('CREATED','EVALUATED')`,
          [JSON.stringify({
            actionId:row.actionId,
            outcome:result.outcome||"SUCCESS",
            success:result.success!==false,
            failureReason:result.failureReason||null,
            recoveredBy:"ACTION_RECONCILER"
          }),row.decisionId]
        );
      }
      if(row.intentionId && String(row.intentionStatus||"").toUpperCase()==="ACTIVE"){
        await pool.query(
          `UPDATE intentions SET status='COMPLETED',version=version+1
           WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
          [row.intentionId]
        );
      }
      if(row.goalId){
        await advancePlanForAction({
          simulationId,
          entityId:row.entityId,
          goalId:row.goalId,
          actionType:row.actionType,
          outcome:result.outcome||"SUCCESS",
          simulationTime:row.completedSimulationAt,
          actionResult:{...result,actionId:row.actionId,simulationId,entityId:row.entityId}
        });
      }
      await markActionPostProcessingComplete(row.actionId);
      reconciled+=1;
    }catch(err){
      logger.error({
        simulationId,
        actionId:row.actionId,
        entityId:row.entityId,
        event:"ACTION_RECONCILIATION_FAILED",
        err
      },"completed action reconciliation failed");
    }
  }
  return{checked:rows.length,reconciled};
}

module.exports={reconcileCompletedActions};
