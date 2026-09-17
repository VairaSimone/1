const { pool, withTransaction } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { env } = require("../config/env");

const DEFAULT_ASAMI_PERSONALITY = {
  OPENNESS: .72,
  EXTRAVERSION: .58,
  CURIOSITY: .80,
  CONFIDENCE: .58,
  EMPATHY: .70,
  SOCIABILITY: .62,
  CONSCIENTIOUSNESS: .62,
  DISCIPLINE: .58,
  PATIENCE: .56,
  INDEPENDENCE: .46,
  IMPULSIVITY: .42,
  CREATIVITY: .68,
  RISK_TAKING: .42,
  NEUROTICISM: .40,
  SELF_CARE: .62,
  AGREEABLENESS: .68
};

async function listSimulations() {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id, name, status,
           started_simulation_at AS startedSimulationAt,
           current_simulation_at AS currentSimulationAt,
           created_real_at AS createdRealAt,
           updated_real_at AS updatedRealAt,
           version
    FROM simulations ORDER BY created_real_at DESC
  `);
  return rows;
}

async function getSimulation(id, conn = pool) {
  const [rows] = await conn.query(`
    SELECT BIN_TO_UUID(id) AS id, name, status,
           started_simulation_at AS startedSimulationAt,
           current_simulation_at AS currentSimulationAt,
           version
    FROM simulations WHERE id=UUID_TO_BIN(?) LIMIT 1
  `, [id]);
  return rows[0] || null;
}

async function createSimulation({ name, startedSimulationAt, asami }) {
  const id = uuid();
  const t = startedSimulationAt || new Date();
  return withTransaction(async conn => {
    await conn.query(`
      INSERT INTO simulations
        (id,name,status,started_simulation_at,current_simulation_at,version)
      VALUES (UUID_TO_BIN(?),?,?,?,?,1)
    `, [id, name, "INITIALIZING", t, t]);

    const segmentId = uuid();
    await conn.query(`
      INSERT INTO simulation_clock_segments
        (id,simulation_id,real_anchor_at,simulation_anchor_at,speed,status,created_real_at)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UTC_TIMESTAMP(3),?,?,'ACTIVE',UTC_TIMESTAMP(3))
    `, [segmentId, id, t, asami?.speed ?? env.DEFAULT_SPEED]);

    const [types] = await conn.query(
      `SELECT id FROM entity_types WHERE code='PERSON' AND active=1 LIMIT 1`
    );
    if (!types.length) throw new Error("Database is missing active PERSON entity type");

    const asamiEntityId = uuid();
    await conn.query(`
      INSERT INTO entities
        (id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,1)
    `, [
      asamiEntityId,id,types[0].id,asami?.name || "Asami",
      asami?.description || "Autonomous simulated person","ACTIVE",
      JSON.stringify(asami?.attributes || {}),t
    ]);
    await conn.query(`
      INSERT INTO persons(entity_id,first_name,last_name,birth_simulation_at,sex,gender,education_level)
      VALUES(UUID_TO_BIN(?),?,?,?,?,?,?)
    `, [
      asamiEntityId,asami?.firstName || "Asami",asami?.lastName || null,
      asami?.birthSimulationAt || t,asami?.sex || null,asami?.gender || null,
      asami?.educationLevel || null
    ]);
    await conn.query(`
      INSERT INTO autonomy_policies
        (id,simulation_id,entity_id,policy_type,enabled,configuration,scope_entity_id,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'AUTONOMY',1,?,UUID_TO_BIN(?),1)
    `, [
      uuid(),id,asamiEntityId,
      JSON.stringify({ deterministicFallback:true, decisionMode:"hybrid" }),
      asamiEntityId
    ]);

    const [[needDefs],[emotionDefs],[traitDefs],[skillDefs]] = await Promise.all([
      conn.query("SELECT id,default_value FROM need_definitions WHERE active=1"),
      conn.query("SELECT id,default_value FROM emotion_definitions WHERE active=1"),
      conn.query("SELECT id,code,default_value FROM trait_definitions WHERE active=1"),
      conn.query("SELECT id FROM skill_definitions WHERE active=1")
    ]);
    for (const d of needDefs) await conn.query(
      `INSERT INTO entity_needs_current(entity_id,need_id,value,updated_simulation_at,version)
       VALUES(UUID_TO_BIN(?),?,?,?,1)`,[asamiEntityId,d.id,d.default_value,t]);
    for (const d of emotionDefs) await conn.query(
      `INSERT INTO entity_emotions_current(entity_id,emotion_id,intensity,updated_simulation_at,version)
       VALUES(UUID_TO_BIN(?),?,?,?,1)`,[asamiEntityId,d.id,d.default_value,t]);
    for (const d of traitDefs) {
      const initialValue = Object.prototype.hasOwnProperty.call(DEFAULT_ASAMI_PERSONALITY,String(d.code||"").toUpperCase())
        ? DEFAULT_ASAMI_PERSONALITY[String(d.code).toUpperCase()]
        : d.default_value;
      await conn.query(
        `INSERT INTO entity_traits_current(entity_id,trait_id,value,updated_simulation_at,version)
         VALUES(UUID_TO_BIN(?),?,?,?,1)`,[asamiEntityId,d.id,initialValue,t]
      );
    }
    for (const d of skillDefs) await conn.query(
      `INSERT INTO entity_skills(entity_id,skill_id,updated_simulation_at,version)
       VALUES(UUID_TO_BIN(?),?, ?,1)`,
      [asamiEntityId,d.id,t]
    );

    await conn.query(`
      INSERT INTO entity_development
        (entity_id,development_stage_id,physical_score,cognitive_score,social_score,emotional_score,education_score,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),NULL,0.5,0.5,0.5,0.5,0.5,?,1)
    `,[asamiEntityId,t]);

    await conn.query(
      `UPDATE simulations SET status='RUNNING', version=version+1 WHERE id=UUID_TO_BIN(?)`,
      [id]
    );

    return {
      simulation: await getSimulation(id, conn),
      asamiEntityId
    };
  });
}

async function setStatus(id, status) {
  return withTransaction(async conn => {
    const [sims] = await conn.query(`
      SELECT current_simulation_at FROM simulations
      WHERE id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE
    `,[id]);
    if(!sims.length) throw Object.assign(new Error("Simulation not found"),{code:"NOT_FOUND"});
    const nowSim=sims[0].current_simulation_at;

    const [active] = await conn.query(`
      SELECT id FROM simulation_clock_segments
      WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1 FOR UPDATE
    `,[id]);

    if(status==="RUNNING" && !active.length){
      const [last] = await conn.query(`
        SELECT speed FROM simulation_clock_segments
        WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_real_at DESC LIMIT 1
      `,[id]);
      const speed=last.length ? Number(last[0].speed) : env.DEFAULT_SPEED;
      const segmentId=uuid();
      await conn.query(`
        INSERT INTO simulation_clock_segments
          (id,simulation_id,real_anchor_at,simulation_anchor_at,speed,status,created_real_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UTC_TIMESTAMP(3),?,?,'ACTIVE',UTC_TIMESTAMP(3))
      `,[segmentId,id,nowSim,speed]);
    } else if(status!=="RUNNING" && active.length){
      await conn.query(`
        UPDATE simulation_clock_segments
        SET status='CLOSED',ended_real_at=UTC_TIMESTAMP(3),ended_simulation_at=?
        WHERE id=?
      `,[nowSim,active[0].id]);
    }

    await conn.query(
      `UPDATE simulations SET status=?,version=version+1 WHERE id=UUID_TO_BIN(?)`,
      [status,id]
    );
    return getSimulation(id,conn);
  });
}

async function changeSpeed(id, speed, simulationTime) {
  return withTransaction(async conn => {
    const [sims] = await conn.query(`
      SELECT current_simulation_at AS currentSimulationAt,status,version
      FROM simulations
      WHERE id=UUID_TO_BIN(?)
      LIMIT 1 FOR UPDATE
    `,[id]);
    if(!sims.length) throw Object.assign(new Error("Simulation not found"),{code:"NOT_FOUND"});
    if(sims[0].status!=="RUNNING") throw Object.assign(new Error("Simulation is not running"),{code:"SIMULATION_NOT_RUNNING"});

    const [current] = await conn.query(`
      SELECT id, simulation_anchor_at, real_anchor_at, speed, status
      FROM simulation_clock_segments
      WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'
      LIMIT 1 FOR UPDATE
    `, [id]);
    if (!current.length) throw Object.assign(new Error("No active clock segment"), { code: "CLOCK_NOT_ACTIVE" });

    const c = current[0];
    const requestedTime = new Date(simulationTime);
    const storedTime = new Date(sims[0].currentSimulationAt);
    const anchorTime = new Date(c.simulation_anchor_at);
    const candidates = [storedTime,anchorTime,requestedTime].filter(date=>Number.isFinite(date.getTime()));
    const endSimulationTime = new Date(Math.max(...candidates.map(date=>date.getTime())));

    await conn.query(`
      UPDATE simulation_clock_segments
      SET status='CLOSED',ended_real_at=UTC_TIMESTAMP(3),ended_simulation_at=?
      WHERE id=?
    `, [endSimulationTime, c.id]);

    await conn.query(`
      UPDATE simulations
      SET current_simulation_at=?,version=version+1
      WHERE id=UUID_TO_BIN(?) AND version=? AND status='RUNNING'
    `,[endSimulationTime,id,sims[0].version]);

    const segmentId = uuid();
    await conn.query(`
      INSERT INTO simulation_clock_segments
        (id,simulation_id,real_anchor_at,simulation_anchor_at,speed,status,created_real_at)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UTC_TIMESTAMP(3),?,?,'ACTIVE',UTC_TIMESTAMP(3))
    `, [segmentId, id, endSimulationTime, speed]);
    return getSimulation(id, conn);
  });
}

async function getActiveClock(id, conn = pool) {
  const [rows] = await conn.query(`
    SELECT simulation_anchor_at AS simulationAnchorAt,
           real_anchor_at AS realAnchorAt, speed
    FROM simulation_clock_segments
    WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'
    LIMIT 1
  `, [id]);
  return rows[0] || null;
}

async function advanceAndCreateTick(id, nowSimulation, version, tickType, engineVersion) {
  return withTransaction(async conn => {
    const [rows] = await conn.query(`
      SELECT status,version
      FROM simulations
      WHERE id=UUID_TO_BIN(?)
      LIMIT 1
      FOR UPDATE
    `, [id]);
    if (!rows.length || rows[0].status !== "RUNNING" || Number(rows[0].version) !== Number(version)) return null;

    const [updated] = await conn.query(`
      UPDATE simulations
      SET current_simulation_at=?, version=version+1
      WHERE id=UUID_TO_BIN(?) AND version=? AND status='RUNNING'
    `, [nowSimulation, id, version]);
    if (updated.affectedRows !== 1) return null;

    const tickId = uuid();
    await conn.query(`
      INSERT INTO simulation_ticks
        (id,simulation_id,simulation_time,real_started_at,tick_type,status,engine_version)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,UTC_TIMESTAMP(3),?,'RUNNING',?)
    `, [tickId, id, nowSimulation, tickType, engineVersion]);
    return tickId;
  });
}

async function updateCurrentTimeOptimistic(id, nowSimulation, version) {
  const [r] = await pool.query(`
    UPDATE simulations
    SET current_simulation_at=?, version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=? AND status='RUNNING'
  `, [nowSimulation, id, version]);
  return r.affectedRows === 1;
}

async function createTick(id, simulationTime, tickType, engineVersion) {
  const tickId = uuid();
  await pool.query(`
    INSERT INTO simulation_ticks
      (id,simulation_id,simulation_time,real_started_at,tick_type,status,engine_version)
    VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,UTC_TIMESTAMP(3),?,'RUNNING',?)
  `, [tickId, id, simulationTime, tickType, engineVersion]);
  return tickId;
}

async function finishTick(tickId, status = "COMPLETED") {
  const normalizedStatus = status && typeof status === "object" ? status.status : status;
  const finalStatus = normalizedStatus || "COMPLETED";
  const allowedStatuses = new Set(["COMPLETED", "FAILED", "SKIPPED"]);
  if (!allowedStatuses.has(finalStatus)) {
    throw Object.assign(new Error(`Invalid simulation tick status: ${String(finalStatus)}`), { code: "INVALID_TICK_STATUS" });
  }
  await pool.query(`
    UPDATE simulation_ticks
    SET status=?, real_finished_at=UTC_TIMESTAMP(3)
    WHERE id=UUID_TO_BIN(?) AND status='RUNNING'
  `, [finalStatus, tickId]);
}

async function createSnapshot(id, simulationTime, state, snapshotVersion = 1) {
  const snapshotState = state === undefined || state === null
    ? { simulationTime: simulationTime instanceof Date ? simulationTime.toISOString() : String(simulationTime || "") }
    : state;
  await pool.query(`
    INSERT INTO simulation_snapshots
      (id,simulation_id,simulation_time,snapshot_version,state)
    VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?)
  `, [uuid(), id, simulationTime, snapshotVersion, JSON.stringify(snapshotState)]);
}

module.exports = {
  listSimulations, getSimulation, createSimulation, setStatus, changeSpeed,
  getActiveClock, updateCurrentTimeOptimistic, advanceAndCreateTick, createTick, finishTick,
  completeTick: finishTick, createSnapshot
};
