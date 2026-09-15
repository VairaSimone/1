const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { createEvent, addEffect } = require("./event-service");

function eventProbability(elapsedSimulationMinutes, eventsPerSimulationHour = env.WORLD_EVENT_RATE_PER_SIM_HOUR) {
  const minutes = Math.max(0, Number(elapsedSimulationMinutes) || 0);
  const hourlyRate = Math.max(0, Number(eventsPerSimulationHour) || 0);
  return 1 - Math.exp(-(hourlyRate * minutes) / 60);
}

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}

async function generateWorldEvents(simulationId,simulationTime,tickId,elapsedSimulationMinutes=0){
  if(Math.random()>eventProbability(elapsedSimulationMinutes))return [];
  const [actors]=await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS entityId,
           BIN_TO_UUID(elc.location_id) AS locationId,
           l.location_type AS locationType,
           l.address_data AS addressData
    FROM entities e
    JOIN entity_types et ON et.id=e.entity_type_id
    LEFT JOIN entity_locations_current elc
      ON elc.simulation_id=e.simulation_id AND elc.entity_id=e.id
    LEFT JOIN locations l
      ON l.entity_id=elc.location_id AND l.simulation_id=elc.simulation_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR'
      AND e.status NOT IN ('INACTIVE','DEAD')
    ORDER BY RAND() LIMIT 1
  `,[simulationId]);
  const target=actors[0]||null;
  const worldCode=parseJson(target?.addressData).worldCode||null;
  const locationName=worldCode||target?.locationType||"the neighborhood";
  const candidates=target?.locationType==='LIBRARY' || target?.locationType==='SCHOOL'
    ? [
        ["ENVIRONMENTAL","A quiet change settles over the area","The surroundings become unusually quiet, changing the local atmosphere.",0.28,"AMBIENT_QUIET"],
        ["RANDOM","Someone drops a stack of books","A small unexpected incident draws attention nearby.",0.25,"MINOR_INCIDENT"]
      ]
    : target?.locationType==='PARK' || target?.locationType==='NATURE'
      ? [
          ["ENVIRONMENTAL","The weather shifts","A brief environmental change affects the area.",0.35,"WEATHER_CHANGE"],
          ["ENVIRONMENTAL","Wildlife stirs nearby","A small natural event changes the local context.",0.22,"WILDLIFE_ACTIVITY"]
        ]
      : [
          ["ENVIRONMENTAL","A sudden change in weather","The environment changes independently of the actor.",0.35,"WEATHER_CHANGE"],
          ["RANDOM","Something unusual happens","An unexpected minor event occurs in the local area.",0.25,"UNEXPECTED_EVENT"],
          ["ENVIRONMENTAL","The surrounding environment is noisy","Ambient noise changes the current context.",0.2,"AMBIENT_NOISE"]
        ];
  const [code,title,description,importance,effectType]=candidates[Math.floor(Math.random()*candidates.length)];
  const eventId=await createEvent({
    simulationId,eventTypeCode:code,title,description:locationName?`${title} at ${locationName}`:title,simulationAt:simulationTime,importance,sourceTickId:tickId,
    metadata:{effectType,autonomous:true,locationId:target?.locationId||null,locationType:target?.locationType||null,worldCode},participants:target?[{entityId:target.entityId,role:"AFFECTED"}]:[]
  });
  if(target){
    await addEffect({
      simulationId,eventId,effectType,targetEntityId:target.entityId,
      afterState:{environmental:true,effectType,locationId:target.locationId||null,locationType:target.locationType||null},magnitude:importance,createdSimulationAt:simulationTime
    });
  }
  return [eventId];
}

async function processWorldEffects(simulationId,simulationTime){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,metadata FROM events
    WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED'
    ORDER BY real_created_at
  `,[simulationId,simulationTime]);
  if(rows.length) await pool.query(
    `UPDATE events SET status='PROCESSED' WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED'`,
    [simulationId,simulationTime]
  );
  return rows;
}
module.exports={generateWorldEvents,processWorldEffects,eventProbability};