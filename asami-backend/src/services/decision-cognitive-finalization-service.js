const { pool } = require("../db/pool");
const { env } = require("../config/env");

const TERMINAL_DECISION_STATUSES = new Set(["EXECUTED","FAILED","CANCELLED"]);
const MAX_RECONCILIATION_BATCH = 500;
const DEFAULT_GRACE_MINUTES = 5;

function cognitiveArtifactWindow(simulationTime,graceMinutes=DEFAULT_GRACE_MINUTES){
  const nowMs=new Date(simulationTime).getTime();
  if(!Number.isFinite(nowMs))return{valid:false,nowMs:NaN,validationCutoff:null,artifactCutoff:null};
  const graceMs=Math.max(1,Number(graceMinutes)||DEFAULT_GRACE_MINUTES)*60000;
  const retentionDays=Math.max(1,Number(env.RETENTION_COGNITIVE_ARTIFACT_DAYS)||14);
  const formatSqlDate=ms=>new Date(ms).toISOString().replace("T"," ").replace("Z","");
  return{valid:true,nowMs,validationCutoff:formatSqlDate(nowMs-graceMs),artifactCutoff:formatSqlDate(nowMs-retentionDays*86400000),retentionExemptBefore:new Date(nowMs-retentionDays*86400000).toISOString(),retentionDays};
}

function parseJson(value,fallback={}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeOutcome(value,status="EXECUTED") {
  const normalized=String(value||"").trim().toUpperCase();
  if (["SUCCESS","PARTIAL","FAILURE","CANCELLED","FAILED"].includes(normalized)) return normalized;
  if (status==="FAILED") return "FAILURE";
  if (status==="CANCELLED") return "CANCELLED";
  return "SUCCESS";
}

function outcomeScore(outcome) {
  const normalized=normalizeOutcome(outcome);
  if (normalized==="SUCCESS") return 1;
  if (normalized==="PARTIAL") return 0.5;
  return 0;
}

function calculateCognitiveRegret(expectedUtility,alternativeUtilities,outcomeScoreValue) {
  const expected=Number(expectedUtility||0);
  const alternatives=(alternativeUtilities||[]).map(Number).filter(Number.isFinite);
  const bestAlternative=Math.max(expected,...alternatives);
  return Math.max(0,bestAlternative-expected)*(1-outcomeScoreValue*0.5);
}

async function finalizeDecisionCognitiveArtifacts({
  simulationId,
  decisionId,
  simulationTime,
  outcome=null,
  entityId=null,
  actionType=null
}={}) {
  if (!simulationId || !decisionId || !simulationTime) return { skipped:true, reason:"invalid_arguments" };

  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [decisionRows]=await conn.query(
      "SELECT d.status,BIN_TO_UUID(d.entity_id) AS entityId,BIN_TO_UUID(d.action_id) AS actionId,"+
      "d.action_created AS actionCreated,d.action_outcome AS actionOutcome,d.actual_outcome AS actualOutcome,"+
      "d.simulation_time AS simulationTime,a.action_type AS actionType "+
      "FROM decisions d LEFT JOIN actions a ON a.id=d.action_id "+
      "WHERE d.id=UUID_TO_BIN(?) AND d.simulation_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
      [decisionId,simulationId]
    );
    const decision=decisionRows[0];

    if (!decision) {
      await conn.rollback();
      return { skipped:true, reason:"decision_not_found" };
    }

    const status=String(decision.status||"").trim().toUpperCase();
    if (!TERMINAL_DECISION_STATUSES.has(status)) {
      await conn.rollback();
      return { skipped:true, reason:"decision_not_terminal", status };
    }

    const actualPayload=parseJson(decision.actualOutcome,{})||{};
    const resolvedOutcome=normalizeOutcome(
      outcome || actualPayload.outcome || decision.actionOutcome || status,
      status
    );
    const score=outcomeScore(resolvedOutcome);
    const resolvedEntityId=entityId||decision.entityId||null;

    const [expectations]=await conn.query(
      "SELECT BIN_TO_UUID(id) AS id,action_type AS actionType,expected_utility AS expectedUtility,"+
      "expected_success_probability AS expectedSuccessProbability,version "+
      "FROM cognitive_expectations "+
      "WHERE simulation_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) "+
      "AND status='OPEN' ORDER BY created_simulation_at DESC LIMIT 1 FOR UPDATE",
      [simulationId,decisionId,resolvedEntityId]
    );
    const expectation=expectations[0]||null;

    const [counterfactualRows]=await conn.query(
      "SELECT BIN_TO_UUID(id) AS id,alternative_action AS alternativeAction,predicted_utility AS predictedUtility "+
      "FROM counterfactuals "+
      "WHERE simulation_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)",
      [simulationId,decisionId,resolvedEntityId]
    );

    const alternativeUtilities=counterfactualRows
      .map(row=>Number(row.predictedUtility))
      .filter(Number.isFinite);

    let regret=0;
    let expectationResolved=false;
    if (expectation) {
      regret=Math.min(1,Math.max(0,calculateCognitiveRegret(
        expectation.expectedUtility,
        alternativeUtilities,
        score
      )));
      const predictionError=score-Number(expectation.expectedSuccessProbability||0.5);
      const actualExpectation=JSON.stringify({
        outcome:resolvedOutcome,
        score,
        finalizedBy:"DECISION_COGNITIVE_RECONCILER"
      });
      const [updated]=await conn.query(
        "UPDATE cognitive_expectations SET actual_outcome=?,prediction_error=?,regret_score=?,"+
        "status='RESOLVED',resolved_simulation_at=?,version=version+1 "+
        "WHERE id=UUID_TO_BIN(?) AND status='OPEN' AND version=?",
        [actualExpectation,predictionError,regret,simulationTime,expectation.id,expectation.version]
      );
      expectationResolved=Boolean(updated.affectedRows);
    }

    if (counterfactualRows.length) {
      await conn.query(
        "UPDATE counterfactuals SET regret_score=?,version=version+1 "+
        "WHERE simulation_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)",
        [regret,simulationId,decisionId,resolvedEntityId]
      );
    }

    const [worldResult]=await conn.query(
      "UPDATE counterfactual_worlds SET actual_outcome=?,regret_score=?,status='RESOLVED',"+
      "resolved_simulation_at=?,version=version+1 "+
      "WHERE simulation_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='OPEN'",
      [resolvedOutcome,regret,simulationTime,simulationId,decisionId,resolvedEntityId]
    );

    const normalizedActionOutcome =
      resolvedOutcome==="FAILURE" || resolvedOutcome==="FAILED"
        ? "FAILURE"
        : resolvedOutcome==="CANCELLED"
          ? "CANCELLED"
          : resolvedOutcome;

    let actionOutcomeRepaired=false;
    if (!decision.actionOutcome && decision.actionId) {
      const [updated]=await conn.query(
        "UPDATE decisions SET action_outcome=? "+
        "WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND action_created=1 "+
        "AND action_id=UUID_TO_BIN(?) AND action_outcome IS NULL",
        [normalizedActionOutcome,decisionId,simulationId,decision.actionId]
      );
      actionOutcomeRepaired=Boolean(updated.affectedRows);
    }

    await conn.commit();
    return {
      repaired:true,
      expectationResolved,
      counterfactualsTouched:counterfactualRows.length,
      worldsResolved:Number(worldResult.affectedRows||0),
      regret,
      actionOutcomeRepaired,
      outcome:resolvedOutcome
    };
  } catch (error) {
    try { await conn.rollback(); } catch {}
    throw error;
  } finally {
    conn.release();
  }
}

async function reconcileTerminalDecisionCognition(
  simulationId,
  simulationTime,
  { limit=250, graceMinutes=DEFAULT_GRACE_MINUTES }={}
) {
  if (!simulationId || !simulationTime) return { checked:0,repaired:0 };
  const safeLimit=Math.max(1,Math.min(MAX_RECONCILIATION_BATCH,Number(limit)||250));
  const safeGrace=Math.max(1,Number(graceMinutes)||DEFAULT_GRACE_MINUTES);
  const nowMs=new Date(simulationTime).getTime();
  if (!Number.isFinite(nowMs)) return { checked:0,repaired:0,invalidSimulationTime:true };
  const window=cognitiveArtifactWindow(simulationTime,safeGrace);
  const cutoff=window.validationCutoff;
  const artifactCutoff=window.artifactCutoff;

  const [rows]=await pool.query(
    "SELECT BIN_TO_UUID(d.id) AS decisionId,BIN_TO_UUID(d.entity_id) AS entityId,d.status,d.simulation_time AS simulationTime "+
    "FROM decisions d "+
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') "+
    "AND d.simulation_time<=? AND d.simulation_time>=? AND ("+
      "EXISTS (SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id AND ce.status='OPEN') "+
      "OR EXISTS (SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id AND cw.status='OPEN') "+
      "OR (d.action_created=1 AND d.action_id IS NOT NULL AND d.action_outcome IS NULL)"+
    ") "+
    "ORDER BY d.simulation_time ASC LIMIT ?",
    [simulationId,cutoff,artifactCutoff,safeLimit]
  );

  let repaired=0;
  let errors=0;
  for (const row of rows) {
    try {
      const result=await finalizeDecisionCognitiveArtifacts({
        simulationId,
        decisionId:row.decisionId,
        entityId:row.entityId,
        simulationTime
      });
      if (result.repaired) repaired+=1;
    } catch {
      errors+=1;
    }
  }

  const invariant=await getTerminalCognitiveInvariant(simulationId,simulationTime,{graceMinutes:safeGrace});
  return { checked:rows.length,repaired,errors,...invariant };
}

async function getTerminalCognitiveInvariant(
  simulationId,
  simulationTime,
  { graceMinutes=DEFAULT_GRACE_MINUTES }={}
) {
  const nowMs=new Date(simulationTime).getTime();
  if (!Number.isFinite(nowMs)) {
    return {openExpectationViolations:0,openWorldViolations:0,missingExpectation:0,missingWorlds:0};
  }
  const window=cognitiveArtifactWindow(simulationTime,graceMinutes);
  const cutoff=window.validationCutoff;
  const artifactCutoff=window.artifactCutoff;
  const [rows]=await pool.query(
    "SELECT "+
      "SUM(CASE WHEN EXISTS(SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id AND ce.status='OPEN') THEN 1 ELSE 0 END) AS openExpectationViolations,"+
      "SUM(CASE WHEN EXISTS(SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id AND cw.status='OPEN') THEN 1 ELSE 0 END) AS openWorldViolations,"+
      "SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM cognitive_expectations ce WHERE ce.decision_id=d.id) THEN 1 ELSE 0 END) AS missingExpectation,"+
      "SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM counterfactual_worlds cw WHERE cw.decision_id=d.id) THEN 1 ELSE 0 END) AS missingWorlds "+
    "FROM decisions d "+
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time<=? AND d.simulation_time>=?",
    [simulationId,cutoff,artifactCutoff]
  );
  const row=rows[0]||{};
  const [exemptRows]=await pool.query(
    "SELECT COUNT(*) AS count FROM decisions d "+
    "WHERE d.simulation_id=UUID_TO_BIN(?) AND d.status IN ('EXECUTED','FAILED','CANCELLED') AND d.simulation_time<?",
    [simulationId,artifactCutoff]
  );
  return {
    openExpectationViolations:Number(row.openExpectationViolations||0),
    openWorldViolations:Number(row.openWorldViolations||0),
    missingExpectation:Number(row.missingExpectation||0),
    missingWorlds:Number(row.missingWorlds||0),
    artifactRetentionDays:window.retentionDays,
    artifactCutoff,
    retentionExemptTerminalDecisions:Number(exemptRows[0]?.count||0)
  };
}

module.exports={
  finalizeDecisionCognitiveArtifacts,
  reconcileTerminalDecisionCognition,
  getTerminalCognitiveInvariant,
  normalizeOutcome,
  outcomeScore,
  calculateCognitiveRegret,
  cognitiveArtifactWindow
};
