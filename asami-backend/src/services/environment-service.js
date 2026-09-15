const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent, addEffect } = require("./event-service");
const { replenishResource } = require("./physical-world-service");

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function clamp(v,min=0,max=1){return Math.max(min,Math.min(max,Number(v)||0));}
function hourOf(simulationTime){return new Date(simulationTime).getHours();}
function daylight(hour){if(hour<6)return 0.08;if(hour<8)return 0.35;if(hour<18)return 1;if(hour<21)return 0.45;return 0.12;}

const WEATHER={CLEAR:{temperature:20,humidity:.5,visibility:1},CLOUDY:{temperature:17,humidity:.62,visibility:.85},RAIN:{temperature:14,humidity:.9,visibility:.65},STORM:{temperature:12,humidity:.95,visibility:.4},HEAT:{temperature:32,humidity:.4,visibility:.9},COLD:{temperature:7,humidity:.55,visibility:.85}};
const BASE_BY_TYPE={PARK:{noise:.18,activity:.45},NATURE:{noise:.08,activity:.2},SQUARE:{noise:.55,activity:.65},CAFE:{noise:.5,activity:.75},GROCERY:{noise:.42,activity:.58},LIBRARY:{noise:.06,activity:.25},SCHOOL:{noise:.2,activity:.48},COMMUNITY:{noise:.22,activity:.4},GYM:{noise:.5,activity:.55},CLINIC:{noise:.12,activity:.3},WORKSHOP:{noise:.28,activity:.35},HOME:{noise:.08,activity:.15}};

async function loadLocations(simulationId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,e.attributes,l.location_type AS locationType FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id WHERE e.simulation_id=UUID_TO_BIN(?) AND l.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId,simulationId]);
  return rows;
}
async function updateLocation(simulationId,row,simulationTime){
  const attributes=parseJson(row.attributes,{}),previous=attributes.environment||{},type=row.locationType,base=BASE_BY_TYPE[type]||BASE_BY_TYPE.SQUARE,h=hourOf(simulationTime),weather=WEATHER[previous.weather]||WEATHER.CLEAR;
  const next={...previous,weather:previous.weather||"CLEAR",temperature:Number.isFinite(Number(previous.temperature))?Number(previous.temperature):weather.temperature,humidity:Number.isFinite(Number(previous.humidity))?Number(previous.humidity):weather.humidity,visibility:Number.isFinite(Number(previous.visibility))?Number(previous.visibility):weather.visibility,noise:clamp(base.noise+(weather===WEATHER.STORM?.3:0),0,1),activity:clamp(base.activity*(.45+daylight(h)*.55),0,1),daylight:daylight(h),updatedAt:simulationTime};
  if(h<6||h>21)next.activity=clamp(next.activity-.12);if(weather===WEATHER.RAIN)next.noise=clamp(next.noise+.08);if(weather===WEATHER.STORM)next.noise=clamp(next.noise+.2);
  await pool.query(`UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify({...attributes,environment:next}),row.locationId,simulationId,Number(row.version||1)]);
}

async function updateEnvironmentState(simulationId,simulationTime){const rows=await loadLocations(simulationId);for(const row of rows)await updateLocation(simulationId,row,simulationTime);return rows.length;}

const EVENTS={
  HOME:[['POWER_FLUCTUATION','The lights briefly flicker','A brief power fluctuation changes the indoor environment.','AMBIENT'],['DELIVERY','A delivery arrives nearby','A delivery vehicle stops in the residential area.','ACTIVITY']],
  PARK:[['RAIN','Rain begins to fall','A passing rain shower changes the park conditions.','WEATHER'],['WILDLIFE','Wildlife activity nearby','Birds and small animals become unusually active nearby.','WILDLIFE'],['MAINTENANCE','Park maintenance','Workers temporarily occupy part of the park.','HUMAN_ACTIVITY']],
  CAFE:[['CROWD','The cafe becomes crowded','A sudden influx of visitors raises noise and social activity.','SOCIAL'],['SUPPLY','Cafe supply delivery','Fresh food and drinks are delivered to the cafe.','ECONOMIC']],
  GROCERY:[['BUSY_HOUR','The shop gets busy','Customers arrive in a short burst.','ECONOMIC'],['RESTOCK','Shelves are restocked','A delivery replenishes essential supplies.','ECONOMIC']],
  LIBRARY:[['QUIET','The library grows quiet','The ambient noise drops as visitors settle down.','AMBIENT'],['BOOK_RETURN','A cart of returned books arrives','Recently returned books become available.','OBJECT']],
  SQUARE:[['CROWD','A crowd gathers','People gather briefly in the square.','SOCIAL'],['STREET_NOISE','Traffic noise rises','Nearby traffic temporarily increases noise.','AMBIENT']],
  SCHOOL:[['CLASS_CHANGE','A class change begins','People move through the building between activities.','HUMAN_ACTIVITY'],['DRILL','A scheduled drill occurs','A brief building drill interrupts normal activity.','SAFETY']],
  COMMUNITY:[['MEETING','A community meeting starts','A local gathering increases activity.','SOCIAL'],['WORKSHOP_EVENT','A public workshop starts','A practical activity brings people together.','HUMAN_ACTIVITY']],
  GYM:[['BUSY_HOUR','The gym fills up','More visitors arrive and activity rises.','SOCIAL'],['EQUIPMENT','Exercise equipment is serviced','Part of the gym becomes temporarily unavailable.','MAINTENANCE']],
  CLINIC:[['APPOINTMENT_RUSH','The clinic gets busy','A burst of appointments increases activity.','HUMAN_ACTIVITY'],['POWER_FLUCTUATION','Medical equipment briefly restarts','A minor power fluctuation triggers equipment checks.','AMBIENT']],
  NATURE:[['STORM','A storm approaches','Wind and heavy clouds change the trail conditions.','WEATHER'],['WILDLIFE','Wildlife crosses the trail','An animal briefly crosses the path.','WILDLIFE']],
  WORKSHOP:[['DELIVERY','Materials are delivered','A shipment of workshop materials arrives.','ECONOMIC'],['NOISE','Workshop noise rises','Tools and machinery temporarily make the area louder.','AMBIENT']]
};

function chooseEvent(type){const list=EVENTS[type]||EVENTS.SQUARE;return list[Math.floor(Math.random()*list.length)];}
async function generateEnvironmentalEvent(simulationId,simulationTime,tickId){
  const rows=await loadLocations(simulationId);if(!rows.length)return null;
  const row=rows[Math.floor(Math.random()*rows.length)],attrs=parseJson(row.attributes,{}),weather=attrs.environment?.weather||'CLEAR';let [eventCode,title,description,effectType]=chooseEvent(row.locationType);
  if(eventCode==='RAIN'){await updateWeather(simulationId,row,'RAIN',simulationTime);await replenishResource({simulationId,locationId:row.locationId,resource:'water',amount:4,simulationTime});}
  if(eventCode==='STORM')await updateWeather(simulationId,row,'STORM',simulationTime);
  if(eventCode==='RESTOCK'){await replenishResource({simulationId,locationId:row.locationId,resource:'food',amount:30,simulationTime});await replenishResource({simulationId,locationId:row.locationId,resource:'water',amount:20,simulationTime});}
  if(eventCode==='SUPPLY'||eventCode==='DELIVERY')await replenishResource({simulationId,locationId:row.locationId,resource:'food',amount:20,simulationTime});
  if(eventCode==='BOOK_RETURN')await replenishResource({simulationId,locationId:row.locationId,resource:'books',amount:10,simulationTime});
  const eventId=await createEvent({simulationId,eventTypeCode:effectType==='SOCIAL'?'SOCIAL':'ENVIRONMENTAL',title,description:row.locationType+': '+description,simulationAt:simulationTime,importance:.25,sourceTickId:tickId,metadata:{environmental:true,eventCode,effectType,locationId:row.locationId,locationType:row.locationType,previousWeather:weather},participants:[]});
  await addEffect({simulationId,eventId,effectType,targetEntityId:null,afterState:{environmental:true,eventCode,locationId:row.locationId,locationType:row.locationType},magnitude:.25,createdSimulationAt:simulationTime});
  return eventId;
}
async function updateWeather(simulationId,row,weather,simulationTime){const attributes=parseJson(row.attributes,{}),environment={...(attributes.environment||{}),weather,temperature:WEATHER[weather]?.temperature??20,humidity:WEATHER[weather]?.humidity??.5,visibility:WEATHER[weather]?.visibility??1,lastWeatherChangeAt:simulationTime};await pool.query(`UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,[JSON.stringify({...attributes,environment}),row.locationId,simulationId,Number(row.version||1)]);}

module.exports={updateEnvironmentState,generateEnvironmentalEvent,EVENTS,WEATHER};
