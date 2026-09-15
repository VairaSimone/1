const { pool } = require("../db/pool");
const { createEvent, addEffect } = require("./event-service");

async function generateWorldEvents(simulationId,simulationTime,tickId){
  if(Math.random()>0.18)return [];
  const [actors]=await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS entityId
    FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR'
      AND e.status NOT IN ('INACTIVE','DEAD')
    ORDER BY RAND() LIMIT 1
  `,[simulationId]);
  const target=actors[0]?.entityId||null;
  const candidates=[
    ["ENVIRONMENTAL","A sudden change in weather","The environment changes independently of the actor.",0.35,"WEATHER_CHANGE"],
    ["RANDOM","Something unusual happens","An unexpected minor event occurs in the world.",0.25,"UNEXPECTED_EVENT"],
    ["ENVIRONMENTAL","The surrounding environment is noisy","Ambient noise changes the current context.",0.2,"AMBIENT_NOISE"]
  ];
  const [code,title,description,importance,effectType]=candidates[Math.floor(Math.random()*candidates.length)];
  const eventId=await createEvent({
    simulationId,eventTypeCode:code,title,description,simulationAt:simulationTime,importance,sourceTickId:tickId,
    metadata:{effectType,autonomous:true},participants:target?[{entityId:target,role:"AFFECTED"}]:[]
  });
  if(target){
    await addEffect({
      simulationId,eventId,effectType,targetEntityId:target,
      afterState:{environmental:true,effectType},magnitude:importance,createdSimulationAt:simulationTime
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
module.exports={generateWorldEvents,processWorldEffects};
