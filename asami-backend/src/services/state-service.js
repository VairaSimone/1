const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { clamp } = require("./state-rules");

function round5(value) { return Math.round((Number(value) + Number.EPSILON) * 100000) / 100000; }
function parseJson(value, fallback = {}) { if (value === null || value === undefined) return fallback; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return fallback; } }
const NEED_HISTORY_MIN_DELTA = Number.isFinite(Number(process.env.NEED_HISTORY_MIN_DELTA))
  ? Math.max(0, Number(process.env.NEED_HISTORY_MIN_DELTA))
  : 0.01;
const EMOTION_HISTORY_MIN_DELTA = Number.isFinite(Number(process.env.EMOTION_HISTORY_MIN_DELTA))
  ? Math.max(0, Number(process.env.EMOTION_HISTORY_MIN_DELTA))
  : 0.01;
const pendingNeedHistory = new Map();
const pendingEmotionHistory = new Map();

const CRITICAL_NEED_THRESHOLDS = Object.freeze({
  THIRST: { direction: "HIGH", threshold: 0.8 },
  HUNGER: { direction: "HIGH", threshold: 0.8 },
  SLEEPINESS: { direction: "HIGH", threshold: 0.85 },
  ENERGY: { direction: "LOW", threshold: 0.15 },
  SAFETY: { direction: "LOW", threshold: 0.2 }
});

function historyScopeKey(kind, entityId, stateId, causeActionId = null, causeEventId = null, simulationTime = null) {
  const cause = causeActionId
    ? `action:${causeActionId}`
    : causeEventId
      ? `event:${causeEventId}`
      : `time:${String(simulationTime || "")}`;
  return `${kind}:${entityId}:${stateId}:${cause}`;
}

function crossesCriticalNeedThreshold(code, oldValue, newValue) {
  const policy = CRITICAL_NEED_THRESHOLDS[String(code || "").toUpperCase()];
  if (!policy) return false;
  const oldNumber = Number(oldValue), newNumber = Number(newValue), threshold = Number(policy.threshold);
  if (![oldNumber, newNumber, threshold].every(Number.isFinite)) return false;
  if (policy.direction === "HIGH") return (oldNumber < threshold && newNumber >= threshold) || (oldNumber >= threshold && newNumber < threshold);
  return (oldNumber > threshold && newNumber <= threshold) || (oldNumber <= threshold && newNumber > threshold);
}

function shouldPersistHistory({ delta, significant = false, critical = false, threshold }) {
  return Boolean(significant || critical || Math.abs(Number(delta) || 0) >= threshold);
}

async function accumulateNeedHistory({ entityId, needId, code, oldValue, newValue, simulationTime, causeEventId = null, causeActionId = null, significant = false }) {
  const delta = round5(Number(newValue) - Number(oldValue));
  if (Math.abs(delta) < 0.000001) return false;

  const key = historyScopeKey("need", entityId, needId, causeActionId, causeEventId, simulationTime);
  const existing = pendingNeedHistory.get(key);
  const pending = existing
    ? { ...existing, newValue, delta: round5(Number(newValue) - Number(existing.oldValue)) }
    : {
        entityId,
        needId,
        code,
        oldValue: Number(oldValue),
        newValue: Number(newValue),
        delta,
        simulationTime,
        causeEventId,
        causeActionId
      };

  pending.newValue = Number(newValue);
  pending.delta = round5(pending.newValue - Number(pending.oldValue));
  pending.simulationTime = simulationTime;
  pending.causeEventId = causeEventId || pending.causeEventId || null;
  pending.causeActionId = causeActionId || pending.causeActionId || null;
  pendingNeedHistory.set(key, pending);

  const critical = crossesCriticalNeedThreshold(code, pending.oldValue, pending.newValue);
  if (!shouldPersistHistory({ delta: pending.delta, significant, critical, threshold: NEED_HISTORY_MIN_DELTA })) return false;

  const matchCondition = pending.causeActionId
    ? `entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND cause_action_id=UUID_TO_BIN(?)`
    : pending.causeEventId
      ? `entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND cause_event_id=UUID_TO_BIN(?)`
      : null;
  const matchParams = pending.causeActionId
    ? [pending.entityId, pending.needId, pending.causeActionId]
    : pending.causeEventId
      ? [pending.entityId, pending.needId, pending.causeEventId]
      : [];

  if (matchCondition) {
    const [existingRows] = await pool.query(
      `SELECT BIN_TO_UUID(id) AS id,old_value AS oldValue
       FROM entity_need_history
       WHERE ${matchCondition}
       ORDER BY simulation_time ASC
       LIMIT 1`,
      matchParams
    );
    if (existingRows.length) {
      const existing = existingRows[0];
      const mergedDelta = round5(Number(pending.newValue) - Number(existing.oldValue));
      await pool.query(
        `UPDATE entity_need_history
         SET new_value=?,delta=?,simulation_time=?,cause_event_id=COALESCE(UUID_TO_BIN(?),cause_event_id)
         WHERE id=UUID_TO_BIN(?)`,
        [
          round5(pending.newValue),
          mergedDelta,
          pending.simulationTime,
          pending.causeEventId,
          existing.id
        ]
      );
      pendingNeedHistory.delete(key);
      return true;
    }
  }

  await pool.query(
    `INSERT INTO entity_need_history
      (id,entity_id,need_id,old_value,new_value,delta,simulation_time,cause_event_id,cause_action_id)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))`,
    [
      uuid(),
      pending.entityId,
      pending.needId,
      round5(pending.oldValue),
      round5(pending.newValue),
      round5(pending.delta),
      pending.simulationTime,
      pending.causeEventId,
      pending.causeActionId
    ]
  );
  pendingNeedHistory.delete(key);
  return true;
}

async function accumulateEmotionHistory({ entityId, emotionId, code, oldIntensity, newIntensity, simulationTime, causeEventId = null, causeActionId = null, significant = false }) {
  const delta = round5(Number(newIntensity) - Number(oldIntensity));
  if (Math.abs(delta) < 0.000001) return false;

  const key = historyScopeKey("emotion", entityId, emotionId, causeActionId, causeEventId, simulationTime);
  const existing = pendingEmotionHistory.get(key);
  const pending = existing
    ? { ...existing, newIntensity, delta: round5(Number(newIntensity) - Number(existing.oldIntensity)) }
    : {
        entityId,
        emotionId,
        code,
        oldIntensity: Number(oldIntensity),
        newIntensity: Number(newIntensity),
        delta,
        simulationTime,
        causeEventId,
        causeActionId
      };

  pending.newIntensity = Number(newIntensity);
  pending.delta = round5(pending.newIntensity - Number(pending.oldIntensity));
  pending.simulationTime = simulationTime;
  pending.causeEventId = causeEventId || pending.causeEventId || null;
  pending.causeActionId = causeActionId || pending.causeActionId || null;
  pendingEmotionHistory.set(key, pending);

  if (!shouldPersistHistory({ delta: pending.delta, significant, threshold: EMOTION_HISTORY_MIN_DELTA })) return false;

  const matchCondition = pending.causeActionId
    ? `entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND cause_action_id=UUID_TO_BIN(?)`
    : pending.causeEventId
      ? `entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND cause_event_id=UUID_TO_BIN(?)`
      : null;
  const matchParams = pending.causeActionId
    ? [pending.entityId, pending.emotionId, pending.causeActionId]
    : pending.causeEventId
      ? [pending.entityId, pending.emotionId, pending.causeEventId]
      : [];

  if (matchCondition) {
    const [existingRows] = await pool.query(
      `SELECT BIN_TO_UUID(id) AS id,old_intensity AS oldIntensity
       FROM entity_emotion_history
       WHERE ${matchCondition}
       ORDER BY simulation_time ASC
       LIMIT 1`,
      matchParams
    );
    if (existingRows.length) {
      const existing = existingRows[0];
      const mergedDelta = round5(Number(pending.newIntensity) - Number(existing.oldIntensity));
      await pool.query(
        `UPDATE entity_emotion_history
         SET new_intensity=?,delta=?,simulation_time=?,cause_event_id=COALESCE(UUID_TO_BIN(?),cause_event_id)
         WHERE id=UUID_TO_BIN(?)`,
        [
          round5(pending.newIntensity),
          mergedDelta,
          pending.simulationTime,
          pending.causeEventId,
          existing.id
        ]
      );
      pendingEmotionHistory.delete(key);
      return true;
    }
  }

  await pool.query(
    `INSERT INTO entity_emotion_history
      (id,entity_id,emotion_id,old_intensity,new_intensity,delta,simulation_time,cause_event_id,cause_action_id)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))`,
    [
      uuid(),
      pending.entityId,
      pending.emotionId,
      round5(pending.oldIntensity),
      round5(pending.newIntensity),
      round5(pending.delta),
      pending.simulationTime,
      pending.causeEventId,
      pending.causeActionId
    ]
  );
  pendingEmotionHistory.delete(key);
  return true;
}

async function flushPendingNeedHistory(entityId, causeActionId) {
  if (!causeActionId) return 0;
  let count = 0;
  for (const pending of [...pendingNeedHistory.values()]) {
    if (String(pending.entityId) !== String(entityId) || String(pending.causeActionId || "") !== String(causeActionId)) continue;
    const persisted = await accumulateNeedHistory({ ...pending, significant: true });
    if (persisted) count += 1;
  }
  return count;
}

async function flushPendingEmotionHistory(entityId, causeActionId) {
  if (!causeActionId) return 0;
  let count = 0;
  for (const pending of [...pendingEmotionHistory.values()]) {
    if (String(pending.entityId) !== String(entityId) || String(pending.causeActionId || "") !== String(causeActionId)) continue;
    const persisted = await accumulateEmotionHistory({ ...pending, significant: true });
    if (persisted) count += 1;
  }
  return count;
}

async function persistNeedTransition({ entityId, needId, code, oldValue, nextValue, version, simulationTime, causeEventId = null, causeActionId = null, significant = false }) {
  const [updated] = await pool.query(
    `UPDATE entity_needs_current
     SET value=?,updated_simulation_at=?,version=version+1
     WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND version=?`,
    [nextValue, simulationTime, entityId, needId, version]
  );
  if (!updated.affectedRows) return null;
  await accumulateNeedHistory({
    entityId,
    needId,
    code,
    oldValue,
    newValue: nextValue,
    simulationTime,
    causeEventId,
    causeActionId,
    significant
  });
  return { old: oldValue, new: nextValue, delta: round5(nextValue - oldValue) };
}

const PRESSURE_NEEDS = new Set(["HUNGER", "THIRST", "SLEEPINESS", "SOCIAL_NEED", "FUN", "CURIOSITY", "ACHIEVEMENT", "BELONGING"]);
const ACTION_PRESSURE_FLOORS = { SLEEPING:{SLEEPINESS:0.02},TALKING:{SOCIAL_NEED:0.18,BELONGING:0.15},PLAYING:{FUN:0.18,SOCIAL_NEED:0.10},STUDYING:{ACHIEVEMENT:0.15,CURIOSITY:0.15},READING:{CURIOSITY:0.15,ACHIEVEMENT:0.12},EXPLORING:{CURIOSITY:0.15},WORKING:{ACHIEVEMENT:0.15},WALKING:{FUN:0.15,CURIOSITY:0.10},WATCHING:{FUN:0.15} };
const ACTION_NEED_GAINS={
  SLEEPING:{SLEEPINESS:-0.65,ENERGY:0.16,COMFORT:0.22,SAFETY:0.02},EATING:{HUNGER:-1.45,ENERGY:0.07,COMFORT:0.10,SAFETY:0.01},DRINKING:{THIRST:-2.15,ENERGY:0.04,SAFETY:0.01},
  TALKING:{SOCIAL_NEED:-0.45,BELONGING:-0.18},PLAYING:{FUN:-0.50,SOCIAL_NEED:-0.12,COMFORT:0.04},RESTING:{ENERGY:0.22,COMFORT:0.28,SLEEPINESS:-0.12},
  STUDYING:{ACHIEVEMENT:-0.80,CURIOSITY:-0.50,ENERGY:-0.15,FUN:-0.10,COMFORT:-0.03},READING:{CURIOSITY:-0.40,ACHIEVEMENT:-0.30,FUN:0.10,COMFORT:0.03},
  EXPLORING:{CURIOSITY:-1.20,FUN:-0.50,ENERGY:-0.15,COMFORT:-0.05,SAFETY:-0.02},WALKING:{FUN:-0.25,ENERGY:-0.08,COMFORT:0.02,SAFETY:0.01},
  WORKING:{ACHIEVEMENT:-0.70,ENERGY:-0.20,FUN:-0.10,COMFORT:-0.04,SAFETY:0.005},WATCHING:{FUN:-1.10,ENERGY:0.05,COMFORT:0.06,SAFETY:0.02},
  SCHOOL:{ACHIEVEMENT:-0.60,CURIOSITY:-0.40,ENERGY:-0.12,FUN:-0.05,COMFORT:-0.03,SAFETY:0.01}
};
const ACTION_DECAY_MULTIPLIERS={
  SLEEPING:{HUNGER:0.30,THIRST:0.28,SLEEPINESS:0.45,ENERGY:0.05,SOCIAL_NEED:0.75,FUN:0.70,CURIOSITY:0.65,ACHIEVEMENT:0.70,BELONGING:0.75},RESTING:{HUNGER:0.55,THIRST:0.50,SLEEPINESS:0.70,ENERGY:0.35,SOCIAL_NEED:0.80,FUN:0.80,CURIOSITY:0.75,ACHIEVEMENT:0.75,BELONGING:0.80},
  DRINKING:{HUNGER:0.85,THIRST:0.55,SLEEPINESS:0.85,ENERGY:0.80},EATING:{HUNGER:0.65,THIRST:0.75,SLEEPINESS:0.85,ENERGY:0.75},TALKING:{HUNGER:1.00,THIRST:1.00,ENERGY:1.00},PLAYING:{HUNGER:1.15,THIRST:1.20,ENERGY:1.35},STUDYING:{HUNGER:1.00,THIRST:1.00,ENERGY:1.20},
  READING:{HUNGER:0.95,THIRST:0.95,ENERGY:0.90},EXPLORING:{HUNGER:1.15,THIRST:1.20,ENERGY:1.40},WALKING:{HUNGER:1.05,THIRST:1.10,ENERGY:1.12},WORKING:{HUNGER:1.20,THIRST:1.25,ENERGY:1.45},WATCHING:{HUNGER:0.90,THIRST:0.90,ENERGY:0.65},SCHOOL:{HUNGER:1.00,THIRST:1.00,ENERGY:1.15}
};
const ACTION_EMOTION_EFFECTS={TALKING:{CALM:0.012,EXCITEMENT:0.008,ANXIETY:-0.008},PLAYING:{JOY:0.018,EXCITEMENT:0.025,CALM:0.004,FRUSTRATION:-0.015,SADNESS:-0.006},EATING:{JOY:0.008,CALM:0.012,FRUSTRATION:-0.012,ANXIETY:-0.006},DRINKING:{CALM:0.012,JOY:0.004,ANXIETY:-0.008},SLEEPING:{CALM:0.02,ANXIETY:-0.012,FRUSTRATION:-0.012},RESTING:{CALM:0.016,ANXIETY:-0.01,FRUSTRATION:-0.01},STUDYING:{EXCITEMENT:0.01,JOY:0.006,FRUSTRATION:0.006,CALM:0.006},READING:{JOY:0.008,CALM:0.01,EXCITEMENT:0.008},EXPLORING:{EXCITEMENT:0.035,JOY:0.012,FEAR:0.012,ANXIETY:0.008},WALKING:{CALM:0.016,JOY:0.006,ANXIETY:-0.008},WORKING:{FRUSTRATION:0.01},SCHOOL:{FRUSTRATION:0.006,EXCITEMENT:0.006,ANXIETY:0.003},WATCHING:{JOY:0.008,CALM:0.01,EXCITEMENT:0.01}};
const NEED_EMOTION_CURVES={HUNGER:{threshold:0.40,frustration:0.10,anger:0.055},THIRST:{threshold:0.40,frustration:0.15,anxiety:0.06},SLEEPINESS:{threshold:0.40,frustration:0.10,sadness:0.065},SOCIAL_NEED:{threshold:0.40,sadness:0.08,anxiety:0.045,frustration:0.055},BELONGING:{threshold:0.40,sadness:0.10,anxiety:0.06},FUN:{threshold:0.40,sadness:0.065,frustration:0.045},CURIOSITY:{threshold:0.40,excitement:0.075},ACHIEVEMENT:{threshold:0.40,frustration:0.07}};
const TRAIT_BEHAVIOR_LINKS={TALKING:{EXTRAVERSION:.60,SOCIABILITY:.70,EMPATHY:.25},EXPLORING:{OPENNESS:.55,CURIOSITY:.60,CONFIDENCE:.20},STUDYING:{CONSCIENTIOUSNESS:.60,DISCIPLINE:.70,PATIENCE:.25},WORKING:{CONSCIENTIOUSNESS:.55,DISCIPLINE:.55},PLAYING:{OPENNESS:.35,IMPULSIVITY:.25},READING:{OPENNESS:.35,CURIOSITY:.55},WALKING:{OPENNESS:.20},SLEEPING:{PATIENCE:.12,SELF_CARE:.15},RESTING:{PATIENCE:.12,SELF_CARE:.15},EATING:{SELF_CARE:.20},DRINKING:{SELF_CARE:.20},WATCHING:{OPENNESS:.12}};
function pressureCurve(value,threshold=0.4){const v=clamp(value);if(v<=threshold)return 0;const normalized=(v-threshold)/(1-threshold);return normalized*normalized;}
async function ensureEntityState(entityId,simulationTime){await Promise.all([pool.query(`INSERT IGNORE INTO entity_needs_current(entity_id,need_id,value,updated_simulation_at,version) SELECT UUID_TO_BIN(?),id,default_value,?,1 FROM need_definitions WHERE active=1`,[entityId,simulationTime]),pool.query(`INSERT IGNORE INTO entity_emotions_current(entity_id,emotion_id,intensity,updated_simulation_at,version) SELECT UUID_TO_BIN(?),id,default_value,?,1 FROM emotion_definitions WHERE active=1`,[entityId,simulationTime]),pool.query(`INSERT IGNORE INTO entity_traits_current(entity_id,trait_id,value,updated_simulation_at,version) SELECT UUID_TO_BIN(?),id,default_value,?,1 FROM trait_definitions WHERE active=1`,[entityId,simulationTime]),pool.query(`INSERT IGNORE INTO entity_skills(entity_id,skill_id,updated_simulation_at,version) SELECT UUID_TO_BIN(?),id,?,1 FROM skill_definitions WHERE active=1`,[entityId,simulationTime])]);}
async function readNeeds(entityId){const [rows]=await pool.query(`SELECT BIN_TO_UUID(enc.need_id) AS needId,nd.code,nd.name,enc.value,enc.version,nd.decay_rate AS decayRate,nd.recovery_rate AS recoveryRate,nd.priority_weight AS priorityWeight,nd.parameters FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1`,[entityId]);return rows;}
function actionDecayMultiplier(actionType,needCode){return Number(ACTION_DECAY_MULTIPLIERS[String(actionType||"").toUpperCase()]?.[needCode]??1);}
function saturatedActionDelta(actionType,needCode,currentValue,hours){const rate=Number((ACTION_NEED_GAINS[actionType]||{})[needCode]||0);if(!rate)return 0;const value=clamp(currentValue),amount=Math.abs(rate)*hours;if(rate<0)return-amount*value;return amount*(1-value);}
async function updateNeeds(entityId,simulationTime,deltaHours,causeEventId=null,causeActionId=null,activeActionType=null,historyContext=null){
  const rows=await readNeeds(entityId),changes=[],hours=Math.min(Math.max(Number(deltaHours)||0,0),6),action=String(activeActionType||"").toUpperCase(),significant=Boolean(historyContext?.significant);
  for(const r of rows){
    const decayRate=Math.max(0,Number(r.decayRate)||0),recoveryRate=Math.max(0,Number(r.recoveryRate)||0),multiplier=actionDecayMultiplier(action,r.code);
    let delta;
    if(PRESSURE_NEEDS.has(r.code))delta=decayRate*hours*multiplier;
    else if(r.code==="ENERGY")delta=-decayRate*hours*multiplier;
    else if(r.code==="SAFETY")delta=recoveryRate*0.25*hours;
    else if(r.code==="COMFORT")delta=(recoveryRate*0.15-decayRate*0.05)*hours;
    else delta=-decayRate*hours;
    if(action){
      const rawGain=saturatedActionDelta(action,r.code,r.value,hours),floor=ACTION_PRESSURE_FLOORS[action]?.[r.code];
      if(PRESSURE_NEEDS.has(r.code)&&rawGain<0&&floor!==undefined)delta+=Math.max(rawGain,-Math.max(0,Number(r.value)-floor));
      else if(PRESSURE_NEEDS.has(r.code)&&rawGain<0)delta+=Math.max(rawGain,-Number(r.value)*0.60);
      else delta+=rawGain;
    }
    const oldValue=round5(r.value);
    let next=round5(clamp(oldValue+delta));
    const floor=ACTION_PRESSURE_FLOORS[action]?.[r.code];
    if(PRESSURE_NEEDS.has(r.code)&&floor!==undefined&&action)next=Math.max(next,floor);
    const historyDelta=round5(next-oldValue);
    if(Math.abs(historyDelta)<0.000001)continue;
    const transition=await persistNeedTransition({
      entityId,
      needId:r.needId,
      code:r.code,
      oldValue,
      nextValue:next,
      version:r.version,
      simulationTime,
      causeEventId,
      causeActionId,
      significant
    });
    if(!transition)continue;
    changes.push({code:r.code,old:oldValue,new:next,delta:historyDelta});
  }
  if (significant && causeActionId) await flushPendingNeedHistory(entityId, causeActionId);
  return changes;
}
function traitValue(traits,code,fallback=.5){const row=(traits||[]).find(t=>String(t.code||"").toUpperCase()===code);return row?clamp(row.value):fallback;}
function emotionAppraisal(actionType,needs,context={}){const codes=["JOY","SADNESS","ANGER","FEAR","ANXIETY","FRUSTRATION","EXCITEMENT","CALM","DISGUST","SHAME"],deltas=Object.fromEntries(codes.map(c=>[c,0])),add=(c,v)=>{deltas[c]+=v;};const traits=context.traits||[],extraversion=traitValue(traits,"EXTRAVERSION"),sociability=traitValue(traits,"SOCIABILITY"),empathy=traitValue(traits,"EMPATHY"),openness=traitValue(traits,"OPENNESS"),neuroticism=traitValue(traits,"NEUROTICISM"),patience=traitValue(traits,"PATIENCE"),impulsivity=traitValue(traits,"IMPULSIVITY"),socialReactivity=.70+.65*((extraversion+sociability)/2),negativeSensitivity=.72+.62*neuroticism,patienceBuffer=.72+.45*patience;if(!context.event)for(const[c,v]of Object.entries(ACTION_EMOTION_EFFECTS[actionType]||{}))add(c,v);const p=Object.fromEntries((needs||[]).map(n=>[n.code,clamp(n.new??n.value)]));for(const[code,curve]of Object.entries(NEED_EMOTION_CURVES)){const pressure=pressureCurve(p[code]||0,curve.threshold);if(curve.frustration)add("FRUSTRATION",curve.frustration*pressure*negativeSensitivity);if(curve.anger)add("ANGER",curve.anger*pressure*(0.8+0.4*impulsivity));if(curve.sadness)add("SADNESS",curve.sadness*pressure*(1.1-neuroticism*.35));if(curve.anxiety)add("ANXIETY",curve.anxiety*pressure*negativeSensitivity);if(curve.excitement)add("EXCITEMENT",curve.excitement*pressure*(.75+openness*.5));}const physiologicalPressure=Math.max(p.HUNGER||0,p.THIRST||0,p.SLEEPINESS||0);if(physiologicalPressure>.55){const suppression=Math.min(1,(physiologicalPressure-.55)/.45);add("JOY",-.045*suppression);add("CALM",-.035*suppression);}const safety=p.SAFETY??1,energy=p.ENERGY??1;if(safety<0.45){add("FEAR",(0.45-safety)*.07*negativeSensitivity);add("ANXIETY",(0.45-safety)*.05*negativeSensitivity);}if(energy<0.3){add("FRUSTRATION",(.3-energy)*.05*negativeSensitivity);add("SADNESS",(.3-energy)*.03);}if(actionType==="TALKING"){add("EXCITEMENT",(socialReactivity-.7)*.018);if(context.targetEntityId){add("JOY",(socialReactivity-.7)*.016);add("CALM",empathy*.008);add("ANXIETY",(0.55-socialReactivity)*.02*negativeSensitivity);}}if(actionType==="EXPLORING")add("EXCITEMENT",openness*.018);if(actionType==="PLAYING")add("JOY",(0.75+openness*.35)*.012);if(context.event){const outcome=String(context.outcome||"SUCCESS").toUpperCase(),expected=String(context.expectedOutcome?.outcome||context.expectedOutcome?.status||context.expectedOutcome||"").toUpperCase(),mismatch=Boolean(expected&&expected!==outcome),impact=mismatch?1.35:1,relief=Math.min(1,(needs||[]).filter(change=>Number(change.delta??0)<0).reduce((sum,change)=>sum+Math.abs(Number(change.delta||0)),0)/.8);if(outcome==="SUCCESS"){if(relief>=.25){const meaningfulRelief=Math.min(1,Math.max(0,(relief-.15)/.85));add("JOY",.035*meaningfulRelief*impact);add("CALM",.022*meaningfulRelief);}if(context.meaning==="GOAL_PROGRESS"){add("JOY",.018);add("CALM",.008);}if(context.targetEntityId){add("JOY",.008*socialReactivity);add("CALM",.004+empathy*.004);}}else if(outcome==="PARTIAL"){add("FRUSTRATION",.06*impact*negativeSensitivity);add("ANXIETY",.022*impact*negativeSensitivity);add("SADNESS",.016*impact);}else{add("FRUSTRATION",.10*impact*negativeSensitivity);add("ANXIETY",.055*impact*negativeSensitivity);add("SADNESS",.035*impact*(1.1-neuroticism*.25));add("ANGER",.025*impact*(.85+impulsivity*.35));if(context.failureReason==="RESOURCE_UNAVAILABLE")add("DISGUST",.012*negativeSensitivity);}if(context.targetEntityId&&outcome==="FAILURE"){add("ANXIETY",.03*negativeSensitivity);add("SADNESS",.025);}if(context.meaning==="GOAL_BLOCKED"){add("FRUSTRATION",.04*negativeSensitivity*(1-patience*.25));add("ANXIETY",.02*negativeSensitivity);}}return deltas;}
async function applyEmotions(entityId,simulationTime,changes,causeEventId=null,causeActionId=null,actionType=null,deltaHours=0,appraisalContext=null){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(eec.emotion_id) AS emotionId,ed.code,eec.intensity,eec.version,ed.decay_rate AS decayRate,ed.default_value AS defaultValue FROM entity_emotions_current eec JOIN emotion_definitions ed ON ed.id=eec.emotion_id WHERE eec.entity_id=UUID_TO_BIN(?) AND ed.active=1`,[entityId]);
  const traits=appraisalContext?.traits||await getTraits(entityId),hours=Math.min(Math.max(Number(deltaHours)||0,0),6),appraisal=emotionAppraisal(actionType,changes,{...(appraisalContext||{}),deltaHours:hours,traits}),result=[],significant=Boolean(appraisalContext?.significant||appraisalContext?.event);
  for(const row of rows){
    const oldIntensity=round5(row.intensity),baseline=clamp(row.defaultValue),decayCoefficient=Math.max(0,Number(row.decayRate)||0)*0.5,relaxation=hours>0?1-Math.exp(-decayCoefficient*hours):0,eventHomeostasis=appraisalContext?.event?0.10:0,passiveDecay=(baseline-oldIntensity)*Math.max(relaxation,eventHomeostasis),rawAppraisal=Number(appraisal[row.code]||0),positiveEmotion=new Set(["JOY","CALM","EXCITEMENT"]).has(row.code),stimulusScale=appraisalContext?.event?(positiveEmotion?Math.max(.06,1-.90*oldIntensity):Math.max(.35,1-.25*oldIntensity)):hours,next=round5(clamp(oldIntensity+passiveDecay+rawAppraisal*stimulusScale)),historyDelta=round5(next-oldIntensity);
    if(Math.abs(historyDelta)<0.000001)continue;
    const[updated]=await pool.query(`UPDATE entity_emotions_current SET intensity=?,updated_simulation_at=?,version=version+1 WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,entityId,row.emotionId,row.version||1]);
    if(!updated.affectedRows)continue;
    await accumulateEmotionHistory({
      entityId,
      emotionId:row.emotionId,
      code:row.code,
      oldIntensity,
      newIntensity:next,
      simulationTime,
      causeEventId,
      causeActionId,
      significant
    });
    result.push({code:row.code,old:oldIntensity,new:next,delta:historyDelta});
  }
  if (significant && causeActionId) await flushPendingEmotionHistory(entityId, causeActionId);
  return result;
}
async function getTraits(entityId){const [rows]=await pool.query(`SELECT BIN_TO_UUID(etc.trait_id) AS traitId,td.code,etc.value,etc.version,td.volatility FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,[entityId]);return rows;}
function traitBehaviorWeights(actionType){return {...(TRAIT_BEHAVIOR_LINKS[String(actionType||"").toUpperCase()]||{})};}
async function developTraits(entityId,simulationTime,evidence={},causeEventId=null,causeActionId=null){const traits=await getTraits(entityId),out=[];if(!causeActionId)return out;const actionType=String(evidence?.actionType||"").toUpperCase(),targetEntityId=evidence?.targetEntityId||null;if(actionType!=="TALKING"||!targetEntityId)return out;const [actionRows]=await pool.query(`SELECT action_type AS actionType,result,started_simulation_at AS startedAt,completed_simulation_at AS completedAt,decision_id AS decisionId FROM actions WHERE entity_id=UUID_TO_BIN(?) AND status='COMPLETED' ORDER BY completed_simulation_at DESC LIMIT 32`,[entityId]),parsedRows=actionRows.map(row=>({...row,result:parseJson(row.result,{})||{}})),same=parsedRows.filter(row=>String(row.actionType||"").toUpperCase()==="TALKING"&&row.result?.targetEntityId&&String(row.result.targetEntityId)===String(targetEntityId)).slice(0,12);if(same.length<3)return out;const outcomes=same.map(row=>String(row.result?.outcome||"SUCCESS").toUpperCase()),successRate=outcomes.filter(v=>v==="SUCCESS").length/outcomes.length,failureRate=outcomes.filter(v=>v==="FAILURE").length/outcomes.length,partialRate=outcomes.filter(v=>v==="PARTIAL").length/outcomes.length,outcomeValence=successRate-failureRate-partialRate*.25,repetition=Math.min(1,same.length/8),[relationshipRows]=await pool.query(`SELECT AVG(COALESCE(familiarity_score,0)) AS familiarity,AVG(COALESCE(closeness_score,0)) AS closeness,AVG(COALESCE(affection_score,0)) AS affection,AVG(COALESCE(trust_score,0)) AS trust,AVG(COALESCE(conflict_score,0)) AS conflict FROM relationships WHERE simulation_id=(SELECT simulation_id FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1) AND status='ACTIVE' AND ((source_entity_id=UUID_TO_BIN(?) AND target_entity_id=UUID_TO_BIN(?)) OR (source_entity_id=UUID_TO_BIN(?) AND target_entity_id=UUID_TO_BIN(?)))`,[entityId,entityId,targetEntityId,targetEntityId,entityId]),relation=relationshipRows[0]||{},relationshipQuality=clamp((Number(relation.familiarity||0)+Number(relation.closeness||0)+Number(relation.affection||0)+Number(relation.trust||0)-Number(relation.conflict||0))/.4,.5),evidenceStrength=Math.max(-1,Math.min(1,.55*outcomeValence+.45*(relationshipQuality-.5)*2)),[entityRows]=await pool.query(`SELECT attributes FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`,[entityId]),attributes=parseJson(entityRows[0]?.attributes,{})||{},mentalState=attributes.mentalState&&typeof attributes.mentalState==='object'?attributes.mentalState:{},certainty=clamp(mentalState.certainty??.5),rumination=clamp(mentalState.rumination??.1),selfPerception=clamp(.75+(certainty-.5)*.35-rumination*.10,.55,1.05),weights={EXTRAVERSION:.55,SOCIABILITY:.75,EMPATHY:.65,CONFIDENCE:.25,AGREEABLENESS:.35};for(const trait of traits){const behaviorWeight=Number(weights[trait.code]||0);if(!behaviorWeight)continue;const confidenceFactor=Math.max(.6,1-Number(trait.volatility||.5)*.12),delta=Math.max(-.0035,Math.min(.0035,behaviorWeight*evidenceStrength*repetition*selfPerception*.0012*confidenceFactor));if(Math.abs(delta)<.000001)continue;const old=round5(trait.value),next=round5(clamp(old+delta)),historyDelta=round5(next-old);if(Math.abs(historyDelta)<.000001)continue;const[updated]=await pool.query(`UPDATE entity_traits_current SET value=?,updated_simulation_at=?,version=version+1 WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,entityId,trait.traitId,trait.version]);if(!updated.affectedRows)continue;await pool.query(`INSERT INTO entity_trait_history(id,entity_id,trait_id,old_value,new_value,delta,changed_simulation_at,cause_event_id,cause_action_id,change_reason) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),?)`,[uuid(),entityId,trait.traitId,old,next,historyDelta,simulationTime,causeEventId,causeActionId,`interpersonal evidence with target ${targetEntityId}: outcome=${outcomeValence.toFixed(2)}, relationship=${relationshipQuality.toFixed(2)}, repetition=${same.length}`]);out.push({code:trait.code,old,next,delta:historyDelta,evidence:{actionType,targetEntityId,successRate,failureRate,partialRate,repetition,relationshipQuality,evidenceStrength,selfPerception}});}return out;}
module.exports={ensureEntityState,readNeeds,updateNeeds,applyEmotions,getTraits,developTraits,emotionAppraisal,traitBehaviorWeights,persistNeedTransition,accumulateNeedHistory,accumulateEmotionHistory,flushPendingNeedHistory,flushPendingEmotionHistory};
