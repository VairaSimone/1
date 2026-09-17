const { pool, withTransaction } = require("../db/pool");
const { uuid } = require("../lib/ids");
async function listActors(simulationId, limit = 100) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS id, e.display_name AS displayName,
           et.code AS entityType, e.status, e.attributes, e.version
    FROM entities e
    JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?)
      AND et.category='ACTOR'
      AND e.status <> ''
    ORDER BY e.created_simulation_at
    LIMIT ?
  `, [simulationId, limit]);
  return rows;
}

async function getEntity(simulationId, entityId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS id, e.display_name AS displayName,
           et.code AS entityType, e.status, e.description, e.attributes, e.version
    FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND e.id=UUID_TO_BIN(?)
    LIMIT 1
  `, [simulationId, entityId]);
  return rows[0] || null;
}

async function getAsamiCandidate(simulationId, preferredEntityId = null) {
  if (preferredEntityId) {
    const [rows] = await pool.query(`
      SELECT BIN_TO_UUID(e.id) AS id, e.display_name AS displayName,
             et.code AS entityType, e.status, e.description, e.attributes, e.version
      FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?)
        AND e.id=UUID_TO_BIN(?)
        AND et.code='PERSON'
        AND e.status <> 'DEAD'
      LIMIT 1
    `, [simulationId, preferredEntityId]);
    return rows[0] || null;
  }
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS id, e.display_name AS displayName,
           et.code AS entityType, e.status, e.description, e.attributes, e.version
    FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND et.code='PERSON' AND e.status <> 'DEAD'
    ORDER BY CASE WHEN LOWER(e.display_name)='asami' THEN 0 ELSE 1 END,
             e.created_simulation_at LIMIT 1
  `, [simulationId]);
  return rows[0] || null;
}

async function getDashboard(simulationId, entityId) {
  const entity = await getEntity(simulationId, entityId);
  if (!entity) return null;
  const [[needs], [emotions], [traits], [skills], [loc], [rels], [goals], [action]] = await Promise.all([
    pool.query(`
      SELECT nd.code, nd.name, enc.value, nd.priority_weight AS priorityWeight
      FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id
      WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1
      ORDER BY enc.value
    `, [entityId]),
    pool.query(`
      SELECT ed.code, ed.name, eec.intensity
      FROM entity_emotions_current eec JOIN emotion_definitions ed ON ed.id=eec.emotion_id
      WHERE eec.entity_id=UUID_TO_BIN(?) AND ed.active=1
      ORDER BY eec.intensity DESC
    `, [entityId]),
    pool.query(`
      SELECT td.code, td.name, etc.value
      FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id
      WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
      ORDER BY td.code
    `, [entityId]),
    pool.query(`
      SELECT sd.code, sd.name, es.proficiency, es.confidence
      FROM entity_skills es JOIN skill_definitions sd ON sd.id=es.skill_id
      WHERE es.entity_id=UUID_TO_BIN(?) AND sd.active=1
      ORDER BY sd.code
    `, [entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(elc.location_id) AS locationId, l.location_type AS locationType,
             l.latitude, l.longitude, l.address_data AS addressData,
             elc.since_simulation_at AS sinceSimulationAt
      FROM entity_locations_current elc JOIN locations l ON l.entity_id=elc.location_id
      WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id=UUID_TO_BIN(?)
    `, [simulationId, entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(r.id) AS id, rt.code AS type,
             BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,
             BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
             r.trust_score AS trustScore, r.affection_score AS affectionScore,
             r.respect_score AS respectScore, r.familiarity_score AS familiarityScore,
             r.attraction_score AS attractionScore, r.conflict_score AS conflictScore,
             r.fear_score AS fearScore, r.admiration_score AS admirationScore,
             r.jealousy_score AS jealousyScore, r.dependence_score AS dependenceScore,
             r.closeness_score AS closenessScore, r.irritation_score AS irritationScore
      FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
      WHERE r.simulation_id=UUID_TO_BIN(?)
        AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?))
        AND r.status='ACTIVE'
    `, [simulationId, entityId, entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(id) AS id, title, description, goal_type AS goalType,
             priority, status, progress, deadline_simulation_at AS deadline,
             motivation, result, version
      FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      ORDER BY priority DESC, created_simulation_at DESC LIMIT 20
    `, [simulationId, entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(id) AS id, action_type AS actionType, status, target, parameters,
             started_simulation_at AS startedAt, completed_simulation_at AS completedAt
      FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
        AND status='ACTIVE'
      ORDER BY started_simulation_at DESC LIMIT 1
    `, [simulationId, entityId])
  ]);
  return { entity, needs, emotions, traits, skills, location: loc[0] || null, relationships: rels, goals, currentAction: action[0] || null };
}

async function listDefinitions() {
  const [[needs],[emotions],[traits],[skills],[activities],[events],[relTypes],[entityTypes]] = await Promise.all([
    pool.query("SELECT * FROM need_definitions WHERE active=1"),
    pool.query("SELECT * FROM emotion_definitions WHERE active=1"),
    pool.query("SELECT * FROM trait_definitions WHERE active=1"),
    pool.query("SELECT * FROM skill_definitions WHERE active=1"),
    pool.query("SELECT * FROM activity_types WHERE active=1"),
    pool.query("SELECT * FROM event_types WHERE active=1"),
    pool.query("SELECT * FROM relationship_types WHERE active=1"),
    pool.query("SELECT * FROM entity_types WHERE active=1")
  ]);
  return { needs, emotions, traits, skills, activities, events, relTypes, entityTypes };
}

async function ensureObserver(simulationId) {
  return withTransaction(async conn => {
    const [sims] = await conn.query(`
      SELECT current_simulation_at
      FROM simulations
      WHERE id=UUID_TO_BIN(?)
      LIMIT 1
      FOR UPDATE
    `, [simulationId]);
    if (!sims.length) throw Object.assign(new Error("Simulation not found"), { code: "NOT_FOUND" });

    const [existing] = await conn.query(`
      SELECT BIN_TO_UUID(e.id) AS id,
             e.display_name AS displayName,
             e.status
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.simulation_id = UUID_TO_BIN(?)
        AND et.code = 'PERSON'
        AND e.display_name = 'Observer'
      LIMIT 1
    `, [simulationId]);

    if (existing.length) return existing[0];

    const [types] = await conn.query(`
      SELECT id
      FROM entity_types
      WHERE code = 'PERSON'
        AND active = 1
      LIMIT 1
    `);

    if (!types.length) throw new Error('Database is missing active PERSON entity type');

    const observerId = uuid();
    const currentSimulationAt = sims[0].current_simulation_at;

    await conn.query(`
      INSERT INTO entities
        (id, simulation_id, entity_type_id, display_name, description,
         status, attributes, created_simulation_at, version)
      VALUES
        (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, 'Observer',
         'Human observer interacting with Asami', 'INACTIVE', JSON_OBJECT(), ?, 1)
    `, [observerId, simulationId, types[0].id, currentSimulationAt]);

    await conn.query(`
      INSERT INTO persons
        (entity_id, first_name, birth_simulation_at)
      VALUES
        (UUID_TO_BIN(?), 'Observer', ?)
    `, [observerId, currentSimulationAt]);

    return { id: observerId, displayName: 'Observer', status: 'INACTIVE' };
  });
}

module.exports = { listActors, getEntity, getAsamiCandidate, getDashboard, listDefinitions, ensureObserver };