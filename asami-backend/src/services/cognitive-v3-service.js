const { pool } = require('../db/pool');
const { uuid } = require('../lib/ids');

const lastConsolidationByEntity = new Map();
const lastSelfEvolutionByEntity = new Map();

function normalize(value) { return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_'); }
function clamp01(value, fallback = 0.5) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; }
function safeText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback = null) { if (value === null || value === undefined) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function hoursBetween(a, b) { const x = new Date(a).getTime(), y = new Date(b).getTime(); return Number.isFinite(x) && Number.isFinite(y) ? Math.max(0, (y - x) / 3600000) : 0; }

function selfBeliefForAction(actionType) {
  const action = normalize(actionType);
  const social = new Set(['TALKING','HELPING','TEACHING','APOLOGIZING','GIVING','RECEIVING','ATTENDING_EVENT']);
  const learning = new Set(['LEARNING','READING','STUDYING','WRITING']);
  const creative = new Set(['DRAWING','CREATING','WRITING','COOKING']);
  if (social.has(action)) return { key: 'SOCIAL_CAPABILITY', statement: 'I can build and maintain meaningful connections with people.' };
  if (learning.has(action)) return { key: 'CAPABLE_OF_LEARNING', statement: 'I can learn and improve through experience.' };
  if (creative.has(action)) return { key: 'CREATIVE_CAPABILITY', statement: 'I can create things that reflect my ideas and preferences.' };
  return { key: 'AGENCY', statement: 'My choices can change what happens next.' };
}

function beliefRevisionTarget(polarity, evidenceStrength) {
  const evidence = clamp01(evidenceStrength);
  return polarity >= 0 ? evidence : 1 - evidence;
}

function beliefRevisionRate(evidenceStrength) { return 0.20 + clamp01(evidenceStrength) * 0.18; }

async function recordBeliefEvidence({ simulationId, entityId, simulationTime, beliefKey, statement, polarity = 1, evidenceStrength = 0.5, sourceType = 'EXPERIENCE', sourceRef = null, metadata = null }) {
  const id = uuid();
  await pool.query(`INSERT INTO belief_evidence(id,simulation_id,entity_id,belief_key,polarity,evidence_strength,source_type,source_ref,statement,created_simulation_at,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),?,?,?,1)`, [id,simulationId,entityId,normalize(beliefKey),polarity >= 0 ? 1 : -1,clamp01(evidenceStrength),safeText(sourceType,60),sourceRef,safeText(statement,500),simulationTime,metadata ? JSON.stringify(metadata) : null]);
  return id;
}

async function reviseSelfBelief({ simulationId, entityId, simulationTime, beliefKey, statement, evidencePolarity, evidenceStrength, sourceType = 'EXPERIENCE', sourceRef = null, importance = 0.65 }) {
  const key = normalize(beliefKey).slice(0,80);
  const evidence = clamp01(evidenceStrength);
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,confidence,importance,version FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND belief_key=? LIMIT 1`, [simulationId,entityId,key]);
  const target = beliefRevisionTarget(evidencePolarity,evidence);
  const learningRate = beliefRevisionRate(evidence);
  if (!rows.length) {
    const id = uuid();
    await pool.query(`INSERT INTO self_beliefs(id,simulation_id,entity_id,belief_key,statement,confidence,importance,source_type,source_ref,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,UUID_TO_BIN(?),'ACTIVE',?,?,1)`, [id,simulationId,entityId,key,safeText(statement,500),clamp01(target),clamp01(importance),sourceType,sourceRef,simulationTime,simulationTime]);
    return id;
  }
  const row = rows[0];
  const next = clamp01(Number(row.confidence) + (target - Number(row.confidence)) * learningRate);
  const [updated] = await pool.query(`UPDATE self_beliefs SET statement=?,confidence=?,importance=?,source_type=?,source_ref=UUID_TO_BIN(?),updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [safeText(statement,500),next,Math.max(Number(row.importance),clamp01(importance)),sourceType,sourceRef,simulationTime,row.id,row.version]);
  if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on self belief revision"), { code: "OPTIMISTIC_LOCK" });
  return row.id;
}

async function decaySelfBeliefs(simulationId, entityId, simulationTime) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,confidence,importance,updated_simulation_at AS updatedAt,version FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY importance DESC LIMIT 32`, [simulationId,entityId]);
  for (const row of rows) {
    const elapsedHours = hoursBetween(row.updatedAt, simulationTime);
    if (elapsedHours < 12) continue;
    const decay = Math.pow(0.995, elapsedHours / 12);
    const floor = Math.max(0.12, Number(row.importance) * 0.18);
    const next = Math.max(floor, Number(row.confidence) * decay);
    if (next >= Number(row.confidence) - 0.00001) continue;
    const [updated] = await pool.query(`UPDATE self_beliefs SET confidence=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next,simulationTime,row.id,row.version]);
    if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on self belief decay"), { code: "OPTIMISTIC_LOCK" });
  }
}

async function updateIdentityValues(simulationId, entityId, simulationTime, actionType, outcome) {
  const action = normalize(actionType);
  const map = {
    LEARNING: ['LEARNING','CURIOSITY'], READING: ['LEARNING','CURIOSITY'], STUDYING: ['LEARNING','ACHIEVEMENT'],
    TALKING: ['SOCIAL_CONNECTION'], HELPING: ['SOCIAL_CONNECTION','KINDNESS'], APOLOGIZING: ['KINDNESS','SOCIAL_CONNECTION'],
    GIVING: ['KINDNESS','SOCIAL_CONNECTION'], RECEIVING: ['SOCIAL_CONNECTION'], TEACHING: ['KINDNESS','ACHIEVEMENT'],
    DRAWING: ['CREATIVITY'], CREATING: ['CREATIVITY','INDEPENDENCE'], WRITING: ['CREATIVITY','ACHIEVEMENT'],
    WALKING: ['INDEPENDENCE'], EXPLORING: ['CURIOSITY','INDEPENDENCE'], WORKING: ['ACHIEVEMENT'], CLEANING: ['INDEPENDENCE'],
  };
  const codes = map[action] || [];
  if (!codes.length) return;
  const outcomeValue = normalize(outcome);
  const evidence = outcomeValue === 'SUCCESS' ? 1 : outcomeValue === 'PARTIAL' ? 0.45 : -1;
  for (const code of codes) {
    const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,importance,confidence,version FROM identity_values WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND code=? LIMIT 1`, [simulationId,entityId,normalize(code)]);
    if (!rows.length) continue;
    const row = rows[0];
    const delta = evidence * 0.007;
    const nextImportance = clamp01(Number(row.importance) + delta, Number(row.importance));
    const nextConfidence = clamp01(Number(row.confidence) + delta * 0.5, Number(row.confidence));
    if (Math.abs(nextImportance - Number(row.importance)) < 0.000001) continue;
    const [updated] = await pool.query(`UPDATE identity_values SET importance=?,confidence=?,salience=?,origin='EXPERIENCE',updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [nextImportance,nextConfidence,clamp01(0.4 + Math.abs(delta) * 8),simulationTime,row.id,row.version]);
    if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on identity value evolution"), { code: "OPTIMISTIC_LOCK" });
  }
}

async function evolveSelfModel({ simulationId, entityId, simulationTime, actionType, outcome, decisionId = null }) {
  const key = `${simulationId}:${entityId}`;
  const last = lastSelfEvolutionByEntity.get(key);
  if (last && hoursBetween(last, simulationTime) < 6) return { skipped: true };
  lastSelfEvolutionByEntity.set(key, simulationTime);
  const [actions] = await pool.query(`SELECT action_type AS actionType,status,result,started_simulation_at AS simulationAt,completed_simulation_at AS completedAt FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('COMPLETED','FAILED') ORDER BY COALESCE(completed_simulation_at,started_simulation_at) DESC LIMIT 48`, [simulationId,entityId]);
  const recent = actions.map(row => ({ ...row, result: parseJson(row.result,{}) }));
  const successes = recent.filter(row => normalize(row.result?.outcome || row.status) === 'SUCCESS').length;
  const known = recent.filter(row => ['SUCCESS','PARTIAL','FAILURE','COMPLETED','FAILED'].includes(normalize(row.result?.outcome || row.status))).length;
  const successRate = known ? successes / known : 0.5;
  const [selfRows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,self_concept,capabilities,limitations,version FROM self_models WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId]);
  if (!selfRows.length) return { skipped: true };
  const self = selfRows[0];
  const capabilities = parseJson(self.capabilities,{ adaptive: true, domains: {} });
  const rawLimitations = parseJson(self.limitations,[]);
  const limitations = Array.isArray(rawLimitations) ? rawLimitations : [];
  if (!capabilities.domains || Array.isArray(capabilities.domains)) capabilities.domains = {};
  const action = normalize(actionType);
  if (action) {
    const same = recent.filter(row => normalize(row.actionType) === action).slice(0, 12);
    const sameSuccess = same.filter(row => normalize(row.result?.outcome || row.status) === 'SUCCESS').length;
    const actionRate = same.length ? sameSuccess / same.length : clamp01(normalize(outcome)==='SUCCESS' ? 1 : 0.35);
    capabilities.domains[action] = { experience: same.length, successRate: Number(actionRate.toFixed(3)), confidence: clamp01(0.25 + Math.min(1, same.length / 10) * 0.55 + actionRate * 0.2), lastPracticedAt: simulationTime };
    if (same.length >= 3 && actionRate < 0.35) {
      const label = `${action.toLowerCase().replaceAll('_',' ')} is still difficult for me`;
      if (!limitations.includes(label)) limitations.unshift(label);
    }
    while (limitations.length > 8) limitations.pop();
  }
  const topCapability = Object.entries(capabilities.domains).sort((a,b) => Number(b[1]?.confidence || 0) - Number(a[1]?.confidence || 0))[0];
  const topLimit = limitations[0];
  const currentSelfView = topCapability ? topLimit ? `I am becoming more capable at ${topCapability[0].toLowerCase().replaceAll('_',' ')}; ${topLimit}.` : `I am becoming more capable at ${topCapability[0].toLowerCase().replaceAll('_',' ')} through experience.` : 'I am still learning what I can reliably do.';
  const selfConcept = successRate >= 0.72 ? 'I learn through experience and tend to become more capable when I keep practicing.' : successRate <= 0.35 ? 'I learn through experience, including noticing what I cannot reliably do yet.' : self.self_concept;
  const [updated] = await pool.query(`UPDATE self_models SET self_concept=?,current_self_view=?,capabilities=?,limitations=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [selfConcept,currentSelfView,JSON.stringify(capabilities),JSON.stringify(limitations),simulationTime,self.id,self.version]);
  if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on self model evolution"), { code: "OPTIMISTIC_LOCK" });
  await pool.query(`INSERT INTO self_model_snapshots(id,simulation_id,entity_id,simulation_time,trigger_type,self_view,capabilities,limitations,metrics,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,1)`, [uuid(),simulationId,entityId,simulationTime,decisionId?'DECISION_OUTCOME':'EXPERIENCE',currentSelfView,JSON.stringify(capabilities),JSON.stringify(limitations),JSON.stringify({recentActions:known,successRate:Number(successRate.toFixed(3)),actionType:action,outcome:normalize(outcome)})]);
  return { updated: Boolean(updated.affectedRows), currentSelfView, successRate, capabilities, limitations };
}

async function consolidateMemories(simulationId, entityId, simulationTime) {
  const key = `${simulationId}:${entityId}`;
  const last = lastConsolidationByEntity.get(key);
  if (last && hoursBetween(last, simulationTime) < 12) return { skipped: true };
  lastConsolidationByEntity.set(key, simulationTime);
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,memory_type AS memoryType,content,importance,strength,confidence,emotional_intensity AS emotionalIntensity,created_simulation_at AS simulationAt,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND memory_type='EPISODIC' AND created_simulation_at >= DATE_SUB(?,INTERVAL 72 HOUR) ORDER BY created_simulation_at DESC LIMIT 160`, [simulationId,entityId,simulationTime]);
  const groups = new Map();
  for (const row of rows) {
    const metadata = parseJson(row.metadata,{}) || {};
    const action = normalize(metadata.actionType || metadata.decision?.actionType || metadata.kind || 'GENERAL').slice(0,70);
    const outcome = normalize(metadata.outcome || 'UNKNOWN');
    const groupKey = `${action}:${outcome}`;
    if (!groups.has(groupKey)) groups.set(groupKey,[]);
    groups.get(groupKey).push(row);
  }
  const consolidated = [];
  for (const [groupKey, items] of groups) {
    if (items.length < 3) continue;
    const [action, outcome] = groupKey.split(':');
    const sourceFrom = items[items.length - 1].simulationAt;
    const sourceTo = items[0].simulationAt;
    const confidence = clamp01(Math.min(0.95,0.42 + items.length * 0.06));
    const summary = outcome === 'FAILURE' ? `Repeated experience suggests that ${action.toLowerCase().replaceAll('_',' ')} has often failed in this context.` : outcome === 'PARTIAL' ? `Repeated experience suggests that ${action.toLowerCase().replaceAll('_',' ')} often produces only a partial result in this context.` : `Repeated experience suggests that ${action.toLowerCase().replaceAll('_',' ')} is a reliable way to obtain the expected result in this context.`;
    const consolidationKey = `ACTION:${action}:OUTCOME:${outcome}`;
    const [existing] = await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM memory_consolidations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND consolidation_key=? LIMIT 1`, [simulationId,entityId,consolidationKey]);
    const metadata = JSON.stringify({ kind:'cognitive_consolidation', schemaVersion:3, consolidationKey, sourceCount:items.length, sourceFrom, sourceTo, actionType:action, outcome });
    if (!existing.length) {
      const memoryId = uuid();
      await pool.query(`INSERT INTO memories(id,simulation_id,entity_id,memory_type,content,importance,strength,confidence,emotional_intensity,source_event_id,source_activity_id,location_id,created_simulation_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'SEMANTIC',?,?,?,?,?,?,?,?,?,'ACTIVE',?,1)`, [memoryId,simulationId,entityId,summary,0.72,0.82,confidence,0.28,null,null,null,sourceTo,metadata]);
      await pool.query(`INSERT INTO memory_consolidations(id,simulation_id,entity_id,consolidation_key,memory_type,source_count,source_from,source_to,summary,confidence,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'SEMANTIC',?,?,?,?,?,?,1)`, [uuid(),simulationId,entityId,consolidationKey,items.length,sourceFrom,sourceTo,summary,confidence,simulationTime]);
      consolidated.push({ consolidationKey, sourceCount:items.length, summary, confidence });
    } else {
      await pool.query(`UPDATE memory_consolidations SET source_count=?,source_from=?,source_to=?,summary=?,confidence=?,created_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?)`, [items.length,sourceFrom,sourceTo,summary,confidence,simulationTime,existing[0].id]);
    }
  }
  return { consolidated };
}

async function getRelationshipCandidates(simulationId, entityId) {
  const [rows] = await pool.query(`SELECT DISTINCT BIN_TO_UUID(CASE WHEN r.source_entity_id=UUID_TO_BIN(?) THEN r.target_entity_id ELSE r.source_entity_id END) AS otherEntityId,e.display_name AS displayName,((r.trust_score+r.affection_score+r.respect_score+r.familiarity_score+r.closeness_score)/5) AS affinity,r.trust_score AS trust,r.affection_score AS affection,r.familiarity_score AS familiarity,r.closeness_score AS closeness FROM relationships r JOIN entities e ON e.id=CASE WHEN r.source_entity_id=UUID_TO_BIN(?) THEN r.target_entity_id ELSE r.source_entity_id END WHERE r.simulation_id=UUID_TO_BIN(?) AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?)) AND r.status='ACTIVE' AND e.status='ACTIVE' ORDER BY affinity DESC LIMIT 8`, [entityId,entityId,simulationId,entityId,entityId]);
  return rows.filter(row => row.otherEntityId !== entityId);
}

async function evolveSocialGroup({ simulationId, entityId, simulationTime }) {
  const [entityRows] = await pool.query(`SELECT display_name AS displayName FROM entities WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1`, [entityId,simulationId]);
  if (!entityRows.length) return { status:'NO_ENTITY' };
  const candidates = await getRelationshipCandidates(simulationId,entityId);
  const strong = candidates.filter(row => Number(row.affinity) >= 0.48 && Number(row.familiarity) >= 0.22).slice(0,4);
  const groupName = `${safeText(entityRows[0].displayName,90) || 'Person'}'s close circle`;
  const [groupRows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,status,version FROM social_groups WHERE simulation_id=UUID_TO_BIN(?) AND name=? LIMIT 1`, [simulationId,groupName]);
  if (strong.length >= 2) {
    const groupId = groupRows.length ? groupRows[0].id : uuid();
    if (!groupRows.length) await pool.query(`INSERT INTO social_groups(id,simulation_id,name,group_type,description,reputation_importance,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,'CLOSE_CIRCLE',?,?, 'ACTIVE',?,?,1)`, [groupId,simulationId,groupName,`A spontaneously formed close social circle around ${entityRows[0].displayName}.`,0.72,simulationTime,simulationTime]);
    else await pool.query(`UPDATE social_groups SET status='ACTIVE',updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [simulationTime,groupId,groupRows[0].version]);
    const memberIds = [...new Set([entityId,...strong.map(row => row.otherEntityId)])];
    for (const memberId of memberIds) await pool.query(`INSERT INTO social_group_members(group_id,simulation_id,entity_id,role,status,joined_simulation_at,left_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),CASE WHEN UUID_TO_BIN(?)=UUID_TO_BIN(?) THEN 'FOCAL' ELSE 'MEMBER' END,'ACTIVE',?,NULL) ON DUPLICATE KEY UPDATE status='ACTIVE',left_simulation_at=NULL`, [groupId,simulationId,memberId,memberId,entityId,simulationTime]);
    return { status:'FORMED',groupId,name:groupName,members:memberIds,affinity:Number((strong.reduce((sum,row)=>sum+Number(row.affinity),0)/strong.length).toFixed(3)) };
  }
  if (groupRows.length && strong.length < 2) {
    const groupId = groupRows[0].id;
    await pool.query(`UPDATE social_group_members SET status='LEFT',left_simulation_at=? WHERE group_id=UUID_TO_BIN(?) AND status='ACTIVE'`, [simulationTime,groupId]);
    await pool.query(`UPDATE social_groups SET status='INACTIVE',updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [simulationTime,groupId,groupRows[0].version]);
    return { status:'DISSOLVED',groupId,name:groupName };
  }
  return { status:'STABLE' };
}

async function branchCounterfactuals({ simulationId, entityId, simulationTime, decisionId, actionType }) {
  if (!decisionId) return [];
  const [needRows] = await pool.query(`SELECT nd.code,enc.value FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1`, [entityId]);
  const baseline = { needs:Object.fromEntries(needRows.map(row => [normalize(row.code),Number(row.value)])), at:simulationTime };
  const [rows] = await pool.query(`SELECT alternative_action AS alternativeAction,predicted_outcome AS predictedOutcome,predicted_utility AS predictedUtility,regret_score AS regretScore FROM counterfactuals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) ORDER BY predicted_utility DESC LIMIT 6`, [simulationId,entityId,decisionId]);
  const [[expectation]] = await pool.query(`SELECT prediction AS predictedOutcome,expected_utility AS predictedUtility FROM cognitive_expectations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId,decisionId]);
  const selected = { alternativeAction:actionType, predictedOutcome:expectation?.predictedOutcome || {}, predictedUtility:Number(expectation?.predictedUtility || 0.5) };
  const worlds = [];
  for (const candidate of [selected,...rows]) {
    const worldKey = normalize(candidate.alternativeAction || 'UNKNOWN');
    const [existing] = await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM counterfactual_worlds WHERE simulation_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND world_key=? LIMIT 1`, [simulationId,decisionId,worldKey]);
    const predictedState = parseJson(candidate.predictedOutcome,{}) || {};
    if (existing.length) {
      await pool.query(`UPDATE counterfactual_worlds SET baseline_state=?,predicted_state=?,predicted_utility=?,selected=?,version=version+1 WHERE id=UUID_TO_BIN(?)`, [JSON.stringify(baseline),JSON.stringify(predictedState),clamp01(candidate.predictedUtility),worldKey===normalize(actionType)?1:0,existing[0].id]);
      worlds.push(existing[0].id);
    } else {
      const id = uuid();
      await pool.query(`INSERT INTO counterfactual_worlds(id,simulation_id,entity_id,decision_id,world_key,selected,baseline_state,predicted_state,predicted_utility,status,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?, ?,?,'OPEN',?,1)`, [id,simulationId,entityId,decisionId,worldKey,worldKey===normalize(actionType)?1:0,JSON.stringify(baseline),JSON.stringify(predictedState),clamp01(candidate.predictedUtility),simulationTime]);
      worlds.push(id);
    }
  }
  return worlds;
}

async function resolveCounterfactualWorlds({ simulationId, entityId, decisionId, actionType, outcome, simulationTime, regretScore = 0 }) {
  if (!decisionId) return;
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,world_key,selected,predicted_utility AS predictedUtility,version FROM counterfactual_worlds WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND status='OPEN'`, [simulationId,entityId,decisionId]);
  for (const row of rows) {
    const selected = Number(row.selected) === 1 || row.world_key === normalize(actionType);
    const regret = selected ? clamp01(regretScore) : clamp01(Math.max(0,Number(row.predictedUtility) - Number(regretScore)) * 0.15);
    await pool.query(`UPDATE counterfactual_worlds SET actual_outcome=?,regret_score=?,status='RESOLVED',resolved_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [normalize(outcome),regret,simulationTime,row.id,row.version]);
  }
}

async function processExperience({ simulationId, entityId, simulationTime, actionType, outcome, actionId = null, decisionId = null, targetEntityId = null }) {
  try {
    await decaySelfBeliefs(simulationId,entityId,simulationTime);
    const belief = selfBeliefForAction(actionType);
    const normalizedOutcome = normalize(outcome);
    const polarity = normalizedOutcome === 'SUCCESS' || normalizedOutcome === 'PARTIAL' ? 1 : -1;
    const strength = normalizedOutcome === 'SUCCESS' ? 0.88 : normalizedOutcome === 'PARTIAL' ? 0.58 : 0.82;
    const evidenceId = await recordBeliefEvidence({simulationId,entityId,simulationTime,beliefKey:belief.key,statement:belief.statement,polarity,evidenceStrength:strength,sourceType:'ACTION_OUTCOME',sourceRef:actionId,metadata:{actionType:normalize(actionType),outcome:normalizedOutcome,targetEntityId}});
    await reviseSelfBelief({simulationId,entityId,simulationTime,beliefKey:belief.key,statement:belief.statement,evidencePolarity:polarity,evidenceStrength:strength,sourceType:'ACTION_OUTCOME',sourceRef:actionId,importance:0.72});
    await updateIdentityValues(simulationId,entityId,simulationTime,actionType,outcome);
    const evolution = await evolveSelfModel({simulationId,entityId,simulationTime,actionType,outcome,decisionId});
    const consolidation = await consolidateMemories(simulationId,entityId,simulationTime);
    const group = ['TALKING','HELPING','TEACHING','APOLOGIZING','GIVING','RECEIVING','ATTENDING_EVENT'].includes(normalize(actionType)) ? await evolveSocialGroup({simulationId,entityId,simulationTime}) : null;
    let regretScore = 0;
    if (decisionId) {
      const [[expectation]] = await pool.query(`SELECT regret_score AS regretScore FROM cognitive_expectations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId,decisionId]);
      regretScore = Number(expectation?.regretScore || 0);
    }
    await resolveCounterfactualWorlds({simulationId,entityId,decisionId,actionType,outcome,simulationTime,regretScore});
    return { evidenceId, evolution, consolidation, group };
  } catch (err) {
    return { error: err.message || 'emergent cognition failed', code: err.code || null };
  }
}

async function getEmergentMind(simulationId, entityId) {
  const [[evolution],[evidence],[consolidations],[worlds],[groups]] = await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) AS id,simulation_time AS simulationTime,trigger_type AS triggerType,self_view AS selfView,capabilities,limitations,metrics FROM self_model_snapshots WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY simulation_time DESC LIMIT 8`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,belief_key AS beliefKey,polarity,evidence_strength AS evidenceStrength,source_type AS sourceType,statement,created_simulation_at AS createdAt,metadata FROM belief_evidence WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 14`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,consolidation_key AS consolidationKey,source_count AS sourceCount,source_from AS sourceFrom,source_to AS sourceTo,summary,confidence,created_simulation_at AS createdAt FROM memory_consolidations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 8`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(decision_id) AS decisionId,world_key AS worldKey,selected,predicted_state AS predictedState,predicted_utility AS predictedUtility,actual_outcome AS actualOutcome,regret_score AS regretScore,status,created_simulation_at AS createdAt,resolved_simulation_at AS resolvedAt FROM counterfactual_worlds WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 12`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(sg.id) AS id,sg.name,sg.group_type AS groupType,sg.status,sgm.role,sgm.joined_simulation_at AS joinedAt FROM social_groups sg JOIN social_group_members sgm ON sgm.group_id=sg.id AND sgm.entity_id=UUID_TO_BIN(?) AND sgm.status='ACTIVE' WHERE sg.simulation_id=UUID_TO_BIN(?) ORDER BY sg.updated_simulation_at DESC LIMIT 8`, [entityId,simulationId]),
  ]);
  const parseRows = rows => rows.map(row => { for (const key of ['capabilities','limitations','metrics','metadata','predictedState']) if (row[key] !== undefined) row[key] = parseJson(row[key], row[key]); return row; });
  return { evolution:parseRows(evolution), evidence:parseRows(evidence), consolidations, worlds:parseRows(worlds), groups };
}

module.exports = { recordBeliefEvidence, reviseSelfBelief, decaySelfBeliefs, evolveSelfModel, consolidateMemories, evolveSocialGroup, branchCounterfactuals, resolveCounterfactualWorlds, processExperience, getEmergentMind, selfBeliefForAction, beliefRevisionTarget, beliefRevisionRate };