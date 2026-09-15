const { pool } = require("../db/pool");

async function perceive(simulationId,entityId,simulationTime){
  const [[location],[nearby],[recentEvents],[relationships]] = await Promise.all([
    pool.query(`
      SELECT BIN_TO_UUID(elc.location_id) AS locationId,l.location_type AS locationType,l.address_data AS addressData
      FROM entity_locations_current elc JOIN locations l ON l.entity_id=elc.location_id
      WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id=UUID_TO_BIN(?)
    `,[simulationId,entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(elc.entity_id) AS entityId,e.display_name AS displayName,
             BIN_TO_UUID(elc.location_id) AS locationId
      FROM entity_locations_current elc JOIN entities e ON e.id=elc.entity_id
      WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.location_id=(
        SELECT location_id FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1
      ) AND elc.entity_id<>UUID_TO_BIN(?)
      LIMIT 25
    `,[simulationId,simulationId,entityId,entityId]),
    pool.query(`
      SELECT BIN_TO_UUID(e.id) AS id,et.code AS type,e.title,e.description,e.importance
      FROM events e JOIN event_types et ON et.id=e.event_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND e.simulation_at<=?
      ORDER BY e.simulation_at DESC LIMIT 12
    `,[simulationId,simulationTime]),
    pool.query(`
      SELECT BIN_TO_UUID(id) AS id,trust_score AS trust,affection_score AS affection,
             familiarity_score AS familiarity,closeness_score AS closeness,status
      FROM relationships
      WHERE simulation_id=UUID_TO_BIN(?) AND (source_entity_id=UUID_TO_BIN(?) OR target_entity_id=UUID_TO_BIN(?))
      AND status='ACTIVE'
      ORDER BY closeness_score DESC LIMIT 12
    `,[simulationId,entityId,entityId])
  ]);
  return {simulationTime,location:location[0]||null,nearby,recentEvents,relationships};
}

module.exports={perceive};
