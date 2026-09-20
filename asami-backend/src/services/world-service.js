const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { generateEnvironmentalEvent, updateEnvironmentState, isVitalEnvironmentalEventDue } = require("./environment-service");
const { withEventWriteLock } = require("./event-service");

const vitalFairnessCheckedAt=new Map();
const VITAL_FAIRNESS_CHECK_MINUTES=60;

async function checkVitalFairnessCached(simulationId,simulationTime){
  const now=new Date(simulationTime).getTime();
  const last=vitalFairnessCheckedAt.get(simulationId);
  if(Number.isFinite(now)&&last!==undefined&&now-last<VITAL_FAIRNESS_CHECK_MINUTES*60000)return false;
  if(Number.isFinite(now))vitalFairnessCheckedAt.set(simulationId,now);
  return isVitalEnvironmentalEventDue(simulationId,simulationTime);
}

function eventProbability(elapsedSimulationMinutes, eventsPerSimulationHour = env.WORLD_EVENT_RATE_PER_SIM_HOUR) {
  const minutes = Math.max(0, Number(elapsedSimulationMinutes) || 0);
  const hourlyRate = Math.max(0, Number(eventsPerSimulationHour) || 0);
  return 1 - Math.exp(-(hourlyRate * minutes) / 60);
}

async function generateWorldEvents(simulationId,simulationTime,tickId,elapsedSimulationMinutes=0){
  await updateEnvironmentState(simulationId,simulationTime);
  const probability=eventProbability(elapsedSimulationMinutes);
  const randomEvent=Math.random()<=probability;
  const vitalDue=await checkVitalFairnessCached(simulationId,simulationTime);
  if(!randomEvent&&!vitalDue)return [];
  const eventId=await generateEnvironmentalEvent(simulationId,simulationTime,tickId);
  return eventId?[eventId]:[];
}

async function processWorldEffects(simulationId,simulationTime){
  return withEventWriteLock(simulationId, async conn => {
    const [rows]=await conn.query(`SELECT BIN_TO_UUID(id) AS id,metadata FROM events WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED' ORDER BY real_created_at`,[simulationId,simulationTime]);
    if(rows.length)await conn.query(`UPDATE events SET status='PROCESSED' WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED'`,[simulationId,simulationTime]);
    return rows;
  });
}
module.exports={generateWorldEvents,processWorldEffects,eventProbability,updateEnvironmentState};
