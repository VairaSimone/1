const { pool } = require("../db/pool");

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function perceive(simulationId,entityId,simulationTime){
  const [[location],[nearby],[recentEvents],[relationships]] = await Promise.all([
    pool.query(`
      SELECT BIN_TO_UUID(elc.location_id) AS locationId,l.location_type AS locationType,l.address_data AS addressData,e.attributes
      FROM entity_locations_current elc JOIN locations l ON l.entity_id=elc.location_id
      JOIN entities e ON e.id=elc.location_id
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
      SELECT BIN_TO_UUID(e.id) AS id,et.code AS type,e.title,e.description,e.importance,e.simulation_at AS simulationAt
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
  const currentLocation = location[0] || null;
  if (currentLocation) {
    const attributes = parseJson(currentLocation.attributes, {});
    currentLocation.environment = attributes.environment || {};
    delete currentLocation.attributes;
  }
  return {simulationTime,location:currentLocation,nearby,recentEvents,relationships};
}


async function perceiveBatch(simulationId,entityIds=[],simulationTime){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))];
  const result=new Map();
  if(!ids.length)return result;
  const placeholders=ids.map(()=>"UUID_TO_BIN(?)").join(",");
  const [[locationRows],[nearbyRows],[eventRows],[relationshipRows]] = await Promise.all([
    pool.query(`
      SELECT BIN_TO_UUID(elc.entity_id) AS entityId,
             BIN_TO_UUID(elc.location_id) AS locationId,
             l.location_type AS locationType,l.address_data AS addressData,
             e.attributes
      FROM entity_locations_current elc
      JOIN locations l ON l.entity_id=elc.location_id AND l.simulation_id=elc.simulation_id
      JOIN entities e ON e.id=elc.location_id AND e.simulation_id=elc.simulation_id
      WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id IN (${placeholders})`,
      [simulationId,...ids]
    ),
    pool.query(`
      SELECT BIN_TO_UUID(me.entity_id) AS sourceEntityId,
             BIN_TO_UUID(other.entity_id) AS entityId,
             other.display_name AS displayName,
             BIN_TO_UUID(other.location_id) AS locationId
      FROM entity_locations_current me
      JOIN entity_locations_current other
        ON other.simulation_id=me.simulation_id AND other.location_id=me.location_id
       AND other.entity_id<>me.entity_id
      JOIN entities otherEntity
        ON otherEntity.id=other.entity_id AND otherEntity.simulation_id=other.simulation_id
      JOIN (SELECT entity_id,location_id FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id IN (${placeholders})) selected
        ON selected.entity_id=me.entity_id AND selected.location_id=me.location_id
      WHERE me.simulation_id=UUID_TO_BIN(?) AND me.entity_id IN (${placeholders})
        AND otherEntity.status='ACTIVE'
      LIMIT 500`,
      [simulationId,...ids,simulationId,...ids]
    ),
    pool.query(`
      SELECT BIN_TO_UUID(e.id) AS id,et.code AS type,e.title,e.description,e.importance,e.simulation_at AS simulationAt
      FROM events e JOIN event_types et ON et.id=e.event_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND e.simulation_at<=?
      ORDER BY e.simulation_at DESC LIMIT 12`,
      [simulationId,simulationTime]
    ),
    pool.query(`
      SELECT BIN_TO_UUID(r.id) AS id,
             BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,
             BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
             r.trust_score AS trust,r.affection_score AS affection,
             r.familiarity_score AS familiarity,r.closeness_score AS closeness,r.status
      FROM relationships r
      WHERE r.simulation_id=UUID_TO_BIN(?)
        AND (r.source_entity_id IN (${placeholders}) OR r.target_entity_id IN (${placeholders}))
        AND r.status='ACTIVE'
      ORDER BY r.closeness_score DESC LIMIT 500`,
      [simulationId,...ids,...ids]
    )
  ]);
  const byId=new Map(ids.map(id=>[id,{simulationTime,location:null,nearby:[],recentEvents:eventRows||[],relationships:[]}]));
  for(const row of locationRows){
    const item=byId.get(row.entityId); if(!item)continue;
    const attributes=parseJson(row.attributes,{});
    item.location={locationId:row.locationId,locationType:row.locationType,addressData:parseJson(row.addressData,{}),environment:attributes.environment||{}};
  }
  for(const row of nearbyRows){
    const item=byId.get(row.sourceEntityId); if(item&&item.nearby.length<25)item.nearby.push({
      entityId:row.entityId,displayName:row.displayName,locationId:row.locationId
    });
  }
  for(const row of relationshipRows){
    for(const id of [row.sourceEntityId,row.targetEntityId]){
      const item=byId.get(id);
      if(item&&item.relationships.length<12)item.relationships.push({
        id:row.id,sourceEntityId:row.sourceEntityId,targetEntityId:row.targetEntityId,
        trust:Number(row.trust||0),affection:Number(row.affection||0),
        familiarity:Number(row.familiarity||0),closeness:Number(row.closeness||0),
        status:row.status
      });
    }
  }
  return byId;
}

module.exports={perceive,perceiveBatch};
