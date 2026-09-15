const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { clamp } = require("./state-rules");

function round5(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100000) / 100000;
}

const PRESSURE_NEEDS = new Set([
  "HUNGER",
  "THIRST",
  "SLEEPINESS",
  "SOCIAL_NEED",
  "FUN",
  "CURIOSITY",
  "ACHIEVEMENT",
  "BELONGING"
]);

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
    `,[entityId, d.id, simulationTime]);
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

  // An autonomous action is instantaneous in the current engine. Never apply a
  // full multi-hour simulation jump as though the action lasted that entire time.
  const actionHours = Math.min(Math.max(Number(deltaHours) || 0, 0), 0.25);

  const gains = {
    SLEEPING: {
      SLEEPINESS: -1.8,
      ENERGY: 0.9,
      COMFORT: 0.35,
      SAFETY: 0.08
    },
    EATING: {
      HUNGER: -2.4,
      ENERGY: 0.1,
      COMFORT: 0.15,
      SAFETY: 0.03
    },
    DRINKING: {
      THIRST: -3.0,
      ENERGY: 0.1,
      SAFETY: 0.02
    },
    TALKING: {
      SOCIAL_NEED: -0.45,
      BELONGING: -0.18
    },
    PLAYING: {
      FUN: -0.5,
      SOCIAL_NEED: -0.12,
      COMFORT: 0.04
    },
    RESTING: {
      ENERGY: 0.6,
      COMFORT: 0.5,
      SLEEPINESS: -0.2,
      SAFETY: 0.06
    },
    STUDYING: {
      ACHIEVEMENT: -0.8,
      CURIOSITY: -0.5,
      ENERGY: -0.15,
      FUN: -0.1,
      COMFORT: -0.03
    },
    READING: {
      CURIOSITY: -0.4,
      ACHIEVEMENT: -0.3,
      FUN: 0.1,
      COMFORT: 0.03
    },
    EXPLORING: {
      CURIOSITY: -1.2,
      FUN: -0.5,
      ENERGY: -0.15,
      COMFORT: -0.05,
      SAFETY: -0.02
    },
    WALKING: {
      FUN: -0.25,
      ENERGY: -0.08,
      COMFORT: 0.02,
      SAFETY: 0.01
    },
    WORKING: {
      ACHIEVEMENT: -0.7,
      ENERGY: -0.2,
      FUN: -0.1,
      COMFORT: -0.04,
      SAFETY: 0.005
    },
    WATCHING: {
      FUN: -1.1,
      ENERGY: 0.05,
      COMFORT: 0.06,
      SAFETY: 0.02
    },
    SCHOOL: {
      ACHIEVEMENT: -0.6,
      CURIOSITY: -0.4,
      ENERGY: -0.12,
      FUN: -0.05,
      COMFORT: -0.03,
      SAFETY: 0.01
    }
  };

  for (const r of rows) {
    const decayRate = Math.max(0, Number(r.decayRate) || 0);
    const recoveryRate = Math.max(0, Number(r.recoveryRate) || 0);

    let delta;
    if (PRESSURE_NEEDS.has(r.code)) {
      // Pressure rises with time until an action satisfies it.
      delta = decayRate * Number(deltaHours || 0);
    } else if (r.code === "SAFETY") {
      // Safety represents a positive resource. It does not evaporate just because
      // time passes; it is restored slowly in a normal/safe environment and can
      // later be explicitly reduced by danger events.
      delta = recoveryRate * 0.25 * Number(deltaHours || 0);
    } else if (r.code === "COMFORT") {
      // Comfort should remain reasonably stable instead of inevitably reaching 0.
      // Give it a small passive recovery while keeping the actual action effects.
      delta = (recoveryRate * 0.15 - decayRate * 0.05) * Number(deltaHours || 0);
    } else {
      // Energy and other resource-like needs deplete over time.
      delta = -decayRate * Number(deltaHours || 0);
    }

    if (activeActionType) {
      const gain = (gains[activeActionType] || {})[r.code] || 0;
      delta += gain * actionHours;
    }

    const oldValue = round5(r.value);
    const next = round5(clamp(oldValue + delta));
    const historyDelta = round5(next - oldValue);
    if (Math.abs(historyDelta) < 0.000001) continue;
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
    `,[uuid(),entityId,r.needId,oldValue,next,historyDelta,simulationTime,causeEventId,causeActionId]);
    changes.push({ code:r.code, old:oldValue, new:next, delta:historyDelta });
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
    const oldIntensity = round5(row.intensity);
    const next = round5(clamp(oldIntensity + delta));
    const historyDelta = round5(next - oldIntensity);
    if (Math.abs(historyDelta)<0.000001) continue;
    const [updated] = await pool.query(`
      UPDATE entity_emotions_current SET intensity=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=?
    `,[next,simulationTime,entityId,row.emotionId,row.version || 1]);
    if (!updated.affectedRows) {
      throw Object.assign(new Error("Optimistic lock conflict on emotion"), { code: "OPTIMISTIC_LOCK" });
    }
    await pool.query(`
      INSERT INTO entity_emotion_history
        (id,entity_id,emotion_id,old_intensity,new_intensity,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))
    `,[uuid(),entityId,row.emotionId,oldIntensity,next,historyDelta,simulationTime,causeEventId,causeActionId]);
    result.push({code:row.code,old:oldIntensity,new:next,delta:historyDelta});
  }
  return result;
}

async function getTraits(entityId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(etc.trait_id) AS traitId, td.code, etc.value, etc.version,
           td.volatility, td.development_weight AS developmentWeight
    FROM entity_traits_current etc
    JOIN trait_definitions td ON td.id = etc.trait_id
    WHERE etc.entity_id = UUID_TO_BIN(?) AND td.active = 1
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
    const old=round5(t.value), next=round5(clamp(old+delta)), historyDelta=round5(next-old);
    const [r]=await pool.query(`
      UPDATE entity_traits_current SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?) AND version=?
    `,[next,simulationTime,entityId,t.traitId,t.version]);
    if (!r.affectedRows) continue;
    await pool.query(`
      INSERT INTO entity_trait_history
        (id,entity_id,trait_id,old_value,new_value,delta,changed_simulation_at,cause_event_id,cause_action_id,change_reason)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[uuid(),entityId,t.traitId,old,next,historyDelta,simulationTime,causeEventId,causeActionId,"behavioral reinforcement"]);
    out.push({code:t.code,old,next,delta:historyDelta});
  }
  return out;
}

module.exports={ensureEntityState,readNeeds,updateNeeds,applyEmotions,getTraits,developTraits,clamp};
