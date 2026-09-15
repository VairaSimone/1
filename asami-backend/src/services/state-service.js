const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { clamp } = require("./state-rules");



async function ensureEntityState(entityId, simulationTime) {
  const [[needDefs],[emotionDefs],[traitDefs],[skillDefs]] = await Promise.all([
    pool.query("SELECT id,default_value FROM need_definitions WHERE active=1"),
    pool.query("SELECT id,default_value FROM emotion_definitions WHERE active=1"),
    pool.query("SELECT id,default_value FROM trait_definitions WHERE active=1"),
    pool.query("SELECT id FROM skill_definitions WHERE active=1")
  ]);
  for (const d of needDefs) {
    await pool.query(`
      INSERT IGNORE INTO entity_needs_current(entity_id,need_id,value,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)
    `,[entityId, d.id, d.default_value, simulationTime]);
    }
  for (const d of emotionDefs) {
    await pool.query(`
      INSERT IGNORE INTO entity_emotions_current(entity_id,emotion_id,intensity,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)
    `,[entityId, d.id, d.default_value, simulationTime]);
  }
  for (const d of traitDefs) {
    await pool.query(`
      INSERT IGNORE INTO entity_traits_current(entity_id,trait_id,value,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),?,?,?,1)
    `,[entityId, d.id, d.default_value, simulationTime]);
  }
for (const d of skillDefs) {
  await pool.query(`
    INSERT IGNORE INTO entity_skills(entity_id,skill_id,updated_simulation_at,version)
    VALUES(UUID_TO_BIN(?),?, ?,1)
  `, [entityId, d.id, simulationTime]);
}
}

async function readNeeds(entityId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(enc.need_id) AS needId, nd.code, nd.name, enc.value,
           nd.decay_rate AS decayRate, nd.recovery_rate AS recoveryRate,
           nd.priority_weight AS priorityWeight, nd.parameters
    FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id
    WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1
  `,[entityId]);
  return rows;
}

async function updateNeeds(entityId, simulationTime, deltaHours, causeEventId=null, causeActionId=null, activeActionType=null) {
  const rows = await readNeeds(entityId);
  const changes=[];
  for (const r of rows) {
    let delta = -Number(r.decayRate) * deltaHours;
    if (activeActionType) {
      const gains = {
        SLEEPING: { SLEEPINESS: -1.8, ENERGY: 0.9, COMFORT: 0.1 },
        EATING: { HUNGER: 2.4, ENERGY: 0.1, COMFORT: 0.05 },
        DRINKING: { THIRST: 3.0, ENERGY: 0.1 },
        TALKING: { SOCIAL_NEED: 2.0, BELONGING: 1.2 },
        PLAYING: { FUN: 2.0, SOCIAL_NEED: 0.4 },
        RESTING: { ENERGY: 0.6, COMFORT: 0.4, SLEEPINESS: -0.2 },
        STUDYING: { ACHIEVEMENT: 0.8, CURIOSITY: 0.5, ENERGY: -0.15, FUN: -0.1 },
        READING: { CURIOSITY: 0.4, ACHIEVEMENT: 0.3, FUN: 0.1 },
        EXPLORING: { CURIOSITY: 1.2, FUN: 0.5, ENERGY: -0.15 },
        WALKING: { FUN: 0.25, ENERGY: -0.08 },
        WORKING: { ACHIEVEMENT: 0.7, ENERGY: -0.2, FUN: -0.1 },
        WATCHING: { FUN: 1.1, ENERGY: 0.05 },
        SCHOOL: { ACHIEVEMENT: 0.6, CURIOSITY: 0.4, ENERGY: -0.12, FUN: -0.05 }
      };
      const gain = (gains[activeActionType] || {})[r.code] || 0;
      delta += gain * deltaHours;
    }
    const next = clamp(Number(r.value) + delta);
    if (Math.abs(next - Number(r.value)) < 0.000001) continue;
    const [current] = await pool.query(`
      SELECT version FROM entity_needs_current
      WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) LIMIT 1
    `,[entityId,r.needId]);
    if (!current.length) continue;
    const expectedVersion=current[0].version;
    const [updated] = await pool.query(`
      UPDATE entity_needs_current
      SET value=?, updated_simulation_at=?, version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND version=?
    `,[next,simulationTime,entityId,r.needId,expectedVersion]);
    if (!updated.affectedRows) throw Object.assign(new Error("Optimistic lock conflict on need"),{code:"OPTIMISTIC_LOCK"});
    await pool.query(`
      INSERT INTO entity_need_history
        (id,entity_id,need_id,old_value,new_value,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))
    `,[uuid(),entityId,r.needId,r.value,next,next-Number(r.value),simulationTime,causeEventId,causeActionId]);
    changes.push({ code:r.code, old:Number(r.value), new:next, delta:next-Number(r.value) });
  }
  return changes;
}

async function applyEmotions(entityId, simulationTime, changes, causeEventId=null, causeActionId=null) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(eec.emotion_id) AS emotionId, ed.code, eec.intensity, eec.version, ed.decay_rate AS decayRate
    FROM entity_emotions_current eec JOIN emotion_definitions ed ON ed.id=eec.emotion_id
    WHERE eec.entity_id=UUID_TO_BIN(?) AND ed.active=1
  `,[entityId]);
  const map = new Map(changes.map(c => [c.code, c.delta]));
  const result=[];
  for (const row of rows) {
    let delta = -Number(row.decayRate) * 0.001;
    if (map.has("HUNGER")) delta += Math.max(0,map.get("HUNGER")) * -0.6;
    if (map.has("FUN")) delta += map.get("FUN") * 0.5;
    if (map.has("SOCIAL_NEED")) delta += map.get("SOCIAL_NEED") * 0.4;
    if (map.has("SAFETY")) delta += map.get("SAFETY") * -0.5;
    if (row.code === "CALM" && map.get("ENERGY") > 0) delta += 0.01;
    const next=clamp(Number(row.intensity)+delta);
    if (Math.abs(next-Number(row.intensity))<0.000001) continue;
    await pool.query(`
      UPDATE entity_emotions_current SET intensity=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=?
    `,[next,simulationTime,entityId,row.emotionId,row.version || 1]);
    await pool.query(`
      INSERT INTO entity_emotion_history
        (id,entity_id,emotion_id,old_intensity,new_intensity,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))
    `,[uuid(),entityId,row.emotionId,row.intensity,next,next-Number(row.intensity),simulationTime,causeEventId,causeActionId]);
    result.push({code:row.code,old:Number(row.intensity),new:next,delta:next-Number(row.intensity)});
  }
  return result;
}

async function getTraits(entityId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(etc.trait_id) AS traitId, td.code, etc.value,
           td.volatility, td.development_weight AS developmentWeight
    FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id
    WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
  `,[entityId]);
  return rows;
}

async function developTraits(entityId, simulationTime, signals, causeEventId=null, causeActionId=null) {
  const traits=await getTraits(entityId);
  const out=[];
  for (const t of traits) {
    const signal=Number(signals[t.code] || 0);
    const delta=Math.max(-0.01,Math.min(0.01,signal * Number(t.developmentWeight) * 0.001));
    if (Math.abs(delta)<0.000001) continue;
    const old=Number(t.value), next=clamp(old+delta);
    const [r]=await pool.query(`
      UPDATE entity_traits_current SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?) AND version=?
    `,[next,simulationTime,entityId,t.traitId,t.version]);
    if (!r.affectedRows) continue;
    await pool.query(`
      INSERT INTO entity_trait_history
        (id,entity_id,trait_id,old_value,new_value,delta,changed_simulation_at,cause_event_id,cause_action_id,change_reason)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[uuid(),entityId,t.traitId,old,next,delta,simulationTime,causeEventId,causeActionId,"behavioral reinforcement"]);
    out.push({code:t.code,old,next,delta});
  }
  return out;
}

module.exports={ensureEntityState,readNeeds,updateNeeds,applyEmotions,getTraits,developTraits,clamp};
