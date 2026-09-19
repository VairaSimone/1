const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

async function getRelationships(simulationId,entityId){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(r.id) AS id,
           BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,
           BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
           rt.code AS type,r.trust_score AS trust,r.affection_score AS affection,
           r.respect_score AS respect,r.familiarity_score AS familiarity,
           r.attraction_score AS attraction,r.conflict_score AS conflict,
           r.fear_score AS fear,r.admiration_score AS admiration,
           r.jealousy_score AS jealousy,r.dependence_score AS dependence,
           r.closeness_score AS closeness,r.irritation_score AS irritation,
           r.status,r.version
    FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
    WHERE r.simulation_id=UUID_TO_BIN(?)
      AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?))
    ORDER BY r.closeness_score DESC
  `,[simulationId,entityId,entityId]);
  return rows;
}

async function upsertInteractionRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,deltas,typeCode="ACQUAINTANCE",sourceEventId=null}){
  if(sourceEntityId===targetEntityId)return null;
  const [[type]] = await Promise.all([pool.query("SELECT BIN_TO_UUID(id) AS id,symmetric FROM relationship_types WHERE code=? AND active=1 LIMIT 1",[typeCode]).then(([r])=>[r[0]||null])]);
  if(!type) return null;
  let [rows]=await pool.query(`
    SELECT BIN_TO_UUID(r.id) AS id,r.version,r.trust_score,r.affection_score,r.respect_score,r.familiarity_score,
           r.attraction_score,r.conflict_score,r.fear_score,r.admiration_score,r.jealousy_score,r.dependence_score,
           r.closeness_score,r.irritation_score
    FROM relationships r
    WHERE r.simulation_id=UUID_TO_BIN(?) AND r.source_entity_id=UUID_TO_BIN(?)
      AND r.target_entity_id=UUID_TO_BIN(?) AND r.relationship_type_id=UUID_TO_BIN(?) AND r.status='ACTIVE'
    LIMIT 1
  `,[simulationId,sourceEntityId,targetEntityId,type.id]);
  if(!rows.length && Number(type.symmetric)){
    [rows]=await pool.query(`
      SELECT BIN_TO_UUID(r.id) AS id,r.version,r.trust_score,r.affection_score,r.respect_score,r.familiarity_score,
             r.attraction_score,r.conflict_score,r.fear_score,r.admiration_score,r.jealousy_score,r.dependence_score,
             r.closeness_score,r.irritation_score
      FROM relationships r
      JOIN relationship_types rt ON rt.id=r.relationship_type_id
      WHERE r.simulation_id=UUID_TO_BIN(?)
        AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?))
          OR (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?)))
        AND r.status='ACTIVE'
      ORDER BY CASE rt.code
        WHEN 'PARTNER' THEN 3
        WHEN 'FRIEND' THEN 2
        ELSE 1
      END DESC, r.started_simulation_at DESC
      LIMIT 1
    `,[simulationId,sourceEntityId,targetEntityId,targetEntityId,sourceEntityId]);
  }
  if(!rows.length){
    const id=uuid();
    await pool.query(`
      INSERT INTO relationships
      (id,simulation_id,source_entity_id,target_entity_id,relationship_type_id,started_simulation_at,status,
       trust_score,affection_score,respect_score,familiarity_score,attraction_score,conflict_score,fear_score,
       admiration_score,jealousy_score,dependence_score,closeness_score,irritation_score,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,?,?,?,?,?,?,?,?,?,?,1)
    `,[id,simulationId,sourceEntityId,targetEntityId,type.id,simulationAt,
       0,0,0,0,0,0,0,0,0,0,0,0]);
    rows=[{id,version:1,trust_score:0,affection_score:0,respect_score:0,familiarity_score:0,attraction_score:0,conflict_score:0,fear_score:0,admiration_score:0,jealousy_score:0,dependence_score:0,closeness_score:0,irritation_score:0}];
  }
  const current=rows[0];
  const fields={
    trust_score:"trust",affection_score:"affection",respect_score:"respect",
    familiarity_score:"familiarity",attraction_score:"attraction",conflict_score:"conflict",
    fear_score:"fear",admiration_score:"admiration",jealousy_score:"jealousy",
    dependence_score:"dependence",closeness_score:"closeness",irritation_score:"irritation"
  };
  const next={};
  for(const [col,key] of Object.entries(fields)) next[col]=Math.max(0,Math.min(1,Number(current[col])+Number(deltas[key]||0)));
  const [updated]=await pool.query(`
    UPDATE relationships SET trust_score=?,affection_score=?,respect_score=?,familiarity_score=?,
      attraction_score=?,conflict_score=?,fear_score=?,admiration_score=?,jealousy_score=?,
      dependence_score=?,closeness_score=?,irritation_score=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=?
  `,[next.trust_score,next.affection_score,next.respect_score,next.familiarity_score,next.attraction_score,
     next.conflict_score,next.fear_score,next.admiration_score,next.jealousy_score,next.dependence_score,
     next.closeness_score,next.irritation_score,current.id,current.version]);
  if(!updated.affectedRows) return null;

  await pool.query(`
    INSERT INTO relationship_history
      (id,simulation_id,relationship_id,simulation_time,affection,trust,respect,familiarity,attraction,
       conflict,fear,irritation,admiration,jealousy,dependence,closeness,source_event_id)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,UUID_TO_BIN(?))
  `,[uuid(),simulationId,current.id,simulationAt,next.affection_score,next.trust_score,next.respect_score,
     next.familiarity_score,next.attraction_score,next.conflict_score,next.fear_score,next.irritation_score,
     next.admiration_score,next.jealousy_score,next.dependence_score,next.closeness_score,sourceEventId]);
  return current.id;
}

module.exports={getRelationships,upsertInteractionRelationship};
