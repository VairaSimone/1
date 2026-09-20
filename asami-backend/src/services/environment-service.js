const { pool } = require("../db/pool");
const { createEvent, addEffect } = require("./event-service");
const { replenishResource } = require("./physical-world-service");

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function clamp(v,min=0,max=1){return Math.max(min,Math.min(max,Number(v)||0));}
function hourOf(simulationTime){return new Date(simulationTime).getUTCHours();}
function daylight(hour){if(hour<6)return .08;if(hour<8)return .35;if(hour<18)return 1;if(hour<21)return .45;return .12;}
const WEATHER={CLEAR:{temperature:20,humidity:.5,visibility:1},CLOUDY:{temperature:17,humidity:.62,visibility:.85},RAIN:{temperature:14,humidity:.9,visibility:.65},STORM:{temperature:12,humidity:.95,visibility:.4},HEAT:{temperature:32,humidity:.4,visibility:.9},COLD:{temperature:7,humidity:.55,visibility:.85}};
const WEATHER_DURATIONS_HOURS={RAIN:3,STORM:6};
const BASE_BY_TYPE={PARK:{noise:.18,activity:.45},NATURE:{noise:.08,activity:.2},SQUARE:{noise:.55,activity:.65},CAFE:{noise:.5,activity:.75},SHOP:{noise:.42,activity:.58},LIBRARY:{noise:.06,activity:.25},SCHOOL:{noise:.2,activity:.48},COMMUNITY:{noise:.22,activity:.4},GYM:{noise:.5,activity:.55},CLINIC:{noise:.12,activity:.3},WORKSHOP:{noise:.28,activity:.35},HOME:{noise:.08,activity:.15}};
const EVENTS={HOME:[['POWER_FLUCTUATION','The lights briefly flicker','A brief power fluctuation changes the indoor environment.','AMBIENT'],['DELIVERY','A delivery arrives nearby','A delivery vehicle stops in the residential area.','ACTIVITY']],PARK:[['RAIN','Rain begins to fall','A passing rain shower changes the park conditions.','WEATHER'],['WILDLIFE','Wildlife stirs nearby','Birds and small animals become unusually active nearby.','WILDLIFE'],['MAINTENANCE','Park maintenance','Workers temporarily occupy part of the park.','HUMAN_ACTIVITY']],CAFE:[['CROWD','The cafe becomes crowded','A sudden influx of visitors raises noise and social activity.','SOCIAL'],['SUPPLY','Cafe supply delivery','Fresh food and drinks are delivered to the cafe.','ECONOMIC']],SHOP:[['BUSY_HOUR','The shop gets busy','Customers arrive in a short burst.','ECONOMIC'],['RESTOCK','Shelves are restocked','A delivery replenishes essential supplies.','ECONOMIC']],LIBRARY:[['QUIET','The library grows quiet','The ambient noise drops as visitors settle down.','AMBIENT'],['BOOK_RETURN','A cart of returned books arrives','Recently returned books become available.','OBJECT']],SQUARE:[['CROWD','A crowd gathers','People gather briefly in the square.','SOCIAL'],['STREET_NOISE','Traffic noise rises','Nearby traffic temporarily increases noise.','AMBIENT']],SCHOOL:[['CLASS_CHANGE','A class change begins','People move through the building between activities.','HUMAN_ACTIVITY'],['DRILL','A scheduled drill occurs','A brief building drill interrupts normal activity.','SAFETY']],COMMUNITY:[['MEETING','A community meeting starts','A local gathering increases activity.','SOCIAL'],['WORKSHOP_EVENT','A public workshop starts','A practical activity brings people together.','HUMAN_ACTIVITY']],GYM:[['BUSY_HOUR','The gym fills up','More visitors arrive and activity rises.','SOCIAL'],['EQUIPMENT','Exercise equipment is serviced','Part of the gym becomes temporarily unavailable.','MAINTENANCE']],CLINIC:[['APPOINTMENT_RUSH','The clinic gets busy','A burst of appointments increases activity.','HUMAN_ACTIVITY'],['POWER_FLUCTUATION','Medical equipment briefly restarts','A minor power fluctuation triggers equipment checks.','AMBIENT']],NATURE:[['STORM','A storm approaches','Wind and heavy clouds change the trail conditions.','WEATHER'],['WILDLIFE','Wildlife crosses the trail','An animal briefly crosses the path.','WILDLIFE']],WORKSHOP:[['DELIVERY','Materials are delivered','A shipment of workshop materials arrives.','ECONOMIC'],['NOISE','Workshop noise rises','Tools and machinery temporarily make the area louder.','AMBIENT']]};
function chooseEvent(type){const list=EVENTS[type]||EVENTS.SQUARE;return list[Math.floor(Math.random()*list.length)];}
const FAIR_EVENT_MAX_GAP_HOURS=24;
const FAIR_EVENT_NORMALIZATION_HOURS=72;
const VITAL_EVENT_CODES=new Set(["RAIN","RESTOCK","SUPPLY","DELIVERY"]);

async function loadEventFairness(simulationId){
  const [rows]=await pool.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.locationId')) AS locationId,
            MAX(simulation_at) AS lastEventAt
     FROM events
     WHERE simulation_id=UUID_TO_BIN(?)
       AND status<>'CANCELLED'
       AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.environmental'))='true'
       AND JSON_EXTRACT(metadata,'$.locationId') IS NOT NULL
     GROUP BY JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.locationId'))`,
    [simulationId]
  );
  return new Map(rows.map(row=>[String(row.locationId),row.lastEventAt]));
}

function fairnessScore(location,lastEventAt,nowMs){
  const resources=parseJson(location.attributes,{}).resources||{};
  const lastMs=new Date(lastEventAt||0).getTime();
  const ageHours=Number.isFinite(lastMs)&&lastMs>0
    ? Math.max(0,(nowMs-lastMs)/3600000)
    : FAIR_EVENT_NORMALIZATION_HOURS;
  const waterDeficit=Math.max(0,4-Number(resources.water||0))/4;
  const foodDeficit=Math.max(0,2-Number(resources.food||0))/2;
  const deficit=Math.min(1,waterDeficit*.55+foodDeficit*.45);
  const fairness=Math.min(1,ageHours/FAIR_EVENT_NORMALIZATION_HOURS);
  const vitalBoost=ageHours>=FAIR_EVENT_MAX_GAP_HOURS&&deficit>0 ? .8 : 0;
  return{score:fairness+deficit*.55+vitalBoost+Math.random()*.12,ageHours,deficit,vitalBoost};
}

async function selectFairEnvironmentalLocation(simulationId,locations,simulationTime){
  if(!locations.length)return null;
  const lastEvents=await loadEventFairness(simulationId);
  const nowMs=new Date(simulationTime).getTime();
  let best=null;
  for(const location of locations){
    const fairness=fairnessScore(location,lastEvents.get(String(location.locationId)),nowMs);
    if(!best||fairness.score>best.fairness.score)best={location,fairness};
  }
  return best;
}

function chooseFairEvent(type,forceVital=false){
  const list=EVENTS[type]||EVENTS.SQUARE;
  if(!forceVital)return list[Math.floor(Math.random()*list.length)];
  const vital=list.filter(item=>VITAL_EVENT_CODES.has(item[0]));
  return (vital.length?vital:list)[Math.floor(Math.random()*(vital.length?vital:list).length)];
}

async function loadLocations(simulationId){const [rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,e.attributes,e.version,l.location_type AS locationType FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id WHERE e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId]);return rows;}
async function updateEnvironmentState(simulationId,simulationTime){const rows=await loadLocations(simulationId),hour=hourOf(simulationTime),light=daylight(hour),nowMs=new Date(simulationTime).getTime();for(const row of rows){const attributes=parseJson(row.attributes,{}),previous=attributes.environment||{};let weatherCode=previous.weather||'CLEAR';const lastWeatherChangeMs=new Date(previous.lastWeatherChangeAt||0).getTime(),durationHours=WEATHER_DURATIONS_HOURS[weatherCode];if(durationHours&&Number.isFinite(nowMs)&&Number.isFinite(lastWeatherChangeMs)&&nowMs-lastWeatherChangeMs>=durationHours*3600000)weatherCode='CLEAR';const weather=WEATHER[weatherCode]||WEATHER.CLEAR,base=BASE_BY_TYPE[row.locationType]||BASE_BY_TYPE.SQUARE;const next={...previous,weather:weatherCode,temperature:Number.isFinite(Number(previous.temperature))&&weatherCode===previous.weather?Number(previous.temperature):weather.temperature,humidity:Number.isFinite(Number(previous.humidity))&&weatherCode===previous.weather?Number(previous.humidity):weather.humidity,visibility:Number.isFinite(Number(previous.visibility))&&weatherCode===previous.weather?Number(previous.visibility):weather.visibility,noise:clamp(base.noise+(weatherCode==='RAIN'?.08:weatherCode==='STORM'?.2:0)),activity:clamp(base.activity*(.45+light*.55)),daylight:light,updatedAt:simulationTime};if(weatherCode==='CLEAR'&&previous.weather!==weatherCode)next.lastWeatherChangeAt=simulationTime;if(hour<6||hour>21)next.activity=clamp(next.activity-.12);await pool.query(`UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify({...attributes,environment:next}),row.locationId,simulationId,Number(row.version||1)]);}return rows.length;}
async function updateWeather(simulationId,locationId,simulationTime,weatherCode){const row=(await loadLocations(simulationId)).find(x=>x.locationId===locationId);if(!row)return;const attributes=parseJson(row.attributes,{}),weather=WEATHER[weatherCode]||WEATHER.CLEAR,environment={...(attributes.environment||{}),weather:weatherCode,temperature:weather.temperature,humidity:weather.humidity,visibility:weather.visibility,lastWeatherChangeAt:simulationTime};await pool.query(`UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify({...attributes,environment}),row.locationId,simulationId,Number(row.version||1)]);}
async function generateEnvironmentalEvent(simulationId,simulationTime,tickId){
  const rows=await loadLocations(simulationId);
  if(!rows.length)return null;
  const selected=await selectFairEnvironmentalLocation(simulationId,rows,simulationTime);
  if(!selected)return null;
  const row=selected.location;
  const forceVital=selected.fairness.ageHours>=FAIR_EVENT_MAX_GAP_HOURS&&selected.fairness.deficit>0;
  const [eventCode,title,description,effectType]=chooseFairEvent(row.locationType,forceVital);if(eventCode==='RAIN'){await updateWeather(simulationId,row.locationId,simulationTime,'RAIN');await replenishResource({simulationId,locationId:row.locationId,resource:'water',amount:4,simulationTime});}if(eventCode==='STORM')await updateWeather(simulationId,row.locationId,simulationTime,'STORM');if(eventCode==='RESTOCK'){await replenishResource({simulationId,locationId:row.locationId,resource:'food',amount:30,simulationTime});await replenishResource({simulationId,locationId:row.locationId,resource:'water',amount:20,simulationTime});}if(eventCode==='SUPPLY'||eventCode==='DELIVERY')await replenishResource({simulationId,locationId:row.locationId,resource:'food',amount:20,simulationTime});if(eventCode==='BOOK_RETURN')await replenishResource({simulationId,locationId:row.locationId,resource:'books',amount:10,simulationTime});const eventId=await createEvent({simulationId,eventTypeCode:effectType==='SOCIAL'?'SOCIAL':'ENVIRONMENTAL',title,description:`${row.locationType}: ${description}`,simulationAt:simulationTime,importance:.25,sourceTickId:tickId,metadata:{environmental:true,eventCode,effectType,locationId:row.locationId,locationType:row.locationType,worldCode:parseJson(row.attributes).worldCode||null,fairness:{ageHours:Number(selected.fairness.ageHours.toFixed(2)),resourceDeficit:Number(selected.fairness.deficit.toFixed(3)),forcedVital:forceVital}},participants:[]});await addEffect({simulationId,eventId,effectType,targetEntityId:row.locationId,afterState:{environmental:true,eventCode,locationId:row.locationId,locationType:row.locationType},magnitude:.25,createdSimulationAt:simulationTime});return eventId;}
async function processWorldEffects(simulationId,simulationTime){const [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,metadata FROM events WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED' ORDER BY real_created_at`,[simulationId,simulationTime]);if(rows.length)await pool.query(`UPDATE events SET status='PROCESSED' WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at=? AND status='RECORDED'`,[simulationId,simulationTime]);return rows;}
module.exports={updateEnvironmentState,generateEnvironmentalEvent,processWorldEffects,eventProbability:(elapsedSimulationMinutes,eventsPerSimulationHour=1)=>1-Math.exp(-(Math.max(0,Number(elapsedSimulationMinutes)||0)*Math.max(0,Number(eventsPerSimulationHour)||0))/60),WEATHER,EVENTS};