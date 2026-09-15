const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { clamp } = require("./state-rules");

function round5(value) { return Math.round((Number(value) + Number.EPSILON) * 100000) / 100000; }

const PRESSURE_NEEDS = new Set(["HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN","CURIOSITY","ACHIEVEMENT","BELONGING"]);

async function ensureEntityState(entityId, simulationTime) {
  const [[needDefs],[emotionDefs],[traitDefs],[skillDefs]] = await Promise.all([
    pool.query("SELECT id,default_value FROM need_definitions WHERE active=1"),
    pool.query("SELECT id,default_value FROM emotion_definitions WHERE active=1"),
    pool.query("SELECT id,default_value FROM trait_definitions WHERE active=1"),
    pool.query("SELECT id FROM skill_definitions WHERE active=1")
  ]);
  for (const d of needDefs) {
    await pool.query(`INSERT IGNORE INTO entity_needs_current(entity_id,need_id,value,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)`, [entityId,d.id,d.default_value,simulationTime]);
  }
  for (const d of emotionDefs) {
    await pool.query(`INSERT IGNORE INTO entity_emotions_current(entity_id,emotion_id,intensity,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)`, [entityId,d.id,d.default_value,simulationTime]);
    await pool.query(`UPDATE entity_emotions_current SET intensity=?,updated_simulation_at=?
      WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=1 AND intensity=0`,
      [d.default_value,simulationTime,entityId,d.id]);
  }
  for (const d of traitDefs) {
    await pool.query(`INSERT IGNORE INTO entity_traits_current(entity_id,trait_id,value,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)`, [entityId,d.id,0.5,simulationTime]);
  }
  for (const d of skillDefs) {
    await pool.query(`INSERT IGNORE INTO entity_skills(entity_id,skill_id,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?, ?,1)`, [entityId,d.id,simulationTime]);
  }
}

async function readNeeds(entityId) {
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(enc.need_id) AS needId,nd.code,nd.name,enc.value,
    nd.decay_rate AS decayRate,nd.recovery_rate AS recoveryRate,nd.priority_weight AS priorityWeight,nd.parameters
    FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id
    WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1`, [entityId]);
  return rows;
}

async function updateNeeds(entityId,simulationTime,deltaHours,causeEventId=null,causeActionId=null,activeActionType=null) {
  const rows=await readNeeds(entityId); const changes=[];
  const actionHours=Math.min(Math.max(Number(deltaHours)||0,0),0.25);
  const gains={
    SLEEPING:{SLEEPINESS:-1.8,ENERGY:0.9,COMFORT:0.35,SAFETY:0.08},
    EATING:{HUNGER:-2.4,ENERGY:0.1,COMFORT:0.15,SAFETY:0.03},
    DRINKING:{THIRST:-3,ENERGY:0.1,SAFETY:0.02},
    TALKING:{SOCIAL_NEED:-0.45,BELONGING:-0.18},
    PLAYING:{FUN:-0.5,SOCIAL_NEED:-0.12,COMFORT:0.04},
    RESTING:{ENERGY:0.6,COMFORT:0.5,SLEEPINESS:-0.2,SAFETY:0.06},
    STUDYING:{ACHIEVEMENT:-0.8,CURIOSITY:-0.5,ENERGY:-0.15,FUN:-0.1,COMFORT:-0.03},
    READING:{CURIOSITY:-0.4,ACHIEVEMENT:-0.3,FUN:0.1,COMFORT:0.03},
    EXPLORING:{CURIOSITY:-1.2,FUN:-0.5,ENERGY:-0.15,COMFORT:-0.05,SAFETY:-0.02},
    WALKING:{FUN:-0.25,ENERGY:-0.08,COMFORT:0.02,SAFETY:0.01},
    WORKING:{ACHIEVEMENT:-0.7,ENERGY:-0.2,FUN:-0.1,COMFORT:-0.04,SAFETY:0.005},
    WATCHING:{FUN:-1.1,ENERGY:0.05,COMFORT:0.06,SAFETY:0.02},
    SCHOOL:{ACHIEVEMENT:-0.6,CURIOSITY:-0.4,ENERGY:-0.12,FUN:-0.05,COMFORT:-0.03,SAFETY:0.01}
  };
  for(const r of rows){
    const decayRate=Math.max(0,Number(r.decayRate)||0), recoveryRate=Math.max(0,Number(r.recoveryRate)||0);
    let delta;
    if(PRESSURE_NEEDS.has(r.code)) delta=decayRate*Number(deltaHours||0);
    else if(r.code==="SAFETY") delta=recoveryRate*0.25*Number(deltaHours||0);
    else if(r.code==="COMFORT") delta=(recoveryRate*0.15-decayRate*0.05)*Number(deltaHours||0);
    else delta=-decayRate*Number(deltaHours||0);

    if(activeActionType){
      const gain=(gains[activeActionType]||{})[r.code]||0;
      const rawGain=gain*actionHours;
      // Satisfaction effects cannot erase a pressure completely in one action.
      // This prevents SOCIAL_NEED and BELONGING from getting permanently pinned at 0.
      if(PRESSURE_NEEDS.has(r.code) && rawGain<0) delta+=Math.max(rawGain,-Number(r.value)*0.35);
      else delta+=rawGain;
    }

    const oldValue=round5(r.value), next=round5(clamp(oldValue+delta)), historyDelta=round5(next-oldValue);
    if(Math.abs(historyDelta)<0.000001) continue;
    const [current]=await pool.query(`SELECT version FROM entity_needs_current WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) LIMIT 1`,[entityId,r.needId]);
    if(!current.length) continue;
    const expectedVersion=current[0].version;
    const [updated]=await pool.query(`UPDATE entity_needs_current SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,entityId,r.needId,expectedVersion]);
    if(!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on need"),{code:"OPTIMISTIC_LOCK"});
    await pool.query(`INSERT INTO entity_need_history(id,entity_id,need_id,old_value,new_value,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))`,
      [uuid(),entityId,r.needId,oldValue,next,historyDelta,simulationTime,causeEventId,causeActionId]);
    changes.push({code:r.code,old:oldValue,new:next,delta:historyDelta});
  }
  return changes;
}

function emotionAppraisal(actionType,needs){
  const codes=["JOY","SADNESS","ANGER","FEAR","ANXIETY","FRUSTRATION","EXCITEMENT","CALM","DISGUST","SHAME"];
  const deltas=Object.fromEntries(codes.map(code=>[code,0]));
  const add=(code,value)=>{deltas[code]+=value;};
  const actionEffects={
    TALKING:{JOY:0.035,CALM:0.02,EXCITEMENT:0.012,ANXIETY:-0.008,SADNESS:-0.008},
    PLAYING:{JOY:0.045,EXCITEMENT:0.035,CALM:0.008,FRUSTRATION:-0.02,SADNESS:-0.01},
    EATING:{JOY:0.02,CALM:0.025,FRUSTRATION:-0.02,ANXIETY:-0.01},
    DRINKING:{CALM:0.025,JOY:0.012,ANXIETY:-0.012},
    SLEEPING:{CALM:0.04,JOY:0.015,ANXIETY:-0.02,FRUSTRATION:-0.02},
    RESTING:{CALM:0.03,JOY:0.012,ANXIETY:-0.015,FRUSTRATION:-0.015},
    STUDYING:{EXCITEMENT:0.012,JOY:0.012,FRUSTRATION:0.008,CALM:0.008},
    READING:{JOY:0.018,CALM:0.018,EXCITEMENT:0.01},
    EXPLORING:{EXCITEMENT:0.05,JOY:0.025,FEAR:0.018,ANXIETY:0.01},
    WALKING:{CALM:0.025,JOY:0.012,ANXIETY:-0.01},
    WORKING:{FRUSTRATION:0.012},
    SCHOOL:{FRUSTRATION:0.008,EXCITEMENT:0.008,ANXIETY:0.004},
    WATCHING:{JOY:0.022,CALM:0.015,EXCITEMENT:0.018}
  };
  for(const [code,value] of Object.entries(actionEffects[actionType]||{})) add(code,value);
  const pressure=Object.fromEntries(needs.map(n=>[n.code,clamp(n.new)]));
  const social=pressure.SOCIAL_NEED||0, belonging=pressure.BELONGING||0, hunger=pressure.HUNGER||0, thirst=pressure.THIRST||0;
  const sleepiness=pressure.SLEEPINESS||0, fun=pressure.FUN||0, achievement=pressure.ACHIEVEMENT||0, curiosity=pressure.CURIOSITY||0;
  const safety=pressure.SAFETY??1, energy=pressure.ENERGY??1;
  if(social>0.65){add("SADNESS",social*0.012);add("ANXIETY",social*0.008);add("FRUSTRATION",social*0.01);}
  if(belonging>0.65){add("SADNESS",belonging*0.015);add("ANXIETY",belonging*0.01);}
  if(hunger>0.7){add("FRUSTRATION",hunger*0.018);add("ANGER",hunger*0.01);}
  if(thirst>0.7){add("FRUSTRATION",thirst*0.02);add("ANXIETY",thirst*0.008);}
  if(sleepiness>0.7){add("FRUSTRATION",sleepiness*0.012);add("SADNESS",sleepiness*0.008);}
  if(fun>0.75){add("SADNESS",fun*0.01);add("FRUSTRATION",fun*0.008);}
  if(achievement>0.75) add("FRUSTRATION",achievement*0.01);
  if(curiosity>0.75) add("EXCITEMENT",curiosity*0.012);
  if(safety<0.45){add("FEAR",(0.45-safety)*0.06);add("ANXIETY",(0.45-safety)*0.04);}
  if(energy<0.3){add("FRUSTRATION",(0.3-energy)*0.04);add("SADNESS",(0.3-energy)*0.025);}
  return deltas;
}

async function applyEmotions(entityId,simulationTime,changes,causeEventId=null,causeActionId=null,actionType=null){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(eec.emotion_id) AS emotionId,ed.code,eec.intensity,eec.version,ed.decay_rate AS decayRate
    FROM entity_emotions_current eec JOIN emotion_definitions ed ON ed.id=eec.emotion_id
    WHERE eec.entity_id=UUID_TO_BIN(?) AND ed.active=1`,[entityId]);
  const appraisal=emotionAppraisal(actionType,changes), result=[];
  for(const row of rows){
    const oldIntensity=round5(row.intensity);
    const passiveDecay=-Math.max(0,Number(row.decayRate)||0)*0.02;
    const delta=passiveDecay+Number(appraisal[row.code]||0);
    const next=round5(clamp(oldIntensity+delta)), historyDelta=round5(next-oldIntensity);
    if(Math.abs(historyDelta)<0.000001) continue;
    const [updated]=await pool.query(`UPDATE entity_emotions_current SET intensity=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,entityId,row.emotionId,row.version||1]);
    if(!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on emotion"),{code:"OPTIMISTIC_LOCK"});
    await pool.query(`INSERT INTO entity_emotion_history(id,entity_id,emotion_id,old_intensity,new_intensity,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))`,
      [uuid(),entityId,row.emotionId,oldIntensity,next,historyDelta,simulationTime,causeEventId,causeActionId]);
    result.push({code:row.code,old:oldIntensity,new:next,delta:historyDelta});
  }
  return result;
}

async function getTraits(entityId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(etc.trait_id) AS traitId,td.code,etc.value,etc.version,
    td.volatility,td.development_weight AS developmentWeight FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id
    WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,[entityId]);
  return rows;
}

async function developTraits(entityId,simulationTime,signals,causeEventId=null,causeActionId=null){
  const traits=await getTraits(entityId), out=[];
  for(const t of traits){
    const signal=Number(signals[t.code]||0), delta=Math.max(-0.01,Math.min(0.01,signal*Number(t.developmentWeight)*0.001));
    if(Math.abs(delta)<0.000001) continue;
    const old=round5(t.value),next=round5(clamp(old+delta)),historyDelta=round5(next-old);
    const [r]=await pool.query(`UPDATE entity_traits_current SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?) AND version=?`,[next,simulationTime,entityId,t.traitId,t.version]);
    if(!r.affectedRows) continue;
    await pool.query(`INSERT INTO entity_trait_history(id,entity_id,trait_id,old_value,new_value,delta,changed_simulation_at,cause_event_id,cause_action_id,change_reason)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),?)`,
      [uuid(),entityId,t.traitId,old,next,historyDelta,simulationTime,causeEventId,causeActionId,"behavioral reinforcement"]);
    out.push({code:t.code,old,next,delta:historyDelta});
  }
  return out;
}

module.exports={ensureEntityState,readNeeds,updateNeeds,applyEmotions,getTraits,developTraits,clamp};
