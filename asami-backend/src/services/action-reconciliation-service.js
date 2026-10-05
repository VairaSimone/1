const { pool, normalizeSimulationTimestamp } = require("../db/pool");
const { env } = require("../config/env");
const { advancePlanForAction } = require("./planning-service");
const { markActionPostProcessingComplete } = require("./action-service");
const logger = require("../lib/logger");

async function reconcileStaleEvaluatedDecisions(simulationId,simulationTime,{limit=null}={}){
  if(!simulationId||!simulationTime)return{checked:0,repaired:0,kept:0,stale:0,remainingStale:0,invariantViolations:0};

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
  const maxEvaluatedMinutes=Math.max(
    graceMinutes,
    Number(env.DECISION_RECONCILIATION_MAX_EVALUATED_MINUTES)||720
  );
  const simulationNowMs=new Date(simulationTime).getTime();
  if(!Number.isFinite(simulationNowMs))throw new TypeError("simulationTime must be a valid timestamp");

  const cutoffSimulationTime=normalizeSimulationTimestamp(
    new Date(simulationNowMs-graceMinutes*60000)
  );

  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(d.id) AS decisionId,
            BIN_TO_UUID(d.entity_id) AS entityId,
            d.simulation_time AS simulationTime,
            d.status AS decisionStatus,
            BIN_TO_UUID(i.id) AS intentionId,
            i.status AS intentionStatus,
            BIN_TO_UUID(a.id) AS actionId,
            a.status AS actionStatus,
            a.action_type AS actionType,
            a.started_simulation_at AS actionStartedSimulationAt,
            a.parameters AS actionParameters,
            a.result AS actionResult
     FROM decisions d
     LEFT JOIN intentions i
       ON i.decision_id=d.id
      AND i.simulation_id=d.simulation_id
     LEFT JOIN actions a
       ON a.decision_id=d.id
      AND a.simulation_id=d.simulation_id
     WHERE d.simulation_id=UUID_TO_BIN(?)
       AND d.status='EVALUATED'
       AND d.simulation_time<=?
     ORDER BY d.simulation_time ASC
     LIMIT ?`,
    [simulationId,cutoffSimulationTime,safeLimit]
  );

  let repaired=0,kept=0,invariantViolations=0;
  for(const row of rows){
    const decisionAgeMinutes=Math.max(
      0,
      (simulationNowMs-new Date(row.simulationTime).getTime())/60000
    );
    const actionStatus=String(row.actionStatus||"").toUpperCase();
    const intentionStatus=String(row.intentionStatus||"").toUpperCase();
    const actionResult=parseJson(row.actionResult,{})||{};
    const actionParameters=parseJson(row.actionParameters,{})||{};

    if(actionStatus==="COMPLETED"){
      const [updated]=await pool.query(
        `UPDATE decisions
         SET status='EXECUTED',
             actual_outcome=COALESCE(
               actual_outcome,
               ?
             )
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND status='EVALUATED'`,
        [
          JSON.stringify({
            actionId:row.actionId,
            outcome:actionResult.outcome||"SUCCESS",
            success:actionResult.success!==false,
            failureReason:actionResult.failureReason||null,
            recoveredBy:"DECISION_RECONCILER"
          }),
          row.decisionId,
          simulationId
        ]
      );
      if(updated.affectedRows){
        if(row.intentionId&&intentionStatus==="ACTIVE"){
          await pool.query(
            `UPDATE intentions
             SET status='COMPLETED',version=version+1
             WHERE id=UUID_TO_BIN(?)
               AND simulation_id=UUID_TO_BIN(?)
               AND decision_id=UUID_TO_BIN(?)
               AND status='ACTIVE'`,
            [row.intentionId,simulationId,row.decisionId]
          );
        }
        repaired+=1;
      }
      continue;
    }

    if(actionStatus==="INTERRUPTED"){
      const [updated]=await pool.query(
        `UPDATE decisions
         SET status='EXECUTED',
             actual_outcome=COALESCE(
               actual_outcome,
               ?
             )
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND status='EVALUATED'`,
        [
          JSON.stringify({
            actionId:row.actionId,
            outcome:actionResult.outcome||"PARTIAL",
            success:false,
            failureReason:actionResult.failureReason||"ACTION_INTERRUPTED",
            interrupted:true,
            recoveredBy:"DECISION_RECONCILER"
          }),
          row.decisionId,
          simulationId
        ]
      );
      if(updated.affectedRows){
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
        repaired+=1;
      }
      continue;
    }

    if(actionStatus==="FAILED"||actionStatus==="CANCELLED"){
      const nextStatus=actionStatus==="FAILED"?"FAILED":"CANCELLED";
      const [updated]=await pool.query(
        `UPDATE decisions
         SET status=?,
             actual_outcome=COALESCE(
               actual_outcome,
               ?
             )
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND status='EVALUATED'`,
        [
          nextStatus,
          JSON.stringify({
            failureReason:actionResult.failureReason||(
              actionStatus==="FAILED"
                ?"ACTION_FAILED_WITHOUT_DECISION_FINALIZATION"
                :"ACTION_CANCELLED_WITHOUT_DECISION_FINALIZATION"
            ),
            recoveredBy:"DECISION_RECONCILER",
            actionId:row.actionId
          }),
          row.decisionId,
          simulationId
        ]
      );
      if(updated.affectedRows){
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
        repaired+=1;
      }
      continue;
    }

    if(actionStatus==="ACTIVE"){
      const expectedCompletionSimulationAt=
        actionResult.expectedCompletionSimulationAt||
        actionParameters.expectedCompletionSimulationAt||
        null;
      const expectedCompletionMs=expectedCompletionSimulationAt
        ?new Date(expectedCompletionSimulationAt).getTime()
        :NaN;
      const startedMs=new Date(row.actionStartedSimulationAt).getTime();
      const configuredDurationMinutes=Number(
        actionResult.durationMinutes||
        actionParameters.durationMinutes||
        getActionDurationMinutes(row.actionType)
      );
      const derivedDeadlineMs=Number.isFinite(startedMs)&&Number.isFinite(configuredDurationMinutes)
        ?startedMs+Math.max(1,configuredDurationMinutes)*60000
        :NaN;
      const deadlineMs=Number.isFinite(expectedCompletionMs)
        ?expectedCompletionMs
        :derivedDeadlineMs;
      const overdueByAction=Number.isFinite(deadlineMs)&&simulationNowMs>deadlineMs+graceMinutes*60000;
      const overdueByDecision=decisionAgeMinutes>maxEvaluatedMinutes;

      if(!overdueByAction&&!overdueByDecision){
        kept+=1;
        continue;
      }

      invariantViolations+=1;
      const failureReason=overdueByDecision
        ?"EVALUATED_DECISION_MAX_AGE_EXCEEDED"
        :"ACTIVE_ACTION_COMPLETION_DEADLINE_EXCEEDED";
      const staleActionResult={
        ...actionResult,
        outcome:"FAILURE",
        success:false,
        failureReason,
        recoveredBy:"DECISION_RECONCILER",
        reconciledAt:simulationTime,
        decisionAgeMinutes:Number(decisionAgeMinutes.toFixed(2)),
        expectedCompletionSimulationAt:expectedCompletionSimulationAt||null
      };

      const [actionUpdated]=await pool.query(
        `UPDATE actions
         SET status='FAILED',
             completed_simulation_at=?,
             result=?,
             version=version+1
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND entity_id=UUID_TO_BIN(?)
           AND status='ACTIVE'`,
        [
          simulationTime,
          JSON.stringify(staleActionResult),
          row.actionId,
          simulationId,
          row.entityId
        ]
      );

      if(!actionUpdated.affectedRows){
        kept+=1;
        continue;
      }

      const movementId=actionResult.movement?.movementId||actionParameters.movement?.movementId||null;
      if(movementId){
        await pool.query(
          `UPDATE movements
           SET status='CANCELLED',
               reason='stale active action recovered',
               version=version+1
           WHERE id=UUID_TO_BIN(?)
             AND simulation_id=UUID_TO_BIN(?)
             AND entity_id=UUID_TO_BIN(?)
             AND status IN ('PLANNED','ACTIVE')`,
          [movementId,simulationId,row.entityId]
        );
      }

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

      const [decisionUpdated]=await pool.query(
        `UPDATE decisions
         SET status='FAILED',
             actual_outcome=?
         WHERE id=UUID_TO_BIN(?)
           AND simulation_id=UUID_TO_BIN(?)
           AND status='EVALUATED'`,
        [
          JSON.stringify({
            failureReason,
            actionId:row.actionId,
            recoveredBy:"DECISION_RECONCILER",
            reconciledAt:simulationTime
          }),
          row.decisionId,
          simulationId
        ]
      );
      if(decisionUpdated.affectedRows)repaired+=1;

      logger.warn({
        simulationId,
        entityId:row.entityId,
        decisionId:row.decisionId,
        actionId:row.actionId,
        simulationTime:row.simulationTime,
        failureReason,
        decisionAgeMinutes:Number(decisionAgeMinutes.toFixed(2)),
        expectedCompletionSimulationAt:expectedCompletionSimulationAt||null,
        event:"STALE_EVALUATED_DECISION_INVARIANT_VIOLATION"
      },"stale evaluated decision exceeded its allowed lifetime");
      continue;
    }

    invariantViolations+=1;
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

  const [remainingRows]=await pool.query(
    `SELECT COUNT(*) AS count
     FROM decisions
     WHERE simulation_id=UUID_TO_BIN(?)
       AND status='EVALUATED'
       AND simulation_time<=?`,
    [simulationId,cutoffSimulationTime]
  );
  const remainingStale=Number(remainingRows[0]?.count||0);

  observability.increment(simulationId,"stale_evaluated_decisions_total",rows.length);
  if(repaired)observability.increment(simulationId,"stale_evaluated_decisions_repaired_total",repaired);
  if(invariantViolations)observability.increment(
    simulationId,
    "stale_evaluated_decision_invariant_violations_total",
    invariantViolations
  );
  observability.setGauge(simulationId,"stale_evaluated_decisions_current",remainingStale);

  return{
    checked:rows.length,
    repaired,
    kept,
    stale:rows.length,
    remainingStale,
    invariantViolations
  };
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
