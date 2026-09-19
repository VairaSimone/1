const { pool } = require('../db/pool');
const { uuid } = require('../lib/ids');
const { recordHabitEvidence: recordHabitEvidenceShared } = require('./habit-service');
const { withEntityStateLock } = require('./state-service');

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function clampSigned(value, maxAbs, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-maxAbs, Math.min(maxAbs, n)) : fallback;
}
function safeText(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}
function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalizeKey(value, max = 50) {
  return safeText(value, max).toUpperCase().replace(/\s+/g, '_');
}
async function resolveEntityIdInSimulation(simulationId,entityId){if(!entityId)return null;const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);return rows[0]?.id||null;}

async function getCognitiveProfile(simulationId, entityId) {
  const [[entityRows], [preferences], [beliefs], [knowledge], [habits], [plans]] = await Promise.all([
    pool.query(`SELECT attributes FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`, [simulationId, entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,target_type AS targetType,BIN_TO_UUID(target_entity_id) AS targetEntityId,preference_value AS preferenceValue,strength,confidence,updated_simulation_at AS updatedAt FROM preferences WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY strength DESC,confidence DESC,updated_simulation_at DESC LIMIT 24`, [simulationId, entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(subject_entity_id) AS subjectEntityId,predicate,object_value AS objectValue,confidence,importance,status,updated_simulation_at AS updatedAt FROM beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('ACTIVE','REVISED') ORDER BY importance DESC,confidence DESC,updated_simulation_at DESC LIMIT 24`, [simulationId, entityId]),
    pool.query(`SELECT BIN_TO_UUID(ek.knowledge_item_id) AS id,ki.knowledge_type AS knowledgeType,BIN_TO_UUID(ki.subject_entity_id) AS subjectEntityId,ki.predicate,BIN_TO_UUID(ki.object_entity_id) AS objectEntityId,ki.content,ek.confidence,ek.importance,ek.learned_simulation_at AS learnedAt FROM entity_knowledge ek JOIN knowledge_items ki ON ki.id=ek.knowledge_item_id WHERE ek.simulation_id=UUID_TO_BIN(?) AND ek.entity_id=UUID_TO_BIN(?) AND ek.status='ACTIVE' ORDER BY ek.importance DESC,ek.confidence DESC,ek.last_reinforced_at DESC,ek.learned_simulation_at DESC LIMIT 24`, [simulationId, entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,name,description,strength,frequency,trigger_definition AS triggerDefinition,action_definition AS actionDefinition,status,updated_simulation_at AS updatedAt FROM habits WHERE entity_id=UUID_TO_BIN(?) AND status IN ('ACTIVE','WEAKENING') ORDER BY strength DESC,updated_simulation_at DESC LIMIT 16`, [entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(goal_id) AS goalId,title,status,strategy,created_simulation_at AS createdAt FROM plans WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED') ORDER BY created_simulation_at DESC LIMIT 8`, [simulationId, entityId])
  ]);
  const planIds = plans.map(p => p.id); let planSteps = [];
  if (planIds.length) {
    const placeholders = planIds.map(() => 'UUID_TO_BIN(?)').join(',');
    const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(plan_id) AS planId,sequence,title,description,status,intended_start_simulation_at AS intendedStart,deadline_simulation_at AS deadline,result FROM plan_steps WHERE plan_id IN (${placeholders}) ORDER BY plan_id,sequence`, planIds);
    planSteps = rows;
  }
  const attributes = parseJson(entityRows[0]?.attributes, {}) || {};
  const mentalState = attributes.mentalState && typeof attributes.mentalState === 'object' ? attributes.mentalState : { currentFocus:null,currentConcern:null,recentThought:null,mentalLoad:0.2,rumination:0.1,certainty:0.5,updatedSimulationAt:null };
  const stepsByPlan = new Map();
  for (const step of planSteps) { if (!stepsByPlan.has(step.planId)) stepsByPlan.set(step.planId, []); stepsByPlan.get(step.planId).push(step); }
  return {
    mentalState,
    preferences: preferences.map(p => ({ ...p, preferenceValue:Number(p.preferenceValue), strength:Number(p.strength), confidence:Number(p.confidence) })),
    beliefs: beliefs.map(b => ({ ...b, objectValue:parseJson(b.objectValue,b.objectValue), confidence:Number(b.confidence), importance:Number(b.importance) })),
    knowledge,
    habits: habits.map(h => ({ ...h, strength:Number(h.strength), triggerDefinition:parseJson(h.triggerDefinition,{}), actionDefinition:parseJson(h.actionDefinition,{}) })),
    plans: plans.map(p => ({ ...p, strategy:parseJson(p.strategy,{}), steps:stepsByPlan.get(p.id)||[] }))
  };
}

async function updateMentalState(simulationId, entityId, simulationTime, patch = {}) {
  return withEntityStateLock(entityId, async db => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [rows] = await db.query(`SELECT attributes,version FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`, [simulationId, entityId]);
      if (!rows.length) return null;
      const attributes = parseJson(rows[0].attributes, {}) || {};
      const previous = attributes.mentalState && typeof attributes.mentalState === 'object' ? attributes.mentalState : {};
      attributes.mentalState = {
        currentFocus: patch.currentFocus !== undefined ? safeText(patch.currentFocus,180)||null : previous.currentFocus||null,
        currentConcern: patch.currentConcern !== undefined ? safeText(patch.currentConcern,180)||null : previous.currentConcern||null,
        recentThought: patch.recentThought !== undefined ? safeText(patch.recentThought,300)||null : previous.recentThought||null,
        mentalLoad: clamp01(patch.mentalLoad ?? previous.mentalLoad ?? .2),
        rumination: clamp01(patch.rumination ?? previous.rumination ?? .1),
        certainty: clamp01(patch.certainty ?? previous.certainty ?? .5),
        updatedSimulationAt: simulationTime
      };
      const [updated] = await db.query(`UPDATE entities SET attributes=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) AND version=?`, [JSON.stringify(attributes),simulationId,entityId,rows[0].version]);
      if (updated.affectedRows) return attributes.mentalState;
    }
    return null;
  });
}
async function upsertPreference({ simulationId, entityId, simulationTime, item }) {
  const targetType=normalizeKey(item?.targetType||item?.topic||'TOPIC',50),rawTargetEntityId=item?.targetEntityId||null,targetEntityId=await resolveEntityIdInSimulation(simulationId,rawTargetEntityId),value=clampSigned(item?.value??item?.preferenceValue,1,0),strength=clamp01(item?.strength,.5),confidence=clamp01(item?.confidence,.5);if(!targetType||rawTargetEntityId&&!targetEntityId)return null;
  let rows;
  if(targetEntityId)[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,version,preference_value,strength,confidence FROM preferences WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND target_type=? AND target_entity_id=UUID_TO_BIN(?) ORDER BY updated_simulation_at DESC LIMIT 1`,[simulationId,entityId,targetType,targetEntityId]);
  else [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,version,preference_value,strength,confidence FROM preferences WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND target_type=? AND target_entity_id IS NULL ORDER BY updated_simulation_at DESC LIMIT 1`,[simulationId,entityId,targetType]);
  if(!rows.length){const id=uuid();await pool.query(`INSERT INTO preferences(id,simulation_id,entity_id,target_type,target_entity_id,preference_value,strength,confidence,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,?,?,1)`,[id,simulationId,entityId,targetType,targetEntityId,value,strength,confidence,simulationTime,simulationTime]);return id;}
  const current=rows[0],nextValue=clampSigned(Number(current.preference_value)*.7+value*.3,1,0),nextStrength=clamp01(Number(current.strength)*.75+strength*.25),nextConfidence=clamp01(Number(current.confidence)*.75+confidence*.25);const[updated]=await pool.query(`UPDATE preferences SET preference_value=?,strength=?,confidence=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[nextValue,nextStrength,nextConfidence,simulationTime,current.id,current.version]);return updated.affectedRows?current.id:null;
}

async function upsertBelief({ simulationId, entityId, simulationTime, item }) {
  const predicate=safeText(item?.predicate,150);if(!predicate)return null;const rawSubjectEntityId=item?.subjectEntityId||null,subjectEntityId=await resolveEntityIdInSimulation(simulationId,rawSubjectEntityId),objectValue=item?.objectValue??item?.value??null;if(rawSubjectEntityId&&!subjectEntityId||objectValue===null||objectValue===undefined)return null;
  const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,version,object_value,confidence,importance,status FROM beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND predicate=? AND ((subject_entity_id=UUID_TO_BIN(?)) OR (subject_entity_id IS NULL AND ? IS NULL)) ORDER BY updated_simulation_at DESC LIMIT 1`,[simulationId,entityId,predicate,subjectEntityId,subjectEntityId]);
  const confidence=clamp01(item?.confidence,.55),importance=clamp01(item?.importance,.55);if(!rows.length){const id=uuid();await pool.query(`INSERT INTO beliefs(id,simulation_id,entity_id,subject_entity_id,predicate,object_value,confidence,importance,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,CAST(? AS JSON),?,?, 'ACTIVE',?,?,1)`,[id,simulationId,entityId,subjectEntityId,predicate,JSON.stringify(objectValue),confidence,importance,simulationTime,simulationTime]);return id;}const current=rows[0],nextConfidence=clamp01(Number(current.confidence)*.7+confidence*.3),nextImportance=Math.max(Number(current.importance),importance),[updated]=await pool.query(`UPDATE beliefs SET object_value=CAST(? AS JSON),confidence=?,importance=?,status='REVISED',updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify(objectValue),nextConfidence,nextImportance,simulationTime,current.id,current.version]);return updated.affectedRows?current.id:null;
}

async function upsertKnowledge({ simulationId, entityId, simulationTime, item }) {
  const content=safeText(item?.content,1000);if(!content)return null;const knowledgeType=normalizeKey(item?.knowledgeType||item?.type||'CONVERSATION',50),predicate=safeText(item?.predicate,150)||null,rawSubjectEntityId=item?.subjectEntityId||entityId,rawObjectEntityId=item?.objectEntityId||null,subjectEntityId=await resolveEntityIdInSimulation(simulationId,rawSubjectEntityId),objectEntityId=await resolveEntityIdInSimulation(simulationId,rawObjectEntityId),confidence=clamp01(item?.confidence,.6),importance=clamp01(item?.importance,.55);if(!subjectEntityId)return null;
  const semanticDedup=knowledgeType==='WORLD_EXPERIENCE'&&predicate;
  const existingQuery=semanticDedup
    ? `SELECT BIN_TO_UUID(ki.id) AS id,ek.version,ek.confidence,ek.importance FROM knowledge_items ki JOIN entity_knowledge ek ON ek.knowledge_item_id=ki.id AND ek.entity_id=UUID_TO_BIN(?) WHERE ki.simulation_id=UUID_TO_BIN(?) AND ki.knowledge_type=? AND ki.predicate=? AND ((ki.subject_entity_id=UUID_TO_BIN(?)) OR (ki.subject_entity_id IS NULL AND ? IS NULL)) AND ((ki.object_entity_id=UUID_TO_BIN(?)) OR (ki.object_entity_id IS NULL AND ? IS NULL)) ORDER BY ek.learned_simulation_at DESC LIMIT 1`
    : `SELECT BIN_TO_UUID(ki.id) AS id,ek.version,ek.confidence,ek.importance FROM knowledge_items ki JOIN entity_knowledge ek ON ek.knowledge_item_id=ki.id AND ek.entity_id=UUID_TO_BIN(?) WHERE ki.simulation_id=UUID_TO_BIN(?) AND ki.knowledge_type=? AND ki.content=? ORDER BY ek.learned_simulation_at DESC LIMIT 1`;
  const params=semanticDedup?[entityId,simulationId,knowledgeType,predicate,subjectEntityId,subjectEntityId,objectEntityId,objectEntityId]:[entityId,simulationId,knowledgeType,content];
  const[existing]=await pool.query(existingQuery,params);
  if(!existing.length){const knowledgeId=uuid();await pool.query(`INSERT INTO knowledge_items(id,simulation_id,knowledge_type,subject_entity_id,predicate,object_entity_id,content,metadata,created_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?)`,[knowledgeId,simulationId,knowledgeType,subjectEntityId,predicate,objectEntityId,content,JSON.stringify({source:'conversation'}),simulationTime]);await pool.query(`INSERT INTO entity_knowledge(entity_id,simulation_id,knowledge_item_id,confidence,importance,learned_simulation_at,last_reinforced_at,status,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',1)`,[entityId,simulationId,knowledgeId,confidence,importance,simulationTime,simulationTime]);return knowledgeId;}
  const current=existing[0],nextConfidence=clamp01(Number(current.confidence)*.75+confidence*.25),nextImportance=Math.max(Number(current.importance),importance);const[updated]=await pool.query(`UPDATE entity_knowledge SET confidence=?,importance=?,last_reinforced_at=?,version=version+1 WHERE entity_id=UUID_TO_BIN(?) AND knowledge_item_id=UUID_TO_BIN(?) AND version=?`,[nextConfidence,nextImportance,simulationTime,entityId,current.id,current.version]);return updated.affectedRows?current.id:null;
}

async function createPlanFromProposal({ simulationId, entityId, simulationTime, goalId, proposal }) {
  if(!proposal||typeof proposal!=='object')return null;const title=safeText(proposal.title,255),steps=Array.isArray(proposal.steps)?proposal.steps.filter(s=>safeText(s?.title,255)).slice(0,8):[];if(!title||!steps.length)return null;const normalizedGoalId=goalId||null;const[existing]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,version FROM plans WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND ((goal_id=UUID_TO_BIN(?)) OR (goal_id IS NULL AND ? IS NULL)) AND status IN ('DRAFT','ACTIVE','PAUSED') ORDER BY created_simulation_at DESC LIMIT 1`,[simulationId,entityId,normalizedGoalId,normalizedGoalId]);if(existing.length)return existing[0].id;const planId=uuid();await pool.query(`INSERT INTO plans(id,simulation_id,entity_id,goal_id,title,status,strategy,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,[planId,simulationId,entityId,normalizedGoalId,title,JSON.stringify({...(proposal.strategy||{}),source:'conversation'}),simulationTime]);for(let i=0;i<steps.length;i+=1){const step=steps[i];let activityTypeId=null;const actionType=normalizeKey(step.actionType,100);if(actionType){const[activityRows]=await pool.query(`SELECT id FROM activity_types WHERE code=? AND active=1 LIMIT 1`,[actionType]);activityTypeId=activityRows[0]?.id||null;}await pool.query(`INSERT INTO plan_steps(id,plan_id,sequence,title,description,status,activity_type_id,intended_start_simulation_at,deadline_simulation_at,result,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,'PENDING',?,NULL,NULL,?,1)`,[uuid(),planId,i+1,safeText(step.title,255),safeText(step.description,500)||null,activityTypeId,JSON.stringify({actionType:actionType||null})]);}return planId;
}

async function applyDialogueCognition({ simulationId, entityId, simulationTime, generated, goalId = null }) { const empty={preferenceIds:[],beliefIds:[],knowledgeIds:[],habitId:null,mentalState:null,planId:null};if(!generated?.stateEffects)return empty;const effects=generated.stateEffects,preferenceIds=[],beliefIds=[],knowledgeIds=[];for(const item of Array.isArray(effects.preferences)?effects.preferences:[]){const id=await upsertPreference({simulationId,entityId,simulationTime,item});if(id)preferenceIds.push(id);}for(const item of Array.isArray(effects.beliefs)?effects.beliefs:[]){const id=await upsertBelief({simulationId,entityId,simulationTime,item});if(id)beliefIds.push(id);}for(const item of Array.isArray(effects.knowledge)?effects.knowledge:[]){const id=await upsertKnowledge({simulationId,entityId,simulationTime,item});if(id)knowledgeIds.push(id);}let habitId=null;if(effects.habitCandidate?.actionType&&clamp01(effects.habitCandidate.confidence,0)>=.8)habitId=await recordHabitEvidenceShared({entityId,simulationTime,actionType:effects.habitCandidate.actionType});const reflection=effects.reflection&&typeof effects.reflection==='object'?effects.reflection:{};const mentalState=await updateMentalState(simulationId,entityId,simulationTime,reflection);const planId=await createPlanFromProposal({simulationId,entityId,simulationTime,goalId,proposal:effects.planProposal});return{preferenceIds,beliefIds,knowledgeIds,habitId,mentalState,planId};}

function cognitiveDecisionModifier(profile, actionType) { if(!profile||!actionType)return 0;const key=`ACTION:${normalizeKey(actionType,50)}`;let modifier=0;for(const p of profile.preferences||[])if(normalizeKey(p.targetType,50)===key)modifier+=Number(p.preferenceValue||0)*Number(p.strength||0)*Number(p.confidence||0)*.8;for(const habit of profile.habits||[]){const habitAction=normalizeKey(habit.actionDefinition?.actionType,50);if(habitAction===normalizeKey(actionType,50))modifier+=Number(habit.strength||0)*.25;}return Math.max(-1.5,Math.min(1.5,modifier));}

module.exports={clamp01,clampSigned,safeText,parseJson,normalizeKey,getCognitiveProfile,updateMentalState,upsertPreference,upsertBelief,upsertKnowledge,recordHabitEvidence:recordHabitEvidenceShared,createPlanFromProposal,applyDialogueCognition,cognitiveDecisionModifier};
