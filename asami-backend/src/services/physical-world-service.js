const { pool } = require("../db/pool");

const LOCATION_ENTITY_TYPE_ID = "00000000-0000-4000-8000-000000000003";

const LOCATION_RESOURCES = {
  HOME: { water: 24, food: 14, beds: 1, books: 4 }, PARK: { water: 30, food: 0, beds: 0, books: 0 },
  CAFE: { water: 80, food: 120, beds: 0, books: 8 }, GROCERY: { water: 160, food: 240, beds: 0, books: 0 },
  LIBRARY: { water: 24, food: 0, beds: 0, books: 180 }, SQUARE: { water: 20, food: 8, beds: 0, books: 0 },
  SCHOOL: { water: 40, food: 20, beds: 0, books: 80 }, COMMUNITY: { water: 35, food: 30, beds: 0, books: 30 },
  GYM: { water: 70, food: 10, beds: 0, books: 0 }, CLINIC: { water: 80, food: 10, beds: 1, books: 15 },
  NATURE: { water: 18, food: 0, beds: 0, books: 0 }, WORKSHOP: { water: 24, food: 8, beds: 0, books: 12 }
};

const LOCATION_OBJECTS = {
  HOME:["bed","refrigerator","table","bookshelf"], PARK:["bench","fountain","pond"],
  CAFE:["counter","tables","chairs","bookshelf","coffee_machine"], GROCERY:["shelves","checkout","refrigerated_case","produce_section"],
  LIBRARY:["bookshelves","reading_tables","chairs","water_fountain"], SQUARE:["benches","fountain","street_lamps"],
  SCHOOL:["classrooms","desks","library_shelves","water_fountain"], COMMUNITY:["meeting_room","chairs","kitchen","storage"],
  GYM:["treadmills","weights","lockers","water_fountain"], CLINIC:["reception","exam_room","beds","water_station"],
  NATURE:["trail","pond","benches","signposts"], WORKSHOP:["workbenches","tools","storage","safety_sink"]
};

// Emergency reserves are deliberately modest. They are a fail-safe, not a
// replacement for the normal environmental/resource economy.
const CRITICAL_RESOURCE_RESERVES = Object.freeze({
  water: 12,
  food: 8
});
const RESOURCE_EMERGENCY_TTL_MINUTES = 120;

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function clamp(value,min=0,max=Number.POSITIVE_INFINITY){return Math.max(min,Math.min(max,Number(value)||0));}
function normalizeWorldCode(value){return String(value||"").trim().toUpperCase();}
function addSimulationMinutes(value,minutes){const date=new Date(value);if(!Number.isFinite(date.getTime()))return value;return new Date(date.getTime()+Math.max(0,Number(minutes)||0)*60000).toISOString();}

async function locationRow(simulationId,locationId,db=pool){
  const [rows]=await db.query(
    \`SELECT BIN_TO_UUID(e.id) AS locationId,e.attributes,e.version,l.location_type AS locationType
     FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id
     WHERE e.simulation_id=UUID_TO_BIN(?) AND e.id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE'
     LIMIT 1\${db===pool?'':' FOR UPDATE'}\`,
    [simulationId,locationId,LOCATION_ENTITY_TYPE_ID]
  );
  return rows[0]||null;
}

async function updateLocationAttributes(simulationId,locationId,updater,db=pool){
  for(let attempt=0;attempt<3;attempt++){
    const row=await locationRow(simulationId,locationId,db);
    if(!row)return null;
    const next=updater(parseJson(row.attributes,{}));
    const[updated]=await db.query(
      \`UPDATE entities SET attributes=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?\`,
      [JSON.stringify(next),locationId,simulationId,Number(row.version||1)]
    );
    if(updated.affectedRows)return next;
  }
  return null;
}

async function seedPhysicalWorld(simulationId,simulationTime){
  const[rows]=await pool.query(
    \`SELECT BIN_TO_UUID(e.id) AS locationId,e.attributes,e.version,l.location_type AS locationType
     FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id
     WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE'\`,
    [simulationId,LOCATION_ENTITY_TYPE_ID]
  );
  for(const row of rows){
    const attributes=parseJson(row.attributes,{}),code=normalizeWorldCode(attributes.worldCode||row.locationType);
    if(!LOCATION_RESOURCES[code])continue;
    const resources=attributes.resources||{},objects=Array.isArray(attributes.objects)?attributes.objects:[],defaults=LOCATION_RESOURCES[code];
    const desiredResources=Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,Number.isFinite(Number(resources[k]))?Number(resources[k]):v]));
    const desiredObjects=objects.length?objects:(LOCATION_OBJECTS[code]||[]);
    const next={...attributes,resources:desiredResources,objects:desiredObjects,physicalUpdatedAt:simulationTime};
    if(JSON.stringify(resources)===JSON.stringify(desiredResources)&&JSON.stringify(objects)===JSON.stringify(desiredObjects))continue;
    await pool.query(
      \`UPDATE entities SET attributes=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?\`,
      [JSON.stringify(next),row.locationId,simulationId,Number(row.version||1)]
    );
  }
}

async function loadActiveLocations(simulationId){
  const[rows]=await pool.query(
    \`SELECT BIN_TO_UUID(e.id) AS locationId,e.attributes,e.version,l.location_type AS locationType,
            l.address_data AS addressData,l.latitude,l.longitude
     FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id
     WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE'\`,
    [simulationId,LOCATION_ENTITY_TYPE_ID]
  );
  return rows.map(row=>{
    const attributes=parseJson(row.attributes,{});
    return{
      locationId:row.locationId,
      locationType:row.locationType,
      worldCode:normalizeWorldCode(attributes.worldCode||row.locationType),
      data:parseJson(row.addressData,{}),
      resources:attributes.resources&&typeof attributes.resources==='object'?attributes.resources:{},
      resourceEmergencies:attributes.resourceEmergencies&&typeof attributes.resourceEmergencies==='object'?attributes.resourceEmergencies:{}
    };
  });
}

async function loadActorLocationIds(simulationId,entityId=null){
  const params=[simulationId];
  const entityFilter=entityId?" AND e.id=UUID_TO_BIN(?)":"";
  if(entityId)params.push(entityId);
  const[rows]=await pool.query(
    \`SELECT DISTINCT BIN_TO_UUID(elc.location_id) AS locationId
     FROM entity_locations_current elc
     JOIN entities e ON e.id=elc.entity_id AND e.simulation_id=elc.simulation_id
     JOIN entity_types et ON et.id=e.entity_type_id
     WHERE elc.simulation_id=UUID_TO_BIN(?)\${entityFilter}
       AND et.category='ACTOR'
       AND e.status NOT IN ('INACTIVE','DEAD')
       AND elc.location_id IS NOT NULL\`,
    params
  );
  return rows.map(row=>row.locationId).filter(Boolean);
}

function resolveLocation(byId,byCode,value){
  if(value===null||value===undefined)return null;
  const key=String(value);
  return byId.get(key)||byCode.get(normalizeWorldCode(key))||null;
}

function buildLocationGraph(locations){
  const byId=new Map(locations.map(location=>[String(location.locationId),location]));
  const byCode=new Map(locations.filter(location=>location.worldCode).map(location=>[location.worldCode,location]));
  return{byId,byCode};
}

function reachableLocations(locations,originId){
  if(!originId)return[];
  const{byId,byCode}=buildLocationGraph(locations),origin=byId.get(String(originId));
  if(!origin)return[];
  const visited=new Set([String(origin.locationId)]),queue=[origin],reachable=[];
  while(queue.length){
    const current=queue.shift();
    reachable.push(current);
    const connections=Array.isArray(current.data?.connections)?current.data.connections:[];
    for(const connection of connections){
      const next=resolveLocation(byId,byCode,connection);
      if(!next)continue;
      const nextId=String(next.locationId);
      if(visited.has(nextId))continue;
      visited.add(nextId);
      queue.push(next);
    }
  }
  return reachable;
}

function findReachableResource(locations,originId,resource){
  return reachableLocations(locations,originId).find(location=>Number(location.resources?.[resource]??0)>=1)||null;
}

async function ensureResourceReserveAtLocation({simulationId,locationId,resource,simulationTime,reason="NO_REACHABLE_RESOURCE",db=pool}){
  const reserve=Number(CRITICAL_RESOURCE_RESERVES[resource]);
  if(!Number.isFinite(reserve)||reserve<=0||!locationId)return{recovered:false,replenished:0,locationId,resource};
  let result={recovered:false,replenished:0,locationId,resource,reserve};
  const next=await updateLocationAttributes(simulationId,locationId,current=>{
    const resources={...(current.resources||{})};
    const available=clamp(resources[resource],0);
    if(available>=reserve)return current;
    const emergencies={...(current.resourceEmergencies||{})};
    emergencies[resource]={
      active:true,
      reason,
      triggeredAt:simulationTime,
      activeUntil:addSimulationMinutes(simulationTime,RESOURCE_EMERGENCY_TTL_MINUTES),
      reserve
    };
    resources[resource]=reserve;
    result={
      recovered:true,
      replenished:reserve-available,
      locationId,
      resource,
      reserve,
      reason
    };
    return{...current,resources,resourceEmergencies:emergencies,physicalUpdatedAt:simulationTime};
  },db);
  if(!next)return{recovered:false,replenished:0,locationId,resource,reserve};
  return result;
}

async function isCriticalResourceReachable(simulationId,entityId,resource){
  if(!simulationId||!entityId||!Object.prototype.hasOwnProperty.call(CRITICAL_RESOURCE_RESERVES,resource))return false;
  const locations=await loadActiveLocations(simulationId);
  if(!locations.length)return false;
  const actorLocations=await loadActorLocationIds(simulationId,entityId);
  const originId=actorLocations[0];
  return Boolean(originId&&findReachableResource(locations,originId,resource));
}

async function ensureCriticalResourceAvailability(simulationId,simulationTime,{entityId=null,resources=Object.keys(CRITICAL_RESOURCE_RESERVES)}={}){
  let locations=await loadActiveLocations(simulationId);
  if(!locations.length)return{recovered:[],checked:[],healthy:false};
  const actorLocationIds=await loadActorLocationIds(simulationId,entityId);
  const uniqueOrigins=[...new Set(actorLocationIds)];
  if(!uniqueOrigins.length){
    const fallback=["HOME","GROCERY","CAFE","CLINIC"].map(normalizeWorldCode);
    const candidate=locations.find(location=>fallback.includes(location.worldCode))||locations[0];
    uniqueOrigins.push(candidate.locationId);
  }

  const recovered=[],checked=[];
  for(const originId of uniqueOrigins){
    const origin=locations.find(location=>String(location.locationId)===String(originId));
    if(!origin)continue;
    for(const resource of resources){
      if(!Object.prototype.hasOwnProperty.call(CRITICAL_RESOURCE_RESERVES,resource))continue;
      checked.push({locationId:origin.locationId,resource});
      if(findReachableResource(locations,origin.locationId,resource))continue;
      const recovery=await ensureResourceReserveAtLocation({
        simulationId,
        locationId:origin.locationId,
        resource,
        simulationTime,
        reason:"NO_REACHABLE_RESOURCE"
      });
      if(recovery.recovered)recovered.push(recovery);
      const refreshed=await loadActiveLocations(simulationId);
      const nextLocations=refreshed.length?refreshed:locations;
      const stillReachable=findReachableResource(nextLocations,origin.locationId,resource);
      if(!stillReachable){
        throw Object.assign(
          new Error("Critical "+resource+" resource could not be restored at actor location"),
          {
            code:"CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE",
            resource,
            locationId:origin.locationId,
            needCode:resource==="water"?"THIRST":resource==="food"?"HUNGER":null,
            requiredAction:resource==="water"||resource==="food"?"WALKING":null
          }
        );
      }
    }
  }
  return{recovered,checked,healthy:true};
}

async function getLocationPhysicalState(simulationId,locationId){
  const row=await locationRow(simulationId,locationId);
  if(!row)return null;
  const a=parseJson(row.attributes,{});
  return{locationId,locationType:row.locationType,resources:a.resources||{},objects:Array.isArray(a.objects)?a.objects:[],resourceEmergencies:a.resourceEmergencies||{}};
}

async function consumeResource({simulationId,locationId,resource,amount,simulationTime,db=pool}){
  const quantity=Math.max(0,Number(amount)||0);
  if(!locationId||!resource||!quantity)return{ok:true,consumed:0,remaining:null,resource:resource||null};
  let result=null;
  const next=await updateLocationAttributes(simulationId,locationId,current=>{
    const resources={...(current.resources||{})},available=clamp(resources[resource]),consumed=Math.min(available,quantity);
    resources[resource]=available-consumed;
    result={ok:consumed>=quantity,consumed,remaining:resources[resource],resource};
    return{...current,resources,physicalUpdatedAt:simulationTime};
  },db);
  return next&&result?result:{ok:false,consumed:0,remaining:null,resource};
}

async function replenishResource({simulationId,locationId,resource,amount,simulationTime}){
  const quantity=Math.max(0,Number(amount)||0);
  if(!locationId||!resource||!quantity)return null;
  let remaining=null;
  const next=await updateLocationAttributes(simulationId,locationId,current=>{
    const resources={...(current.resources||{})};
    remaining=clamp(resources[resource])+quantity;
    resources[resource]=remaining;
    return{...current,resources,physicalUpdatedAt:simulationTime};
  });
  return next?remaining:null;
}

async function resolveActionResource({simulationId,locationId,actionType,simulationTime,conn=null}){
  const usage={DRINKING:{resource:"water",amount:1},EATING:{resource:"food",amount:1}}[actionType];
  if(!usage)return{ok:true,consumed:0,remaining:null,resource:null};
  const first=await consumeResource({simulationId,locationId,resource:usage.resource,amount:usage.amount,simulationTime,db:conn||pool});
  if(first.ok||first.remaining===null)return first;
  const emergency=await ensureResourceReserveAtLocation({
    simulationId,
    locationId,
    resource:usage.resource,
    simulationTime,
    reason:"ACTION_RESOURCE_RACE",
    db:conn||pool
  });
  if(!emergency.recovered)return first;
  const recovered=await consumeResource({simulationId,locationId,resource:usage.resource,amount:usage.amount,simulationTime,db:conn||pool});
  return recovered.ok
    ? {...recovered,emergencyRecovered:true,emergencyReason:emergency.reason,replenishedBy:emergency.replenished}
    : first;
}

module.exports={
  seedPhysicalWorld,
  getLocationPhysicalState,
  consumeResource,
  replenishResource,
  resolveActionResource,
  ensureCriticalResourceAvailability,
  ensureResourceReserveAtLocation,
  findReachableResource,
  reachableLocations,
  isCriticalResourceReachable,
  CRITICAL_RESOURCE_RESERVES,
  RESOURCE_EMERGENCY_TTL_MINUTES,
  LOCATION_RESOURCES,
  LOCATION_OBJECTS
};
