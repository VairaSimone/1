const { pool } = require('../db/pool');
const { uuid } = require('../lib/ids');

const initializedIdentity = new Set();

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function safeText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function parseJson(value, fallback = null) { if (value === null || value === undefined) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function normalize(value) { return safeText(value, 120).toUpperCase().replace(/\s+/g, '_'); }

const DEFAULT_VALUES = [
  ['CURIOSITY', 'Curiosity', 0.78], ['LEARNING', 'Learning', 0.72], ['INDEPENDENCE', 'Independence', 0.62],
  ['SOCIAL_CONNECTION', 'Social connection', 0.66], ['ACHIEVEMENT', 'Achievement', 0.58], ['SAFETY', 'Safety', 0.55],
  ['CREATIVITY', 'Creativity', 0.60], ['KINDNESS', 'Kindness', 0.64],
];
const DEFAULT_DESIRES = [
  ['UNDERSTAND_WORLD', 'Understand the world', 'Build a broader and more accurate model of the world through experience and learning.', 'KNOWLEDGE', 0.78],
  ['MEANINGFUL_RELATIONSHIPS', 'Build meaningful relationships', 'Develop a small number of relationships that feel trustworthy and significant.', 'SOCIAL', 0.72],
  ['BECOME_CAPABLE', 'Become more capable', 'Gradually improve useful skills and become better at handling difficult situations.', 'GROWTH', 0.70],
  ['MAINTAIN_AGENCY', 'Maintain independence', 'Keep the ability to choose, explore and act without unnecessary dependence.', 'AUTONOMY', 0.64],
];

async function loadTraits(simulationId, entityId) {
  const [rows] = await pool.query(`SELECT td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`, [entityId]);
  return rows.map(r => ({ code: normalize(r.code), value: clamp01(r.value) }));
}
function traitMap(traits) { return new Map((traits || []).map(t => [normalize(t.code), clamp01(t.value)])); }
function seededValue(code, traits) {
  const t = traitMap(traits), mapping = {
    CURIOSITY: t.get('CURIOSITY'), LEARNING: t.get('OPENNESS'), INDEPENDENCE: t.get('INDEPENDENCE'),
    SOCIAL_CONNECTION: t.get('SOCIABILITY'), ACHIEVEMENT: t.get('CONSCIENTIOUSNESS'),
    SAFETY: Number.isFinite(t.get('RISK_TAKING')) ? 1 - t.get('RISK_TAKING') : undefined,
    CREATIVITY: t.get('CREATIVITY'), KINDNESS: t.get('EMPATHY'),
  };
  return mapping[code] === undefined ? null : clamp01(0.35 + Number(mapping[code]) * 0.55, 0.5);
}

async function ensureIdentity(simulationId, entityId, simulationTime) {
  const key = `${simulationId}:${entityId}`;
  if (initializedIdentity.has(key)) return;
  const [existing] = await pool.query(`SELECT id FROM self_models WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId, entityId]);
  const traits = await loadTraits(simulationId, entityId);
  await pool.query(`INSERT IGNORE INTO self_models(id,simulation_id,entity_id,identity_summary,self_concept,capabilities,aspirations,limitations,current_self_view,version,created_simulation_at,updated_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,1,?,?)`, [uuid(),simulationId,entityId,'A developing person with a persistent history, preferences, relationships and goals.','I am still learning who I am through what I choose, experience and remember.',JSON.stringify({adaptive:true,domains:['social','learning','navigation','self-care']}),JSON.stringify(DEFAULT_DESIRES.map(d=>d[0])),JSON.stringify([]),'I am still forming a stable understanding of myself.',simulationTime,simulationTime]);
  for (const [code,label,fallbackImportance] of DEFAULT_VALUES) {
    const seeded = seededValue(code, traits);
    await pool.query(`INSERT IGNORE INTO identity_values(id,simulation_id,entity_id,code,label,importance,confidence,origin,salience,version,created_simulation_at,updated_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,1,?,?)`, [uuid(),simulationId,entityId,code,label,seeded ?? fallbackImportance,0.45,seeded===null?'INITIAL':'TRAIT_DERIVED',0.5,simulationTime,simulationTime]);
  }
  for (const [keyName,title,description,desireType,priority] of DEFAULT_DESIRES) {
    await pool.query(`INSERT IGNORE INTO long_term_desires(id,simulation_id,entity_id,desire_key,title,description,desire_type,priority,persistence,progress,status,origin,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,0,'ACTIVE','INITIAL',?,?,1)`, [uuid(),simulationId,entityId,keyName,title,description,desireType,priority,0.86,simulationTime,simulationTime]);
  }
  const [beliefs] = await pool.query(`SELECT id FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId]);
  {
    const t = traitMap(traits), defaults = [
      ['CURIOUS','I am a curious person.',clamp01(0.45+(t.get('CURIOSITY')??0.5)*0.45)],
      ['CAPABLE_OF_LEARNING','I can learn from experience.',clamp01(0.52+(t.get('OPENNESS')??0.5)*0.35)],
      ['SOCIAL_CAPABILITY','I can build connections with people.',clamp01(0.42+(t.get('SOCIABILITY')??0.5)*0.38)],
      ['AGENCY','My choices can change what happens next.',clamp01(0.48+(t.get('CONFIDENCE')??0.5)*0.35)],
    ];
    for (const [beliefKey,statement,confidence] of defaults) await pool.query(`INSERT IGNORE INTO self_beliefs(id,simulation_id,entity_id,belief_key,statement,confidence,importance,source_type,source_ref,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,NULL,'ACTIVE',?,?,1)`, [uuid(),simulationId,entityId,beliefKey,statement,confidence,0.65,'INITIAL',simulationTime,simulationTime]);
  }
  const [narrative] = await pool.query(`SELECT id FROM life_narratives WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId]);
  if (!narrative.length) await pool.query(`INSERT INTO life_narratives(id,simulation_id,entity_id,chapter_index,title,summary,importance,event_id,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),1,'Beginning','My story is only beginning. I learn who I am through what happens to me and what I choose to do next.',0.82,NULL,?,?,1)`, [uuid(),simulationId,entityId,simulationTime,simulationTime]);
  initializedIdentity.add(key);
}

async function getIdentity(simulationId, entityId) {
  const [[selfRows],[values],[beliefs],[desires],[narrative]] = await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) AS id,identity_summary AS identitySummary,self_concept AS selfConcept,capabilities,aspirations,limitations,current_self_view AS currentSelfView,version,updated_simulation_at AS updatedAt FROM self_models WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,code,label,importance,confidence,origin,salience,updated_simulation_at AS updatedAt FROM identity_values WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY importance DESC,salience DESC LIMIT 24`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,belief_key AS beliefKey,statement,confidence,importance,source_type AS sourceType,status,updated_simulation_at AS updatedAt FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY importance DESC,confidence DESC LIMIT 16`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,desire_key AS desireKey,title,description,desire_type AS desireType,priority,persistence,progress,status,origin,created_simulation_at AS createdAt,updated_simulation_at AS updatedAt FROM long_term_desires WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('ACTIVE','PAUSED') ORDER BY priority DESC,created_simulation_at ASC LIMIT 12`, [simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,chapter_index AS chapterIndex,title,summary,importance,created_simulation_at AS createdAt,updated_simulation_at AS updatedAt FROM life_narratives WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY chapter_index DESC,created_simulation_at DESC LIMIT 8`, [simulationId,entityId]),
  ]);
  const self = selfRows[0] || null;
  if (self) { self.capabilities=parseJson(self.capabilities,{}); self.aspirations=parseJson(self.aspirations,[]); self.limitations=parseJson(self.limitations,[]); }
  return { self, values, beliefs, desires, narrative };
}

async function updateSelfModel(simulationId, entityId, simulationTime, patch = {}) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,identity_summary,self_concept,capabilities,aspirations,limitations,current_self_view,version FROM self_models WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId,entityId]);
  if (!rows.length) return null;
  const row=rows[0], current={identitySummary:row.identity_summary,selfConcept:row.self_concept,capabilities:parseJson(row.capabilities,{}),aspirations:parseJson(row.aspirations,[]),limitations:parseJson(row.limitations,[]),currentSelfView:row.current_self_view}, next={identitySummary:patch.identitySummary??current.identitySummary,selfConcept:patch.selfConcept??current.selfConcept,capabilities:patch.capabilities??current.capabilities,aspirations:patch.aspirations??current.aspirations,limitations:patch.limitations??current.limitations,currentSelfView:patch.currentSelfView??current.currentSelfView};
  const [updated] = await pool.query(`UPDATE self_models SET identity_summary=?,self_concept=?,capabilities=?,aspirations=?,limitations=?,current_self_view=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next.identitySummary,next.selfConcept,JSON.stringify(next.capabilities),JSON.stringify(next.aspirations),JSON.stringify(next.limitations),next.currentSelfView,simulationTime,row.id,row.version]);
  if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on self model"), { code: "OPTIMISTIC_LOCK" });
  return next;
}

async function updateSelfBelief({simulationId,entityId,simulationTime,beliefKey,statement,confidence,importance=0.6,sourceType='EXPERIENCE'}) {
  const key=normalize(beliefKey).slice(0,80); if(!key||!safeText(statement,300))return null;
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,confidence,importance,version FROM self_beliefs WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND belief_key=? LIMIT 1`,[simulationId,entityId,key]);
  if(!rows.length){const id=uuid();await pool.query(`INSERT INTO self_beliefs(id,simulation_id,entity_id,belief_key,statement,confidence,importance,source_type,source_ref,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,NULL,'ACTIVE',?,?,1)`,[id,simulationId,entityId,key,safeText(statement,300),clamp01(confidence),clamp01(importance),sourceType,simulationTime,simulationTime]);return id;}
  const row=rows[0],nextConfidence=clamp01(Number(row.confidence)*0.82+clamp01(confidence)*0.18),nextImportance=Math.max(Number(row.importance),clamp01(importance)),[updated]=await pool.query(`UPDATE self_beliefs SET statement=?,confidence=?,importance=?,source_type=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[safeText(statement,300),nextConfidence,nextImportance,sourceType,simulationTime,row.id,row.version]);if(!updated.affectedRows)throw Object.assign(new Error("Optimistic lock conflict on self belief"),{code:"OPTIMISTIC_LOCK"});return row.id;
}

async function updateDesireProgress(simulationId,entityId,simulationTime,{desireKey=null,delta=0,reason=null}={}) { if(!desireKey)return null;const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,progress,version,title FROM long_term_desires WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND desire_key=? AND status='ACTIVE' LIMIT 1`,[simulationId,entityId,normalize(desireKey)]);if(!rows.length)return null;const row=rows[0],next=clamp01(Number(row.progress)+Number(delta)),[updated]=await pool.query(`UPDATE long_term_desires SET progress=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,row.id,row.version]);if(!updated.affectedRows)throw Object.assign(new Error("Optimistic lock conflict on desire"),{code:"OPTIMISTIC_LOCK"});return{id:row.id,title:row.title,progress:next,reason}; }

async function recordLifeNarrative(simulationId,entityId,simulationTime,{title,summary,importance=0.55,eventId=null}={}) { const cleanTitle=safeText(title,180),cleanSummary=safeText(summary,1000);if(!cleanTitle||!cleanSummary)return null;const[rows]=await pool.query(`SELECT COALESCE(MAX(chapter_index),0) AS maxIndex FROM life_narratives WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)`,[simulationId,entityId]);const id=uuid(),chapterIndex=Number(rows[0]?.maxIndex||0)+1;await pool.query(`INSERT INTO life_narratives(id,simulation_id,entity_id,chapter_index,title,summary,importance,event_id,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),?,?,1)`,[id,simulationId,entityId,chapterIndex,cleanTitle,cleanSummary,clamp01(importance),eventId,simulationTime,simulationTime]);return id; }

async function recordExpectation({simulationId,entityId,decisionId,simulationTime,actionType,expectedUtility,expectedSuccessProbability,prediction=null}) { const id=uuid();await pool.query(`INSERT INTO cognitive_expectations(id,simulation_id,entity_id,decision_id,action_type,expected_utility,expected_success_probability,prediction,actual_outcome,prediction_error,regret_score,status,created_simulation_at,resolved_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,NULL,NULL,NULL,'OPEN',?,NULL,1)`,[id,simulationId,entityId,decisionId,normalize(actionType),clamp01(expectedUtility,0.5),clamp01(expectedSuccessProbability,0.6),prediction?JSON.stringify(prediction):null,simulationTime]);return id; }

async function resolveExpectation({simulationId,entityId,decisionId,simulationTime,actualOutcome,alternativeUtilities=[]}) { const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,expected_utility AS expectedUtility,expected_success_probability AS expectedSuccessProbability,version FROM cognitive_expectations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?) AND status='OPEN' LIMIT 1`,[simulationId,entityId,decisionId]);if(!rows.length)return null;const row=rows[0],outcomeScore=normalize(actualOutcome)==='SUCCESS'?1:normalize(actualOutcome)==='PARTIAL'?0.5:0,predictionError=outcomeScore-Number(row.expectedSuccessProbability||0),bestAlternative=Math.max(Number(row.expectedUtility||0),...alternativeUtilities.map(Number).filter(Number.isFinite)),regret=Math.max(0,bestAlternative-Number(row.expectedUtility||0))*(1-outcomeScore*0.5),[updated]=await pool.query(`UPDATE cognitive_expectations SET actual_outcome=?,prediction_error=?,regret_score=?,status='RESOLVED',resolved_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify({outcome:actualOutcome,score:outcomeScore}),predictionError,clamp01(regret,0),simulationTime,row.id,row.version]);return updated.affectedRows?{...row,outcomeScore,predictionError,regret}:null; }

async function createCounterfactuals({simulationId,entityId,decisionId,simulationTime,alternatives=[]}) { const created=[];for(const alternative of alternatives.slice(0,4)){if(!alternative?.action||alternative.action===alternative.selectedAction)continue;const id=uuid();await pool.query(`INSERT INTO counterfactuals(id,simulation_id,entity_id,decision_id,alternative_action,predicted_outcome,predicted_utility,regret_score,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,0,?,1)`,[id,simulationId,entityId,decisionId,normalize(alternative.action),JSON.stringify(alternative.predictedOutcome||{}),clamp01(alternative.utility,0),simulationTime]);created.push(id);}return created; }
async function applyRegretToCounterfactuals({simulationId,entityId,decisionId,regret,simulationTime}) { await pool.query(`UPDATE counterfactuals SET regret_score=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?)`,[clamp01(regret,0),simulationId,entityId,decisionId]); }
async function upsertIdentityValue({simulationId,entityId,simulationTime,code,importanceDelta=0,confidenceDelta=0,salience=null,origin='EXPERIENCE'}) { const key=normalize(code),[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,importance,confidence,version FROM identity_values WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND code=? LIMIT 1`,[simulationId,entityId,key]);if(!rows.length)return null;const row=rows[0],nextImportance=clamp01(Number(row.importance)+Math.max(-0.02,Math.min(0.02,Number(importanceDelta)||0))),nextConfidence=clamp01(Number(row.confidence)+Math.max(-0.025,Math.min(0.025,Number(confidenceDelta)||0))),nextSalience=salience===null?null:clamp01(salience),[updated]=await pool.query(`UPDATE identity_values SET importance=?,confidence=?,salience=COALESCE(?,salience),origin=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[nextImportance,nextConfidence,nextSalience,origin,simulationTime,row.id,row.version]);if(!updated.affectedRows)throw Object.assign(new Error("Optimistic lock conflict on identity value"),{code:"OPTIMISTIC_LOCK"});return{id:row.id,code:key,importance:nextImportance,confidence:nextConfidence,salience:nextSalience}; }

async function getOpenPromises(simulationId,entityId,limit=12) { const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,title,description,BIN_TO_UUID(target_entity_id) AS targetEntityId,due_simulation_at AS dueSimulationAt,status,importance,created_simulation_at AS createdAt FROM promises WHERE simulation_id=UUID_TO_BIN(?) AND issuer_entity_id=UUID_TO_BIN(?) AND status IN ('OPEN','KEPT') ORDER BY importance DESC,due_simulation_at IS NULL,due_simulation_at ASC LIMIT ?`,[simulationId,entityId,limit]);return rows; }

async function getSocialMind(simulationId,entityId) { const[[memberships],[reputations],[obligations],[norms]]=await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(sgm.group_id) AS groupId,sg.name,sg.group_type AS groupType,sgm.role,sgm.status FROM social_group_members sgm JOIN social_groups sg ON sg.id=sgm.group_id WHERE sgm.simulation_id=UUID_TO_BIN(?) AND sgm.entity_id=UUID_TO_BIN(?) AND sgm.status='ACTIVE' ORDER BY sg.name`,[simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(r.id) AS id,BIN_TO_UUID(r.observer_entity_id) AS observerEntityId,score,reliability,context,status,updated_simulation_at AS updatedAt FROM reputations r WHERE r.simulation_id=UUID_TO_BIN(?) AND r.subject_entity_id=UUID_TO_BIN(?) ORDER BY score DESC LIMIT 12`,[simulationId,entityId]),
    pool.query(`SELECT BIN_TO_UUID(id) AS id,title,description,type,priority,due_simulation_at AS dueSimulationAt,status,created_simulation_at AS createdAt FROM social_obligations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='OPEN' ORDER BY priority DESC,due_simulation_at ASC LIMIT 12`,[simulationId,entityId]),
    pool.query(`SELECT code,title,description,importance FROM social_norms WHERE active=1 ORDER BY importance DESC LIMIT 12`),
  ]);return{memberships,reputations,obligations,norms}; }

async function processConversationCommitments({simulationId,entityId,simulationTime,content}) { const text=safeText(content,4000),promiseMatch=/\b(?:ti\s+prometto(?:\s+che|\s+di)?|prometto(?:\s+che|\s+di)|ho\s+promesso(?:\s+che|\s+di)|I\s+promise(?:\s+to)?|I\s+said\s+I\s+would)\b/i.test(text),created={promises:[],obligations:[]};if(promiseMatch){const id=uuid(),due=/domani|tomorrow/i.test(text)?new Date(new Date(simulationTime).getTime()+24*3600000):null,title=safeText(text.replace(/\s+/g,' '),180)||'Commitment';await pool.query(`INSERT INTO promises(id,simulation_id,issuer_entity_id,title,description,target_entity_id,due_simulation_at,status,importance,source_message_id,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,NULL,?,'OPEN',?,?,?, ?,1)`,[id,simulationId,entityId,title,text.slice(0,1000),due,0.78,null,simulationTime,simulationTime]);created.promises.push(id);}if(/\b(?:devo|dovrei|mi sono impegnat[oa]|I\s+must|I\s+should)\b/i.test(text)&&!promiseMatch){const id=uuid();await pool.query(`INSERT INTO social_obligations(id,simulation_id,entity_id,title,description,type,priority,due_simulation_at,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'SELF_DECLARED',?,?,?,?,1)`,[id,simulationId,entityId,safeText(text.replace(/\s+/g,' '),180),text.slice(0,1000),0.5,null,'OPEN',simulationTime,simulationTime]);created.obligations.push(id);}return created; }

async function updateReputationAfterInteraction({simulationId,entityId,observerEntityId,simulationTime,delta=0.02}) { if(!observerEntityId||observerEntityId===entityId)return null;const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,score,reliability,version FROM reputations WHERE simulation_id=UUID_TO_BIN(?) AND subject_entity_id=UUID_TO_BIN(?) AND observer_entity_id=UUID_TO_BIN(?) AND context='DIRECT_INTERACTION' LIMIT 1`,[simulationId,entityId,observerEntityId]);if(!rows.length){const id=uuid();await pool.query(`INSERT INTO reputations(id,simulation_id,subject_entity_id,observer_entity_id,group_id,score,reliability,context,status,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,?, 'DIRECT_INTERACTION','ACTIVE',?,?,1)`,[id,simulationId,entityId,observerEntityId,clamp01(0.5+delta),0.35,simulationTime,simulationTime]);return id;}const row=rows[0],next=clamp01(Number(row.score)+Math.max(-0.05,Math.min(0.05,delta))),[updated]=await pool.query(`UPDATE reputations SET score=?,reliability=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[next,clamp01(Number(row.reliability)+0.02),simulationTime,row.id,row.version]);return updated.affectedRows?row.id:null; }

async function buildAttentionContext({simulationId,entityId,context}) {
  const signals=[],needs=Array.isArray(context?.needs)?context.needs:[];
  for(const need of needs){const value=Number(need.value);if(Number.isFinite(value)&&['HUNGER','THIRST','SLEEPINESS'].includes(normalize(need.code))&&value>=0.55)signals.push({type:'PHYSIOLOGICAL',code:normalize(need.code),intensity:clamp01(value),reason:'internal pressure'});if(Number.isFinite(value)&&['SOCIAL_NEED','BELONGING','CURIOSITY','ACHIEVEMENT','FUN'].includes(normalize(need.code))&&value>=0.65)signals.push({type:'MOTIVATIONAL',code:normalize(need.code),intensity:clamp01(value),reason:'persistent drive'});}
  for(const goal of context?.goals||[])if(Number(goal.progress||0)<1&&Number(goal.priority||0)>=0.55)signals.push({type:'GOAL',goalId:goal.id,intensity:clamp01(goal.priority),title:goal.title});
  for(const desire of context?.cognitiveV2?.identity?.desires||[])if(Number(desire.priority||0)>=0.65&&Number(desire.progress||0)<1)signals.push({type:'DESIRE',desireKey:desire.desireKey,intensity:clamp01(Number(desire.priority)*(1-Number(desire.progress||0))),title:desire.title});
  if(context?.social?.candidates?.length)signals.push({type:'SOCIAL_OPPORTUNITY',intensity:0.42,count:context.social.candidates.length});
  const [events]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id,e.title,e.description,e.importance,et.code AS type FROM events e JOIN event_types et ON et.id=e.event_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND e.simulation_at<=? ORDER BY e.simulation_at DESC LIMIT 8`,[simulationId,context.simulationTime]);
  for(const event of events.slice(0,4))if(Number(event.importance)>=0.65)signals.push({type:'WORLD_EVENT',eventId:event.id,intensity:clamp01(event.importance),title:event.title,description:event.description,eventType:event.type});
  const promises=await getOpenPromises(simulationId,entityId,8);for(const promise of promises)signals.push({type:'SOCIAL_COMMITMENT',promiseId:promise.id,intensity:clamp01(Number(promise.importance||0.5)+0.12),title:promise.title});
  signals.sort((a,b)=>Number(b.intensity||0)-Number(a.intensity||0));return signals.slice(0,12);
}

function buildInterpretation(attention,context) { const primary=attention[0]||null,interpretations=[];if(primary)interpretations.push({type:'PRIMARY_DRIVE',statement:primary.type==='GOAL'?`An active goal is demanding attention: ${primary.title||primary.goalId}.`:primary.reason?`${primary.code||primary.type} is salient because of ${primary.reason}.`:`${primary.type} is currently salient.`,confidence:0.66+Math.min(0.28,Number(primary.intensity||0)*0.25)});if(context?.resourceContext?.actions){const constrained=Object.entries(context.resourceContext.actions).find(([,value])=>!value.locallyAvailable&&Number(value.nearestLocation?.travelMinutes)>=15);if(constrained)interpretations.push({type:'PHYSICAL_CONSTRAINT',statement:`${constrained[0]} requires travel before the desired outcome is feasible.`,confidence:0.83});}if((context?.cognitiveV2?.conflicts||[]).length)interpretations.push({type:'INTERNAL_CONFLICT',statement:'Multiple motives are competing for the same decision.',confidence:0.72});return interpretations.slice(0,6); }

function buildConflicts({context,attention=[],identity}) { const drivers=[];for(const need of context?.needs||[]){const code=normalize(need.code),value=Number(need.value||0);if(!Number.isFinite(value))continue;const highPressure=['HUNGER','THIRST','SLEEPINESS','SOCIAL_NEED','BELONGING','FUN','CURIOSITY','ACHIEVEMENT'].includes(code)?value:1-value;if(highPressure>=0.45)drivers.push({type:'NEED',code,intensity:highPressure,weight:Number(need.priorityWeight||1)});}for(const goal of context?.goals||[])drivers.push({type:'GOAL',id:goal.id,intensity:Number(goal.priority||0)*(1-Number(goal.progress||0)),weight:1});for(const desire of identity?.desires||[])drivers.push({type:'DESIRE',id:desire.desireKey,intensity:Number(desire.priority||0)*(1-Number(desire.progress||0)),weight:1});drivers.sort((a,b)=>(b.intensity*b.weight)-(a.intensity*a.weight));if(drivers.length<2)return[];const conflicts=[],top=drivers[0];for(const other of drivers.slice(1,4)){const gap=Math.abs(top.intensity-other.intensity);if(gap<=0.24)conflicts.push({left:top,right:other,intensity:clamp01((top.intensity+other.intensity)/2),status:'ACTIVE'});}return conflicts.slice(0,3); }
async function persistConflicts(simulationId,entityId,simulationTime,conflicts){
  const current=Array.isArray(conflicts)?conflicts:[];
  const fingerprints=new Map();
  for(const conflict of current){
    if(!conflict?.left||!conflict?.right)continue;
    const leftKey=`${conflict.left.type}:${conflict.left.code||conflict.left.id}`,
      rightKey=`${conflict.right.type}:${conflict.right.code||conflict.right.id}`,
      fingerprint=[leftKey,rightKey].sort().join('|');
    fingerprints.set(fingerprint,conflict);
  }

  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,fingerprint,version,status
     FROM cognitive_conflicts
     WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)`,
    [simulationId,entityId]
  );
  const existingByFingerprint=new Map(rows.map(row=>[row.fingerprint,row]));
  let resolved=0,reopened=0;

  for(const row of rows){
    if(row.status==='ACTIVE'&&!fingerprints.has(row.fingerprint)){
      const [updated]=await pool.query(
        `UPDATE cognitive_conflicts
         SET intensity=0,resolution=?,status='RESOLVED',updated_simulation_at=?,version=version+1
         WHERE id=UUID_TO_BIN(?) AND version=?`,
        [JSON.stringify({reason:'DRIVERS_NO_LONGER_COMPETE',resolvedAt:simulationTime}),simulationTime,row.id,row.version]
      );
      if(updated.affectedRows)resolved+=1;
    }
  }

  for(const [fingerprint,conflict] of fingerprints){
    const leftKey=`${conflict.left.type}:${conflict.left.code||conflict.left.id}`,
      rightKey=`${conflict.right.type}:${conflict.right.code||conflict.right.id}`,
      row=existingByFingerprint.get(fingerprint);
    if(row){
      const wasResolved=row.status==='RESOLVED';
      const [updated]=await pool.query(
        `UPDATE cognitive_conflicts
         SET left_driver=?,right_driver=?,intensity=?,resolution=NULL,status='ACTIVE',updated_simulation_at=?,version=version+1
         WHERE id=UUID_TO_BIN(?) AND version=?`,
        [JSON.stringify(conflict.left),JSON.stringify(conflict.right),clamp01(conflict.intensity),simulationTime,row.id,row.version]
      );
      if(updated.affectedRows&&wasResolved)reopened+=1;
      continue;
    }
    const id=uuid();
    await pool.query(
      `INSERT INTO cognitive_conflicts
       (id,simulation_id,entity_id,fingerprint,left_driver,right_driver,intensity,resolution,status,created_simulation_at,updated_simulation_at,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,NULL,'ACTIVE',?,?,1)`,
      [id,simulationId,entityId,fingerprint,JSON.stringify(conflict.left),JSON.stringify(conflict.right),clamp01(conflict.intensity),simulationTime,simulationTime]
    );
  }
  return {active:fingerprints.size,resolved,reopened};
}

async function saveCognitiveState(simulationId,entityId,simulationTime,attention,interpretation,conflicts){const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,simulation_time AS simulationTime FROM cognitive_states WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY simulation_time DESC LIMIT 1`,[simulationId,entityId]);if(rows.length&&new Date(simulationTime)-new Date(rows[0].simulationTime)<15*60000){await pool.query(`UPDATE cognitive_states SET simulation_time=?,attention=?,interpretation=?,conflicts=? WHERE id=UUID_TO_BIN(?)`,[simulationTime,JSON.stringify(attention),JSON.stringify(interpretation),JSON.stringify(conflicts),rows[0].id]);return rows[0].id;}await pool.query(`INSERT INTO cognitive_states(id,simulation_id,entity_id,simulation_time,attention,interpretation,conflicts,created_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?, ?,CURRENT_TIMESTAMP(3))`,[uuid(),simulationId,entityId,simulationTime,JSON.stringify(attention),JSON.stringify(interpretation),JSON.stringify(conflicts)]);}

async function enrichContext({simulationId,entityId,simulationTime,context}){await ensureIdentity(simulationId,entityId,simulationTime);const identity=await getIdentity(simulationId,entityId),base={...context,cognitiveV2:{...(context.cognitiveV2||{}),identity}},attention=await buildAttentionContext({simulationId,entityId,context:base}),conflicts=buildConflicts({context:base,attention,identity}),interpretation=buildInterpretation(attention,{...base,cognitiveV2:{...base.cognitiveV2,conflicts}}),enriched={...base,cognitiveV2:{identity,attention,interpretation,conflicts}};await persistConflicts(simulationId,entityId,simulationTime,conflicts);await saveCognitiveState(simulationId,entityId,simulationTime,attention,interpretation,conflicts);return enriched;}
async function getLatestCognitiveState(simulationId,entityId){const[rows]=await pool.query(`SELECT attention,interpretation,conflicts,simulation_time AS simulationTime FROM cognitive_states WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY simulation_time DESC LIMIT 1`,[simulationId,entityId]);const row=rows[0];return row?{attention:parseJson(row.attention,[]),interpretation:parseJson(row.interpretation,[]),conflicts:parseJson(row.conflicts,[]),simulationTime:row.simulationTime}:{attention:[],interpretation:[],conflicts:[],simulationTime:null};}
async function getMind(simulationId,entityId){const[[simulationRows],[entityRows]]=await Promise.all([pool.query(`SELECT current_simulation_at AS currentSimulationAt FROM simulations WHERE id=UUID_TO_BIN(?) LIMIT 1`,[simulationId]),pool.query(`SELECT id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId])]);if(!simulationRows.length)throw Object.assign(new Error("Simulation not found"),{code:"NOT_FOUND"});if(!entityRows.length)throw Object.assign(new Error("Entity not found"),{code:"NOT_FOUND"});await ensureIdentity(simulationId,entityId,simulationRows[0].currentSimulationAt);const[identity,state,expectations,counterfactuals,promises,social]=await Promise.all([getIdentity(simulationId,entityId),getLatestCognitiveState(simulationId,entityId),pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(decision_id) AS decisionId,action_type AS actionType,expected_utility AS expectedUtility,expected_success_probability AS expectedSuccessProbability,prediction_error AS predictionError,regret_score AS regretScore,status,created_simulation_at AS createdAt,resolved_simulation_at AS resolvedAt FROM cognitive_expectations WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 10`,[simulationId,entityId]),pool.query(`SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(decision_id) AS decisionId,alternative_action AS alternativeAction,predicted_outcome AS predictedOutcome,predicted_utility AS predictedUtility,regret_score AS regretScore,created_simulation_at AS createdAt FROM counterfactuals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 10`,[simulationId,entityId]),getOpenPromises(simulationId,entityId),getSocialMind(simulationId,entityId)]);return{...identity,state,expectations:expectations[0],counterfactuals:counterfactuals[0],promises,social};}
async function learnFromOutcome({simulationId,entityId,simulationTime,actionType,outcome,decisionId,expectation,targetEntityId=null}){const normalized=normalize(outcome);if(normalized==='SUCCESS')await upsertIdentityValue({simulationId,entityId,simulationTime,code:actionType==='TALKING'?'SOCIAL_CONNECTION':actionType==='EXPLORING'||actionType==='LEARNING'?'CURIOSITY':'ACHIEVEMENT',confidenceDelta:0.015,importanceDelta:0.006,salience:0.65});else await upsertIdentityValue({simulationId,entityId,simulationTime,code:'SAFETY',confidenceDelta:0.01,importanceDelta:normalized==='FAILURE'?0.012:0.004,salience:0.8});if(expectation&&Math.abs(Number(expectation.predictionError||0))>=0.45)await updateSelfBelief({simulationId,entityId,simulationTime,beliefKey:'UNCERTAINTY_AWARENESS',statement:normalized==='SUCCESS'?'My expectations can be wrong, but I can update them when reality contradicts me.':'I need to account for uncertainty and unexpected outcomes before acting.',confidence:0.68,importance:0.72,sourceType:'PREDICTION_ERROR'});if(targetEntityId&&actionType==='TALKING')await updateSelfBelief({simulationId,entityId,simulationTime,beliefKey:'SOCIAL_LEARNING',statement:'Interactions with other people teach me how I fit into relationships.',confidence:0.72,importance:0.67,sourceType:'SOCIAL_EXPERIENCE'});}

module.exports={clamp01,safeText,parseJson,normalize,ensureIdentity,getIdentity,updateSelfModel,updateSelfBelief,updateDesireProgress,recordLifeNarrative,recordExpectation,resolveExpectation,createCounterfactuals,applyRegretToCounterfactuals,upsertIdentityValue,getOpenPromises,getSocialMind,processConversationCommitments,updateReputationAfterInteraction,buildAttentionContext,buildInterpretation,buildConflicts,persistConflicts,saveCognitiveState,enrichContext,getLatestCognitiveState,getMind,learnFromOutcome};
