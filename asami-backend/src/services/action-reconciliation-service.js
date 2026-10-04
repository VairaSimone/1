const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { advancePlanForAction } = require("./planning-service");
const { markActionPostProcessingComplete } = require("./action-service");
const logger = require("../lib/logger");

async function reconcileStaleEvaluatedDecisions(simulationId,simulationTime,{limit=null}={}){
  if(!simulationId||!simulationTime)return{checked:0,repaired:0,kept:0};

  const safeLimit=Math.max(
    1,
    Math.min(
      500,
      Number(limit||env.DECISION_RECONCILIATION_BATCH_SIZE)||100
    )
  );
  const graceMinutes=Math.max(
    1,
    Number(env.DECISION_RECONCILIATION_GRACE_MINUTES)||5
  );

  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(d.id) AS decisionId,
            BIN_TO_UUID(d.entity_id) AS entityId,
            d.simulation_time AS simulationTime,
            d.status AS decisionStatus,
            BIN_TO_UUID(i.id) AS intentionId,
            i.status AS intentionStatus,
            BIN_TO_UUID(a.id) AS actionId,
            a.status AS actionStatus
     FROM decisions d
     LEFT JOIN intentions i
       ON i.decision_id=d.id
      AND i.simulation_id=d.simulation_id
     LEFT JOIN actions a
       ON a.decision_id=d.id
      AND a.simulation_id=d.simulation_id
     WHERE d.simulation_id=UUID_TO_BIN(?)
       AND d.status='EVALUATED'
       AND d.simulation_time<=DATE_SUB(?,INTERVAL ? MINUTE)
     ORDER BY d.simulation_time ASC
     LIMIT ?`,
    [simulationId,simulationTime,graceMinutes,safeLimit]
  );

  let repaired=0,kept=0;
  for(const row of rows){
    const actionStatus=String(row.actionStatus||"").toUpperCase();
    const intentionStatus=String(row.intentionStatus||"").toUpperCase();

    if(["ACTIVE","COMPLETED","INTERRUPTED"].includes(actionStatus)){
      kept+=1;
      continue;
    }

    if(["FAILED","CANCELLED"].includes(actionStatus)){
      const nextStatus=actionStatus==="FAILED"?"FAILED":"CANCELLED";
      const [updated]=await pool.query(
        `UPDATE decisions
         SET status=?,
             actual_outcome=COALESCE(
               actual_outcome,
               JSON_OBJECT(
                 'failureReason',?,
                 'recoveredBy','DECISION_RECONCILER',
                 'actionId',BIN_TO_UUID(?)
               )
             )
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND status='EVALUATED'`,
        [
          nextStatus,
          nextStatus==="FAILED"?"ACTION_TERMINAL_WITHOUT_DECISION_FINALIZATION":"ACTION_CANCELLED_WITHOUT_DECISION_FINALIZATION",
          row.actionId,
          row.decisionId,
          simulationId
        ]
      );
      if(updated.affectedRows)repaired+=1;
      continue;
    }

    // No executable action exists for this stale decision. The direct
    // decision_id link makes the intention unambiguous, so cancel it before
    // failing the decision rather than leaving an orphan ACTIVE intention.
    if(row.intentionId&&intentionStatus==="ACTIVE"){
      await pool.query(
        `UPDATE intentions
         SET status='CANCELLED',version=version+1
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND decision_id=UUID_TO_BIN(?)
           AND status='ACTIVE'`,
        [row.intentionId,simulationId,row.decisionId]
      );
    }

    const [updated]=await pool.query(
      `UPDATE decisions
       SET status='FAILED',
           actual_outcome=?
       WHERE id=UUID_TO_BIN(?)
         AND simulation_id=UUID_TO_BIN(?)
         AND status='EVALUATED'`,
      [
        JSON.stringify({
          failureReason:"DECISION_PIPELINE_INCOMPLETE",
          missingAction:true,
          intentionId:row.intentionId||null,
          intentionStatus:row.intentionStatus||null,
          recoveredBy:"DECISION_RECONCILER",
          reconciledAt:simulationTime
        }),
        row.decisionId,
        simulationId
      ]
    );
    if(updated.affectedRows){
      repaired+=1;
      logger.warn({
        simulationId,
        entityId:row.entityId,
        decisionId:row.decisionId,
        intentionId:row.intentionId||null,
        simulationTime:row.simulationTime,
        event:"STALE_EVALUATED_DECISION_REPAIRED",
        reason:"DECISION_PIPELINE_INCOMPLETE"
      },"stale evaluated decision had no executable action");
    }
  }

  return{checked:rows.length,repaired,kept};
}

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
        if(await markActionPostProcessingComplete(row.actionId)) reconciled+=1;
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
      if(await markActionPostProcessingComplete(row.actionId)) reconciled+=1;
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

module.exports={reconcileCompletedActions,reconcileStaleEvaluatedDecisions};
