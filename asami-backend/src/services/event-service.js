const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

async function getEventTypeId(code) {
  const [rows]=await pool.query("SELECT id FROM event_types WHERE code=? AND active=1 LIMIT 1",[code]);
  return rows[0]?.id || null;
}

async function createEvent({simulationId,eventTypeCode,title,description,simulationAt,importance=0.5,sourceTickId=null,sourceActionId=null,metadata=null,participants=[]}) {
  const eventTypeId=await getEventTypeId(eventTypeCode);
  if (!eventTypeId) throw new Error(`Missing event type: ${eventTypeCode}`);
  const eventId=uuid();
  await pool.query(`
    INSERT INTO events
      (id,simulation_id,event_type_id,title,description,simulation_at,importance,status,source_tick_id,source_action_id,metadata)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?, ?, ?, ?, ?, 'RECORDED',
           UUID_TO_BIN(?), UUID_TO_BIN(?), ?)
  `,[eventId,simulationId,eventTypeId,title,description||null,simulationAt,importance,sourceTickId,sourceActionId,metadata?JSON.stringify(metadata):null]);

  for(const p of participants){
    await pool.query(`
      INSERT IGNORE INTO event_participants(event_id,simulation_id,entity_id,role)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[eventId,simulationId,p.entityId,p.role]);
  }
  return eventId;
}

async function addEffect({simulationId,eventId,effectType,targetEntityId=null,targetRelationshipId=null,targetActivityId=null,targetMemoryId=null,targetGoalId=null,targetActionId=null,beforeState=null,afterState=null,magnitude=null,createdSimulationAt}) {
  const effectId=uuid();
  await pool.query(`
    INSERT INTO event_effects
      (id,simulation_id,event_id,effect_type,target_entity_id,target_relationship_id,target_activity_id,target_memory_id,target_goal_id,target_action_id,before_state,after_state,magnitude,created_simulation_at)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,
           UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),
           ?,?,?,?)
  `,[effectId,simulationId,eventId,effectType,targetEntityId,targetRelationshipId,targetActivityId,targetMemoryId,targetGoalId,targetActionId,
     beforeState?JSON.stringify(beforeState):null,afterState?JSON.stringify(afterState):null,magnitude,createdSimulationAt]);
  return effectId;
}

async function listEvents(simulationId,{from,to,limit=100}={}) {
  const params=[simulationId];
  let where="e.simulation_id=UUID_TO_BIN(?)";
  if(from){where+=" AND e.simulation_at>=?";params.push(from);}
  if(to){where+=" AND e.simulation_at<=?";params.push(to);}
  params.push(Math.min(limit,500));
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS id, et.code AS type, et.category,
           e.title,e.description,e.simulation_at AS simulationAt,e.importance,e.status,
           BIN_TO_UUID(e.source_action_id) AS sourceActionId,e.metadata
    FROM events e JOIN event_types et ON et.id=e.event_type_id
    WHERE ${where}
    ORDER BY e.simulation_at DESC LIMIT ?
  `,params);
  return rows;
}

async function listTimeline(simulationId,entityId,limit=200){
  const params=[simulationId,entityId,entityId,simulationId,entityId,limit];
  const [rows]=await pool.query(`
    SELECT * FROM (
      SELECT e.simulation_at AS at,'EVENT' AS kind,BIN_TO_UUID(e.id) AS id,
             et.code AS type,e.title AS summary,e.metadata
      FROM events e
      JOIN event_types et ON et.id=e.event_type_id
      JOIN event_participants ep ON ep.event_id=e.id AND ep.entity_id=UUID_TO_BIN(?)
      WHERE e.simulation_id=UUID_TO_BIN(?)
      UNION ALL
      SELECT a.started_simulation_at,'ACTION',BIN_TO_UUID(a.id),a.action_type,
             CONCAT(a.action_type, ' [', a.status, ']'),a.result
      FROM actions a
      WHERE a.simulation_id=UUID_TO_BIN(?) AND a.entity_id=UUID_TO_BIN(?)
    ) x ORDER BY at DESC LIMIT ?
  `,[entityId,simulationId,simulationId,entityId,limit]);
  return rows;
}

module.exports={createEvent,addEffect,listEvents,listTimeline};
