const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { ACTIONS, scoreAction } = require("./decision-rules");
const { getCognitiveProfile, cognitiveDecisionModifier } = require("./personality-service");

function normalizeAction(value) {
  return String(value || "").trim().toUpperCase();
}

function applyPlanBias(candidates, plans) {
  if (!Array.isArray(candidates) || !Array.isArray(plans)) return candidates;
  const activeStepActions = new Set();
  for (const plan of plans) {
    const step = (plan.steps || []).find(s => s.status === "ACTIVE" || s.status === "PENDING");
    const action = normalizeAction(step?.actionType || step?.result?.actionType);
    if (action) activeStepActions.add(action);
  }
  if (!activeStepActions.size) return candidates;
  return candidates.map(candidate => {
    const action = normalizeAction(candidate.action);
    return activeStepActions.has(action)
      ? { ...candidate, score: Number(candidate.score || 0) + 0.4 }
      : candidate;
  }).sort((a,b) => b.score - a.score);
}

async function buildDecisionContext(simulationId, entityId){
  const [[needs],[traits],[goals],[location]] = await Promise.all([
    pool.query(`
      SELECT nd.code,enc.value,nd.priority_weight AS priorityWeight
      FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id
      WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1
    `,[entityId]),
    pool.query(`
      SELECT td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id
      WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
    `,[entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(id) AS id,title,goal_type AS goalType,priority,progress,motivation
      FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('ACTIVE','PENDING')
      ORDER BY priority DESC LIMIT 10
    `,[simulationId,entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current
      WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
    `,[simulationId,entityId])
  ]);
  const cognitiveProfile = await getCognitiveProfile(simulationId, entityId);
  let candidates=ACTIONS.map(action=>({action,score:scoreAction(action,needs,traits)}));

  // cognitiveDecisionModifier works on one action at a time, not on the whole candidates array.
  candidates = candidates.map(candidate => ({
    ...candidate,
    score: Number(candidate.score || 0) + cognitiveDecisionModifier(cognitiveProfile, candidate.action)
  })).sort((a,b) => b.score - a.score);

  candidates = applyPlanBias(candidates, cognitiveProfile.plans);
  return {needs,traits,goals,location:location[0]||null,cognitiveProfile,allowedActionTypes:ACTIONS,candidates:candidates.slice(0,6)};
}

async function makeDecision({simulationId,entityId,simulationTime,triggerType="AUTONOMOUS",triggerEventId=null,context,aiChoice=null}){
  const decisionId=uuid();
  const candidates=Array.isArray(context?.candidates) ? context.candidates : [];
  const chosen=aiChoice?.selectedActionType && ACTIONS.includes(aiChoice.selectedActionType)
    ? aiChoice.selectedActionType : candidates[0]?.action || "RESTING";
  await pool.query(`
    INSERT INTO decisions
      (id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?, 'CREATED',1)
  `,[decisionId,simulationId,entityId,simulationTime,triggerEventId,triggerType,JSON.stringify({...context,aiChoice:aiChoice||null})]);
  const optionId=uuid();
  await pool.query(`
    INSERT INTO decision_options(id,decision_id,option_code,description,action_definition,evaluation,expected_outcome)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?, ?,?)
  `,[optionId,decisionId,chosen,`Autonomously selected ${chosen}`,
    JSON.stringify({actionType:chosen}),
    JSON.stringify({score:candidates.find(x=>x.action===chosen)?.score||0}),
    JSON.stringify({actionType:chosen})]);
  await pool.query(`
    UPDATE decisions
    SET selected_option_id=UUID_TO_BIN(?),status='EVALUATED',expected_outcome=?
    WHERE id=UUID_TO_BIN(?)
  `,[optionId,JSON.stringify({actionType:chosen}),decisionId]);
  return {decisionId,actionType:chosen,reason:aiChoice?.reason||"deterministic need/trait/cognitive score",confidence:aiChoice?.confidence??0.7};
}
module.exports={ACTIONS,scoreAction,buildDecisionContext,makeDecision};