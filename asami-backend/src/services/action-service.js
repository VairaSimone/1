const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent, addEffect } = require("./event-service");
const { upsertInteractionRelationship } = require("./relationship-service");

const ACTION_DURATIONS_MINUTES = {
  SLEEPING: 480,
  RESTING: 60,
  EATING: 30,
  DRINKING: 10,
  TALKING: 20,
  PLAYING: 60,
  STUDYING: 90,
  READING: 45,
  WORKING: 240,
  EXPLORING: 60,
  WALKING: 30,
  WATCHING: 45
};

const skillByAction = {
  READING:"READING", STUDYING:"WRITING", TALKING:"COMMUNICATION",
  EXPLORING:"NAVIGATION", PLAYING:"SPORTS", EATING:"COOKING",
  WALKING:"SELF_CARE"
};

function getActionDurationMinutes(actionType) {
  return ACTION_DURATIONS_MINUTES[actionType] || 30;
}

async function currentLocation(entityId, simulationId) {
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current
    WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)
  `,[entityId,simulationId]);
  return rows[0]?.locationId || null;
}

async function chooseDestination(simulationId, entityId, originId) {
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(l.entity_id) AS locationId
    FROM locations l JOIN entities e ON e.id=l.entity_id
    WHERE l.simulation_id=UUID_TO_BIN(?) AND l.entity_id<>UUID_TO_BIN(?)
    ORDER BY RAND() LIMIT 1
  `,[simulationId, originId || entityId]);
  return rows[0]?.locationId || null;
}

async function getActiveAction(entityId, simulationId) {
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id, action_type AS actionType,
           started_simulation_at AS startedSimulationAt,
           completed_simulation_at AS completedSimulationAt,
           BIN_TO_UUID(decision_id) AS decisionId,
           BIN_TO_UUID(source_intention_id) AS intentionId,
           target AS target,
           parameters AS parameters,
           version
    FROM actions
    WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'
    ORDER BY started_simulation_at DESC LIMIT 1
  `,[entityId,simulationId]);
  const action=rows[0]||null;
  if (!action) return null;
  if (Buffer.isBuffer(action.parameters)) action.parameters=action.parameters.toString();
  if (typeof action.parameters === "string") { try { action.parameters=JSON.parse(action.parameters); } catch { action.parameters={}; } }
  if (Buffer.isBuffer(action.target)) action.target=action.target.toString();
  return action;
}

async function startAction({simulationId,entityId,decisionId,intentionId=null,actionType,simulationTime,targetEntityId=null,targetLocationId=null}) {
  const actionId=uuid();
  const duration=getActionDurationMinutes(actionType);
  const expectedCompletion=new Date(new Date(simulationTime).getTime()+duration*60000);
  await pool.query(`
    INSERT INTO actions
      (id,simulation_id,entity_id,decision_id,action_type,source_type,source_intention_id,
       started_simulation_at,status,target,parameters,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',UUID_TO_BIN(?),
           ?,'ACTIVE',?,?,1)
  `,[actionId,simulationId,entityId,decisionId,actionType,intentionId,simulationTime,
     targetLocationId ? JSON.stringify({locationId:targetLocationId}) : null,
     JSON.stringify({targetEntityId,targetLocationId,durationMinutes:duration,expectedCompletionSimulationAt:expectedCompletion.toISOString()})]);

  const eventCode=actionType==="TALKING" ? "SOCIAL" : "PERSONAL";
  const eventId=await createEvent({
    simulationId,eventTypeCode:eventCode,
    title:`Asami ${actionType.toLowerCase().replaceAll("_"," ")}`,
    description:`Autonomous action started: ${actionType}`,
    simulationAt:simulationTime,importance:0.45,sourceActionId:actionId,
    participants:[{entityId,role:"ACTOR"}],
    metadata:{actionType,targetEntityId,targetLocationId,durationMinutes:duration,status:"ACTIVE"}
  });

  await pool.query(`
    UPDATE actions SET result=? WHERE id=UUID_TO_BIN(?)
  `,[JSON.stringify({eventId,actionType,durationMinutes:duration,targetEntityId,targetLocationId}),actionId]);

  return {actionId,eventId,actionType,durationMinutes:duration,expectedCompletionSimulationAt:expectedCompletion};
}

async function completeAction({simulationId,entityId,actionId,eventId,intentionId=null,actionType,simulationTime,targetEntityId=null,targetLocationId=null}) {
  const [updated]=await pool.query(`
    UPDATE actions SET status='COMPLETED',completed_simulation_at=?,result=?
    WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'
  `,[simulationTime,JSON.stringify({eventId,actionType,success:true,targetEntityId,targetLocationId}),actionId,entityId,simulationId]);
  if (!updated.affectedRows) return false;

  await addEffect({
    simulationId,eventId,effectType:"ACTION_COMPLETED",targetActionId:actionId,
    targetEntityId:entityId,afterState:{actionType,status:"COMPLETED"},magnitude:1,createdSimulationAt:simulationTime
  });

  if(actionType==="WALKING" || actionType==="EXPLORING"){
    const origin=await currentLocation(entityId,simulationId);
    const destination=targetLocationId || await chooseDestination(simulationId,entityId,origin);
    if(origin && destination && origin!==destination) await moveEntity(simulationId,entityId,origin,destination,simulationTime);
  }

  if(actionType==="TALKING" && targetEntityId){
    await upsertInteractionRelationship({
      simulationId,sourceEntityId:entityId,targetEntityId,simulationAt:simulationTime,
      sourceEventId:eventId,deltas:{familiarity:0.015,closeness:0.008,affection:0.004,trust:0.002}
    });
  }

  if(intentionId) await pool.query(`
    UPDATE intentions SET status='COMPLETED',version=version+1
    WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'
  `,[intentionId]);

  await pool.query(`
    UPDATE decisions SET status='EXECUTED',actual_outcome=? WHERE id=UUID_TO_BIN(?)
  `,[JSON.stringify({actionId,eventId,success:true}),updated.affectedRows ? actionId : null]);
  return true;
}

async function executeAction(args) {
  const started=await startAction(args);
  await completeAction({...args,actionId:started.actionId,eventId:started.eventId});
  return {actionId:started.actionId,eventId:started.eventId};
}

async function moveEntity(simulationId,entityId,origin,destination,simulationTime){
  const [existing]=await pool.query(`
    SELECT id FROM movements
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('PLANNED','ACTIVE') LIMIT 1
  `,[simulationId,entityId]);
  if(existing.length)return;
  await pool.query(`
    INSERT INTO movements
      (id,simulation_id,entity_id,origin_location_id,destination_location_id,started_simulation_at,
       expected_arrival_simulation_at,status,reason,source_activity_id,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'ACTIVE','autonomous action',NULL,1)
  `,[uuid(),simulationId,entityId,origin,destination,simulationTime,new Date(new Date(simulationTime).getTime()+15*60000)]);
  await pool.query(`
    INSERT INTO entity_location_history
      (id,simulation_id,entity_id,location_id,entered_simulation_at,reason,source_event_id)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',NULL)
  `,[uuid(),simulationId,entityId,destination,simulationTime]);
  await pool.query(`
    UPDATE entity_location_history SET exited_simulation_at=?
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      AND location_id=UUID_TO_BIN(?) AND exited_simulation_at IS NULL AND entered_simulation_at<?
  `,[simulationTime,simulationId,entityId,origin,simulationTime]);
  await pool.query(`
    INSERT INTO entity_locations_current(entity_id,simulation_id,location_id,since_simulation_at,reason,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',1)
    ON DUPLICATE KEY UPDATE location_id=VALUES(location_id),since_simulation_at=VALUES(since_simulation_at),reason=VALUES(reason),version=version+1
  `,[entityId,simulationId,destination,simulationTime]);
  await pool.query(`
    UPDATE movements SET status='COMPLETED',actual_arrival_simulation_at=?,version=version+1
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND destination_location_id=UUID_TO_BIN(?)
  `,[simulationTime,simulationId,entityId,destination]);
}

async function learnFromAction(entityId,actionType,simulationTime){
  const skill=skillByAction[actionType];
  if(!skill)return;
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(es.skill_id) AS skillId,es.proficiency,es.confidence,es.version
    FROM entity_skills es JOIN skill_definitions sd ON sd.id=es.skill_id
    WHERE es.entity_id=UUID_TO_BIN(?) AND sd.code=? LIMIT 1
  `,[entityId,skill]);
  if(!rows.length)return;
  const s=rows[0],next=Math.min(1,Number(s.proficiency)+0.004),conf=Math.min(1,Number(s.confidence)+0.003);
  await pool.query(`
    UPDATE entity_skills SET proficiency=?,confidence=?,last_used_simulation_at=?,updated_simulation_at=?,version=version+1
    WHERE entity_id=UUID_TO_BIN(?) AND skill_id=UUID_TO_BIN(?) AND version=?
  `,[next,conf,simulationTime,simulationTime,entityId,s.skillId,s.version]);
}

module.exports={startAction,completeAction,executeAction,getActiveAction,learnFromAction,getActionDurationMinutes};
