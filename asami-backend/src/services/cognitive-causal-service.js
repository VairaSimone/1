const { pool } = require('../db/pool');
const { uuid } = require('../lib/ids');

const MAX_DEPTH = 4;
const MAX_STEPS = 18;

function normalize(value) { return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 180); }
function clamp01(value, fallback = 0.5) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; }
function signed(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0; }

function beliefForAction(actionType) {
  const action = normalize(actionType);
  if (['TALKING','HELPING','TEACHING','APOLOGIZING','GIVING','RECEIVING','ATTENDING_EVENT'].includes(action)) return { key: 'SOCIAL_CAPABILITY', statement: 'I can build and maintain meaningful connections with people.' };
  if (['LEARNING','READING','STUDYING','WRITING'].includes(action)) return { key: 'CAPABLE_OF_LEARNING', statement: 'I can learn and improve through experience.' };
  if (['DRAWING','CREATING','COOKING'].includes(action)) return { key: 'CREATIVE_CAPABILITY', statement: 'I can create things that reflect my ideas and preferences.' };
  return { key: 'AGENCY', statement: 'My choices can change what happens next.' };
}

const DESIRES = {
  LEARNING: 'UNDERSTAND_WORLD', READING: 'UNDERSTAND_WORLD', STUDYING: 'BECOME_CAPABLE', WRITING: 'BECOME_CAPABLE',
  TALKING: 'MEANINGFUL_RELATIONSHIPS', HELPING: 'MEANINGFUL_RELATIONSHIPS', TEACHING: 'BECOME_CAPABLE',
  APOLOGIZING: 'MEANINGFUL_RELATIONSHIPS', GIVING: 'MEANINGFUL_RELATIONSHIPS', RECEIVING: 'MEANINGFUL_RELATIONSHIPS', ATTENDING_EVENT: 'MEANINGFUL_RELATIONSHIPS',
  DRAWING: 'BECOME_CAPABLE', CREATING: 'BECOME_CAPABLE', COOKING: 'BECOME_CAPABLE',
  EXPLORING: 'UNDERSTAND_WORLD', WALKING: 'MAINTAIN_AGENCY', USING_DEVICE: 'MAINTAIN_AGENCY',
};

const VALUES = {
  LEARNING: ['LEARNING','CURIOSITY'], READING: ['LEARNING','CURIOSITY'], STUDYING: ['LEARNING','ACHIEVEMENT'], WRITING: ['CREATIVITY','ACHIEVEMENT'],
  TALKING: ['SOCIAL_CONNECTION'], HELPING: ['KINDNESS','SOCIAL_CONNECTION'], TEACHING: ['KINDNESS','ACHIEVEMENT'],
  APOLOGIZING: ['KINDNESS','SOCIAL_CONNECTION'], GIVING: ['KINDNESS','SOCIAL_CONNECTION'], RECEIVING: ['SOCIAL_CONNECTION'], ATTENDING_EVENT: ['SOCIAL_CONNECTION','CURIOSITY'],
  DRAWING: ['CREATIVITY'], CREATING: ['CREATIVITY','INDEPENDENCE'], COOKING: ['CREATIVITY','ACHIEVEMENT'], EXPLORING: ['CURIOSITY','INDEPENDENCE'],
  WALKING: ['INDEPENDENCE'], USING_DEVICE: ['INDEPENDENCE','CURIOSITY'],
};

async function ensureLink({ simulationId, entityId, simulationTime, sourceType, sourceKey, targetType, targetKey, weight, polarity = 1, confidence = 0.5 }) {
  const sType = normalize(sourceType), sKey = normalize(sourceKey), tType = normalize(targetType), tKey = normalize(targetKey);
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,weight,polarity,confidence,evidence_count,version FROM causal_links WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND source_type=? AND source_key=? AND target_type=? AND target_key=? LIMIT 1`, [simulationId,entityId,sType,sKey,tType,tKey]);
  if (!rows.length) {
    const id = uuid();
    const initialWeight = signed(weight);
    const initialPolarity = initialWeight === 0 ? (polarity >= 0 ? 1 : -1) : initialWeight < 0 ? -1 : 1;
    await pool.query(`INSERT INTO causal_links(id,simulation_id,entity_id,source_type,source_key,target_type,target_key,weight,polarity,confidence,evidence_count,last_activated_simulation_at,status,version,created_simulation_at,updated_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,1,?,'ACTIVE',1,?,?)`, [id,simulationId,entityId,sType,sKey,tType,tKey,initialWeight,initialPolarity,clamp01(confidence),simulationTime,simulationTime,simulationTime]);
    return id;
  }
  const row = rows[0];
  const previousWeight = signed(row.weight);
  const observedWeight = signed(weight);
  const nextWeight = signed(previousWeight * 0.82 + observedWeight * 0.18);
  const nextPolarity = nextWeight < 0 ? -1 : nextWeight > 0 ? 1 : (Number(row.polarity) < 0 ? -1 : 1);
  const nextConfidence = clamp01(Number(row.confidence) * 0.88 + clamp01(confidence) * 0.12);
  await pool.query(`UPDATE causal_links SET weight=?,polarity=?,confidence=?,evidence_count=evidence_count+1,last_activated_simulation_at=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [nextWeight,nextPolarity,nextConfidence,simulationTime,simulationTime,row.id,row.version]);
  return row.id;
}

async function activate({ simulationId, entityId, simulationTime, parentActivationId = null, sourceType, sourceKey, targetType, targetKey, activation, depth = 0, causeType = 'EXPERIENCE', causeRef = null, metadata = null, weight, polarity = 1, confidence = 0.5 }) {
  const magnitude = Math.max(-1, Math.min(1, Number(activation) || 0));
  const safeDepth = Math.max(0, Math.min(MAX_DEPTH, Math.round(Number(depth) || 0)));
  if (Math.abs(magnitude) < 0.03 || safeDepth > MAX_DEPTH) return null;
  const linkId = await ensureLink({ simulationId,entityId,simulationTime,sourceType,sourceKey,targetType,targetKey,weight:weight ?? magnitude,polarity,confidence });
  const id = uuid();
  await pool.query(`INSERT INTO causal_activations(id,simulation_id,entity_id,link_id,parent_activation_id,source_type,source_key,target_type,target_key,activation,depth,cause_type,cause_ref,simulation_time,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,UUID_TO_BIN(?),?,?,1)`, [id,simulationId,entityId,linkId,parentActivationId,normalize(sourceType),normalize(sourceKey),normalize(targetType),normalize(targetKey),magnitude,safeDepth,normalize(causeType),causeRef,simulationTime,metadata ? JSON.stringify(metadata) : null]);
  return { id, linkId, activation: magnitude, targetType: normalize(targetType), targetKey: normalize(targetKey), depth: safeDepth };
}

async function updateMemory({ simulationId, entityId, actionType, outcome, simulationTime, activation }) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,importance,strength,version FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType'))=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome'))=? ORDER BY created_simulation_at DESC LIMIT 1`, [simulationId,entityId,normalize(actionType),normalize(outcome)]);
  if (!rows.length) return null;
  const row = rows[0];
  const boost = Math.min(0.09, Math.abs(Number(activation)) * 0.08 + (normalize(outcome) === 'FAILURE' ? 0.025 : 0));
  const nextImportance = clamp01(Number(row.importance) + boost);
  const nextStrength = clamp01(Number(row.strength) + boost * 0.75);
  await pool.query(`UPDATE memories SET importance=?,strength=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [nextImportance,nextStrength,row.id,row.version]);
  return row.id;
}

async function updateBelief({ simulationId, entityId, simulationTime, belief, activation, sourceRef }) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,confidence,importance,version FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND belief_key=? LIMIT 1`, [simulationId,entityId,normalize(belief.key)]);
  const evidence = clamp01(Math.abs(activation));
  const target = activation >= 0 ? evidence : 1 - evidence;
  const rate = 0.12 + evidence * 0.22;
  if (!rows.length) {
    await pool.query(`INSERT INTO self_beliefs(id,simulation_id,entity_id,belief_key,statement,confidence,importance,source_type,source_ref,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,'CAUSAL_EXPERIENCE',UUID_TO_BIN(?),'ACTIVE',?,?,1)`, [uuid(),simulationId,entityId,normalize(belief.key),belief.statement,target,0.65,sourceRef,simulationTime,simulationTime]);
    return;
  }
  const row = rows[0], next = clamp01(Number(row.confidence) + (target - Number(row.confidence)) * rate);
  await pool.query(`UPDATE self_beliefs SET confidence=?,source_type='CAUSAL_EXPERIENCE',source_ref=UUID_TO_BIN(?),updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next,sourceRef,simulationTime,row.id,row.version]);
}

async function updateDesire({ simulationId, entityId, simulationTime, desireKey, actionOutcome, activation }) {
  if (!desireKey) return null;
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,priority,persistence,progress,version FROM long_term_desires WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND desire_key=? AND status='ACTIVE' LIMIT 1`, [simulationId,entityId,normalize(desireKey)]);
  if (!rows.length) return null;
  const row = rows[0], outcome = normalize(actionOutcome);
  const strength = Math.min(0.05, Math.abs(activation) * 0.04);
  const success = outcome === 'SUCCESS';
  const partial = outcome === 'PARTIAL';
  const progressDelta = success ? strength : partial ? strength * 0.35 : 0;
  const priorityDelta = success ? -strength * 0.30 : strength * 0.45;
  const persistenceDelta = success ? strength * 0.10 : strength * 0.25;
  const nextProgress = clamp01(Number(row.progress) + progressDelta);
  const nextPriority = clamp01(Number(row.priority) + priorityDelta);
  const nextPersistence = clamp01(Number(row.persistence) + persistenceDelta);
  await pool.query(`UPDATE long_term_desires SET progress=?,priority=?,persistence=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [nextProgress,nextPriority,nextPersistence,simulationTime,row.id,row.version]);
  return { id: row.id, progress: nextProgress, priority: nextPriority, persistence: nextPersistence };
}

async function updateValue({ simulationId, entityId, simulationTime, valueCode, actionOutcome, activation }) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,importance,confidence,version FROM identity_values WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND code=? LIMIT 1`, [simulationId,entityId,normalize(valueCode)]);
  if (!rows.length) return null;
  const row = rows[0], outcome = normalize(actionOutcome), magnitude = Math.min(0.025,Math.abs(activation) * 0.018);
  const delta = outcome === 'SUCCESS' ? magnitude : outcome === 'PARTIAL' ? magnitude * 0.30 : 0;
  const nextImportance = clamp01(Number(row.importance) + delta);
  const nextConfidence = clamp01(Number(row.confidence) + delta * 0.65);
  const nextSalience = clamp01(0.45 + Math.abs(delta) * 8);
  await pool.query(`UPDATE identity_values SET importance=?,confidence=?,salience=?,origin='CAUSAL_EXPERIENCE',updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [nextImportance,nextConfidence,nextSalience,simulationTime,row.id,row.version]);
  return { code: valueCode, importance: nextImportance, confidence: nextConfidence };
}

async function updateRelationshipInfluence({ simulationId, entityId, targetEntityId, simulationTime, activation }) {
  if (!targetEntityId) return null;
  const [rows] = await pool.query(`SELECT r.trust_score AS trust,r.affection_score AS affection,r.closeness_score AS closeness,r.conflict_score AS conflict,r.respect_score AS respect FROM relationships r WHERE r.simulation_id=UUID_TO_BIN(?) AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?)) OR (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?))) AND r.status='ACTIVE' ORDER BY r.closeness_score DESC LIMIT 1`, [simulationId,entityId,targetEntityId,targetEntityId,entityId]);
  if (!rows.length) return null;
  const relation = rows[0], socialSignal = clamp01((Number(relation.trust)+Number(relation.affection)+Number(relation.closeness)+Number(relation.respect))/4), threatSignal = clamp01((Number(relation.conflict)+Number(relation.closeness)*0.15));
  const socialActivation = activation * (0.45 + socialSignal * 0.55);
  const safetyActivation = activation < 0 ? Math.abs(activation) * threatSignal : 0;
  return { socialSignal, threatSignal, socialActivation, safetyActivation };
}

async function processExperience({ simulationId, entityId, simulationTime, actionType, outcome, actionId = null, decisionId = null, targetEntityId = null }) {
  const action = normalize(actionType), result = normalize(outcome), base = result === 'SUCCESS' ? 0.78 : result === 'PARTIAL' ? 0.52 : -0.82;
  const desireKey = DESIRES[action] || null, belief = beliefForAction(action), values = VALUES[action] || [];
  const chain = [];
  const root = await activate({ simulationId,entityId,simulationTime,sourceType:'EXPERIENCE',sourceKey:`${action}:${result}`,targetType:'MEMORY',targetKey:`${action}:${result}`,activation:base,depth:0,causeType:'ACTION_OUTCOME',causeRef:actionId,metadata:{ decisionId,targetEntityId,outcome:result } });
  if (root) chain.push(root);
  if (root) await updateMemory({ simulationId,entityId,actionType:action,outcome:result,simulationTime,activation:root.activation });

  const beliefNode = await activate({ simulationId,entityId,simulationTime,parentActivationId:root?.id || null,sourceType:'MEMORY',sourceKey:`${action}:${result}`,targetType:'SELF_BELIEF',targetKey:belief.key,activation:base*0.82,depth:1,causeType:'ACTION_OUTCOME',causeRef:actionId,weight:0.82,confidence:0.64 });
  if (beliefNode) { chain.push(beliefNode); await updateBelief({ simulationId,entityId,simulationTime,belief,activation:beliefNode.activation,sourceRef:actionId }); }

  if (desireKey) {
    const desireNode = await activate({ simulationId,entityId,simulationTime,parentActivationId:beliefNode?.id || root?.id || null,sourceType:'SELF_BELIEF',sourceKey:belief.key,targetType:'DESIRE',targetKey:desireKey,activation:base*0.68,depth:2,causeType:'ACTION_OUTCOME',causeRef:actionId,weight:0.68,confidence:0.58 });
    if (desireNode) { chain.push(desireNode); await updateDesire({ simulationId,entityId,simulationTime,desireKey,actionOutcome:result,activation:desireNode.activation }); }
  }

  for (const valueCode of values) {
    const valueNode = await activate({ simulationId,entityId,simulationTime,parentActivationId:root?.id || null,sourceType:'EXPERIENCE',sourceKey:`${action}:${result}`,targetType:'VALUE',targetKey:valueCode,activation:base*0.45,depth:1,causeType:'ACTION_OUTCOME',causeRef:actionId,weight:0.45,confidence:0.55 });
    if (valueNode) { chain.push(valueNode); await updateValue({ simulationId,entityId,simulationTime,valueCode,actionOutcome:result,activation:valueNode.activation }); }
  }

  if (targetEntityId && ['TALKING','HELPING','TEACHING','APOLOGIZING','GIVING','RECEIVING','ATTENDING_EVENT'].includes(action)) {
    const relation = await updateRelationshipInfluence({ simulationId,entityId,targetEntityId,simulationTime,activation:base });
    if (relation) {
      const socialNode = await activate({ simulationId,entityId,simulationTime,parentActivationId:root?.id || null,sourceType:'RELATIONSHIP',sourceKey:`${targetEntityId}:SOCIAL_SIGNAL`,targetType:'DESIRE',targetKey:'MEANINGFUL_RELATIONSHIPS',activation:relation.socialActivation*0.55,depth:1,causeType:'RELATIONSHIP_OUTCOME',causeRef:targetEntityId,weight:0.55,confidence:0.62,metadata:{ targetEntityId,socialSignal:relation.socialSignal,threatSignal:relation.threatSignal } });
      if (socialNode) { chain.push(socialNode); await updateDesire({ simulationId,entityId,simulationTime,desireKey:'MEANINGFUL_RELATIONSHIPS',actionOutcome:relation.socialSignal >= 0.45 ? 'SUCCESS' : 'FAILURE',activation:socialNode.activation }); }
      const socialValue = await activate({ simulationId,entityId,simulationTime,parentActivationId:socialNode?.id || root?.id || null,sourceType:'RELATIONSHIP',sourceKey:`${targetEntityId}:SOCIAL_SIGNAL`,targetType:'VALUE',targetKey:'SOCIAL_CONNECTION',activation:relation.socialActivation*0.42,depth:2,causeType:'RELATIONSHIP_OUTCOME',causeRef:targetEntityId,weight:0.42,confidence:0.58 });
      if (socialValue) { chain.push(socialValue); await updateValue({ simulationId,entityId,simulationTime,valueCode:'SOCIAL_CONNECTION',actionOutcome:relation.socialSignal >= 0.45 ? 'SUCCESS' : 'FAILURE',activation:socialValue.activation }); }
      if (relation.threatSignal > 0.6) {
        const safetyNode = await activate({ simulationId,entityId,simulationTime,parentActivationId:root?.id || null,sourceType:'RELATIONSHIP',sourceKey:`${targetEntityId}:CONFLICT`,targetType:'VALUE',targetKey:'SAFETY',activation:relation.safetyActivation*0.38,depth:1,causeType:'RELATIONSHIP_OUTCOME',causeRef:targetEntityId,weight:0.38,confidence:0.54,metadata:{ targetEntityId,threatSignal:relation.threatSignal } });
        if (safetyNode) { chain.push(safetyNode); await updateValue({ simulationId,entityId,simulationTime,valueCode:'SAFETY',actionOutcome:'SUCCESS',activation:safetyNode.activation }); }
      }
    }
  }

  const [semantic] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,confidence,summary FROM memory_consolidations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND consolidation_key=? LIMIT 1`, [simulationId,entityId,`ACTION:${action}:OUTCOME:${result}`]);
  if (semantic.length && desireKey) {
    const consolidated = await activate({ simulationId,entityId,simulationTime,parentActivationId:root?.id || null,sourceType:'MEMORY',sourceKey:`SEMANTIC:${action}:${result}`,targetType:'DESIRE',targetKey:desireKey,activation:base*0.36,depth:2,causeType:'MEMORY_CONSOLIDATION',causeRef:semantic[0].id,weight:0.36,confidence:clamp01(semantic[0].confidence) });
    if (consolidated) { chain.push(consolidated); await updateDesire({ simulationId,entityId,simulationTime,desireKey,actionOutcome:result,activation:consolidated.activation }); }
  }

  return { action, outcome: result, steps: Math.min(chain.length, MAX_STEPS), chain: chain.slice(0, MAX_STEPS) };
}

async function getCausalMind(simulationId, entityId, limit = 40) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 40));
  const [links] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,source_type AS sourceType,source_key AS sourceKey,target_type AS targetType,target_key AS targetKey,weight,polarity,confidence,evidence_count AS evidenceCount,last_activated_simulation_at AS lastActivatedAt,status FROM causal_links WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY ABS(weight) DESC,evidence_count DESC LIMIT ${safeLimit}`, [simulationId,entityId]);
  const [activations] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(parent_activation_id) AS parentActivationId,source_type AS sourceType,source_key AS sourceKey,target_type AS targetType,target_key AS targetKey,activation,depth,cause_type AS causeType,BIN_TO_UUID(cause_ref) AS causeRef,simulation_time AS simulationTime,metadata FROM causal_activations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY simulation_time DESC LIMIT ${safeLimit}`, [simulationId,entityId]);
  for (const item of activations) { if (typeof item.metadata === 'string') { try { item.metadata = JSON.parse(item.metadata); } catch { /* keep raw */ } } }
  return { links, activations };
}

function causalSummary(chain = []) {
  return chain.map(item => `${item.sourceType}:${item.sourceKey} -> ${item.targetType}:${item.targetKey} (${Number(item.activation).toFixed(2)})`).join(' | ');
}

module.exports = { normalize, clamp01, beliefForAction, DESIRES, VALUES, processExperience, getCausalMind, causalSummary, beliefRevisionTarget: (polarity, strength) => polarity >= 0 ? clamp01(strength) : 1 - clamp01(strength) };
