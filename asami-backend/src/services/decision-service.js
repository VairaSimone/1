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

function applyRecentActionPenalty(candidates, recentActions) {
  if (!Array.isArray(candidates) || !recentActions?.length) return candidates;
  const normalized = recentActions.map(normalizeAction);
  return candidates.map(candidate => {
    const action = normalizeAction(candidate.action);
    const lastIndex = normalized.indexOf(action);
    if (lastIndex === 0) return { ...candidate, score: Number(candidate.score || 0) - 0.75 };
    if (lastIndex > 0 && lastIndex < 3) return { ...candidate, score: Number(candidate.score || 0) - 0.3 };
    return candidate;
  }).sort((a,b) => b.score - a.score);
}

function applySocialContext(candidates, nearbyEntities, relationships) {
  if (!Array.isArray(candidates)) return candidates;
  const socialCandidates = Array.isArray(nearbyEntities) && nearbyEntities.length > 0;
  const relationshipCount = Array.isArray(relationships) ? relationships.length : 0;
  return candidates.map(candidate => {
    if (candidate.action === "TALKING" && socialCandidates) {
      return { ...candidate, score: Number(candidate.score || 0) + Math.min(0.35, nearbyEntities.length * 0.12) };
    }
    if (candidate.action === "PLAYING" && socialCandidates) {
      return { ...candidate, score: Number(candidate.score || 0) + Math.min(0.18, nearbyEntities.length * 0.06) };
    }
    if (candidate.action === "TALKING" && relationshipCount === 0 && !socialCandidates) {
      return { ...candidate, score: Number(candidate.score || 0) - 0.2 };
    }
    return candidate;
  }).sort((a,b) => b.score - a.score);
}

async function buildDecisionContext(simulationId, entityId){
  const [[needs],[traits],[goals],[location],[recentActions],[nearbyEntities],[relationships]] = await Promise.all([
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
    `,[simulationId,entityId]),
    pool.query(`
      SELECT action_type AS actionType
      FROM actions
      WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='COMPLETED'
      ORDER BY started_simulation_at DESC LIMIT 6
    `,[simulationId,entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(e.id) AS entityId,e.display_name AS displayName,
             BIN_TO_UUID(elc.location_id) AS locationId
      FROM entity_locations_current elc
      JOIN entities e ON e.id=elc.entity_id
      JOIN entity_types et ON et.id=e.entity_type_id
      WHERE elc.simulation_id=UUID_TO_BIN(?)
        AND et.code='PERSON'
        AND elc.location_id=(SELECT location_id FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1)
        AND e.id<>UUID_TO_BIN(?) AND e.status='ACTIVE'
      ORDER BY e.display_name LIMIT 12
    `,[simulationId,simulationId,entityId,entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(r.id) AS id,rt.code AS type,
             BIN_TO_UUID(CASE WHEN r.source_entity_id=UUID_TO_BIN(?) THEN r.target_entity_id ELSE r.source_entity_id END) AS targetEntityId,
             r.trust_score AS trust,r.affection_score AS affection,r.familiarity_score AS familiarity,
             r.closeness_score AS closeness,r.conflict_score AS conflict
      FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
      WHERE r.simulation_id=UUID_TO_BIN(?) AND r.status='ACTIVE'
        AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?))
      ORDER BY r.closeness_score DESC,r.familiarity_score DESC LIMIT 12
    `,[entityId,simulationId,entityId,entityId])
  ]);

  const cognitiveProfile = await getCognitiveProfile(simulationId, entityId);
  let candidates=ACTIONS.map(action=>({action,score:scoreAction(action,needs,traits)}));

  candidates = candidates.map(candidate => ({
    ...candidate,
    score: Number(candidate.score || 0) + cognitiveDecisionModifier(cognitiveProfile, candidate.action)
  })).sort((a,b) => b.score - a.score);

  candidates = applyPlanBias(candidates, cognitiveProfile.plans);
  candidates = applyRecentActionPenalty(candidates, recentActions.map(row => row.actionType));
  candidates = applySocialContext(candidates, nearbyEntities, relationships);

  return {
    needs,
    traits,
    goals,
    location:location[0]||null,
    recentActions:recentActions.map(row => row.actionType),
    nearbyEntities,
    relationships,
    cognitiveProfile,
    allowedActionTypes:ACTIONS,
    candidates:candidates.slice(0,6)
  };
}

async function makeDecision({simulationId,entityId,simulationTime,triggerType="AUTONOMOUS",triggerEventId=null,context,aiChoice=null}){
  const decisionId=uuid();
  const candidates=Array.isArray(context?.candidates) ? context.candidates : [];
  const topDeterministic = candidates[0]?.action || "RESTING";
  const aiAction = normalizeAction(aiChoice?.selectedActionType);
  const aiCandidate = candidates.find(x => normalizeAction(x.action) === aiAction);
  const chosen = aiCandidate && Number(aiCandidate.score || 0) > 0
    ? aiCandidate.action
    : topDeterministic;

  await pool.query(`
    INSERT INTO decisions
      (id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?, 'CREATED',1)
  `,[decisionId,simulationId,entityId,simulationTime,triggerEventId,triggerType,JSON.stringify({...context,aiChoice:aiChoice||null,chosenAction:chosen})]);
  const optionId=uuid();
  await pool.query(`
    INSERT INTO decision_options(id,decision_id,option_code,description,action_definition,evaluation,expected_outcome)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?, ?,?)
  `,[optionId,decisionId,chosen,`Autonomously selected ${chosen}`,JSON.stringify({actionType:chosen}),JSON.stringify({score:candidates.find(x=>x.action===chosen)?.score||0}),JSON.stringify({actionType:chosen})]);
  await pool.query(`
    UPDATE decisions
    SET selected_option_id=UUID_TO_BIN(?),status='EVALUATED',expected_outcome=?
    WHERE id=UUID_TO_BIN(?)
  `,[optionId,JSON.stringify({actionType:chosen}),decisionId]);
  return {decisionId,actionType:chosen,reason:aiCandidate?.action===chosen && aiChoice?.reason ? aiChoice.reason : "deterministic need/trait/cognitive score",confidence:aiCandidate?.action===chosen ? (aiChoice?.confidence??0.7) : 0.7};
}
module.exports={ACTIONS,scoreAction,buildDecisionContext,makeDecision};
