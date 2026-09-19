const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { ensureEntityState } = require("./state-service");

const MIN_WORLD_PEOPLE = 6;
const MAX_WORLD_PEOPLE = 10;
const LOCATION_ENTITY_TYPE_ID = "00000000-0000-4000-8000-000000000003";
const PERSON_ENTITY_TYPE_ID = "00000000-0000-4000-8000-000000000001";
const PARTNER_RELATIONSHIP_TYPE_ID = "00000000-0000-4000-8007-000000000011";

const WORLD_LOCATIONS = [
  { code:"HOME", name:"Asami's Home", type:"HOME", lat:45.0700, lon:7.6800, description:"A quiet apartment in the residential district.", connections:["PARK","CAFE","GROCERY","LIBRARY"] },
  { code:"PARK", name:"Riverside Park", type:"PARK", lat:45.0712, lon:7.6840, description:"A green public park with paths, benches and a small pond.", connections:["HOME","CAFE","SQUARE","TRAIL"] },
  { code:"CAFE", name:"Luna Cafe", type:"CAFE", lat:45.0694, lon:7.6858, description:"A social cafe where people meet, talk and spend time.", connections:["HOME","PARK","SQUARE","LIBRARY"] },
  { code:"GROCERY", name:"Mercato Verde", type:"SHOP", lat:45.0678, lon:7.6818, description:"A neighborhood grocery store with food and drinks.", connections:["HOME","SQUARE","CLINIC"] },
  { code:"LIBRARY", name:"City Library", type:"LIBRARY", lat:45.0688, lon:7.6882, description:"A quiet library for reading and studying.", connections:["HOME","CAFE","SQUARE","SCHOOL"] },
  { code:"SQUARE", name:"Central Square", type:"SQUARE", lat:45.0685, lon:7.6847, description:"The main public square, busy during the day and evening.", connections:["PARK","CAFE","GROCERY","LIBRARY","COMMUNITY"] },
  { code:"SCHOOL", name:"Community School", type:"SCHOOL", lat:45.0665, lon:7.6902, description:"A school and learning center.", connections:["LIBRARY","COMMUNITY","GYM"] },
  { code:"COMMUNITY", name:"Community Center", type:"COMMUNITY", lat:45.0658, lon:7.6868, description:"A place for clubs, classes and local gatherings.", connections:["SQUARE","SCHOOL","GYM","WORKSHOP"] },
  { code:"GYM", name:"Pulse Gym", type:"GYM", lat:45.0644, lon:7.6910, description:"A small neighborhood gym and sports space.", connections:["SCHOOL","COMMUNITY","CLINIC","TRAIL"] },
  { code:"CLINIC", name:"Neighborhood Clinic", type:"CLINIC", lat:45.0660, lon:7.6808, description:"A small clinic and health service.", connections:["GROCERY","GYM","SQUARE","WORKSHOP"] },
  { code:"TRAIL", name:"Woodland Trail", type:"NATURE", lat:45.0618, lon:7.6880, description:"A wooded trail at the edge of the neighborhood.", connections:["PARK","GYM","WORKSHOP"] },
  { code:"WORKSHOP", name:"Makers Workshop", type:"WORKSHOP", lat:45.0630, lon:7.6825, description:"A practical workshop used for crafts and projects.", connections:["COMMUNITY","CLINIC","TRAIL"] }
];

const NPC_PROFILES = [
  { firstName:"Maya", lastName:"Rossi", description:"Outgoing, curious and socially active.", preferred:"CAFE", traits:{EXTRAVERSION:.78,SOCIABILITY:.82,OPENNESS:.68,CURIOSITY:.72,CONFIDENCE:.64,EMPATHY:.62,IMPULSIVITY:.55} },
  { firstName:"Luca", lastName:"Bianchi", description:"Calm, practical and quietly ambitious.", preferred:"WORKSHOP", traits:{EXTRAVERSION:.42,SOCIABILITY:.46,OPENNESS:.55,CURIOSITY:.60,CONSCIENTIOUSNESS:.78,DISCIPLINE:.80,PATIENCE:.72} },
  { firstName:"Elena", lastName:"Conti", description:"Reflective, artistic and observant.", preferred:"LIBRARY", traits:{EXTRAVERSION:.50,SOCIABILITY:.58,OPENNESS:.82,CURIOSITY:.78,CREATIVITY:.84,EMPATHY:.72,PATIENCE:.64} },
  { firstName:"Davide", lastName:"Ferrari", description:"Energetic, playful and competitive.", preferred:"GYM", traits:{EXTRAVERSION:.72,SOCIABILITY:.70,OPENNESS:.58,IMPULSIVITY:.72,CONFIDENCE:.76} },
  { firstName:"Sara", lastName:"Romano", description:"Independent, warm and selective about close bonds.", preferred:"PARK", traits:{EXTRAVERSION:.48,SOCIABILITY:.52,OPENNESS:.66,EMPATHY:.80,INDEPENDENCE:.78,PATIENCE:.68} }
];

const RANDOM_FIRST = ["Nora","Matteo","Chiara","Andrea","Giada","Tommaso","Alice","Pietro","Irene","Federico"];
const RANDOM_LAST = ["Greco","Costa","Marino","Gallo","Fontana","Moretti","De Luca","Riva","Serra","Ferri"];

function randomBetween(min,max){ return min + Math.random()*(max-min); }
function pick(list){ return list[Math.floor(Math.random()*list.length)]; }
function parseJson(value,fallback={}){ if(value===null||value===undefined)return fallback; if(typeof value==='object')return value; try{return JSON.parse(value);}catch{return fallback;} }

async function ensurePartnerType(){
  await pool.query(`INSERT INTO relationship_types(id,code,name,symmetric,configuration,active) VALUES(UUID_TO_BIN(?),'PARTNER','Partner',1,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name),symmetric=VALUES(symmetric),configuration=VALUES(configuration),active=1`,[PARTNER_RELATIONSHIP_TYPE_ID,JSON.stringify({romantic:true})]);
}
async function getLocationRows(simulationId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,e.display_name AS name,e.attributes,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=UUID_TO_BIN(?) WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE' ORDER BY e.created_simulation_at`,[simulationId,simulationId,LOCATION_ENTITY_TYPE_ID]);
  return rows;
}
async function seedLocations(simulationId,simulationTime){
  for(const location of WORLD_LOCATIONS){
    const [existing]=await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND entity_type_id=UUID_TO_BIN(?) AND display_name=? LIMIT 1`,[simulationId,LOCATION_ENTITY_TYPE_ID,location.name]);
    if(existing.length)continue;
    const entityId=uuid();
    await pool.query(`INSERT INTO entities(id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'ACTIVE', ?, ?,1)`,[entityId,simulationId,LOCATION_ENTITY_TYPE_ID,location.name,location.description,JSON.stringify({worldCode:location.code,connections:location.connections}),simulationTime]);
    await pool.query(`INSERT INTO locations(entity_id,simulation_id,location_type,latitude,longitude,address_data) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,[entityId,simulationId,location.type,location.lat,location.lon,JSON.stringify({worldCode:location.code,description:location.description,connections:location.connections})]);
  }
  return getLocationRows(simulationId);
}
async function assignLocation(simulationId,entityId,locationId,simulationTime,reason="WORLD_SPAWN"){
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [existing]=await conn.query(`SELECT BIN_TO_UUID(location_id) AS locationId,version FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,[simulationId,entityId]);
    if(existing.length&&String(existing[0].locationId)===String(locationId)){
      await conn.commit();
      return;
    }
    if(existing.length){
      const previousLocationId=existing[0].locationId;
      await conn.query(`UPDATE entity_location_history SET exited_simulation_at=? WHERE entity_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND exited_simulation_at IS NULL AND entered_simulation_at<?`,[simulationTime,entityId,previousLocationId,simulationTime]);
      const [updated]=await conn.query(`UPDATE entity_locations_current SET location_id=UUID_TO_BIN(?),since_simulation_at=?,reason=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND version=?`,[locationId,simulationTime,reason,simulationId,entityId,existing[0].version]);
      if(!updated.affectedRows)throw Object.assign(new Error("Location assignment changed concurrently"),{code:"OPTIMISTIC_LOCK"});
    }else{
      await conn.query(`INSERT INTO entity_locations_current(entity_id,simulation_id,location_id,since_simulation_at,reason,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,1)`,[entityId,simulationId,locationId,simulationTime,reason]);
    }
    await conn.query(`INSERT INTO entity_location_history(id,entity_id,location_id,entered_simulation_at,reason,source_event_id) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,NULL)`,[uuid(),entityId,locationId,simulationTime,reason]);
    await conn.commit();
  }catch(err){
    try{await conn.rollback();}catch{}
    throw err;
  }finally{
    conn.release();
  }
}
async function findAsami(simulationId){ const [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND entity_type_id=UUID_TO_BIN(?) AND LOWER(display_name)='asami' AND status<>'DEAD' LIMIT 1`,[simulationId,PERSON_ENTITY_TYPE_ID]); return rows[0]?.id||null; }
async function createPerson(simulationId,simulationTime,profile,randomSpawn=false){
  const firstName=profile?.firstName||pick(RANDOM_FIRST),lastName=profile?.lastName||pick(RANDOM_LAST); let displayName=`${firstName} ${lastName}`;
  for(let i=0;i<4;i++){ const [same]=await pool.query(`SELECT id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND display_name=? LIMIT 1`,[simulationId,displayName]); if(!same.length)break; displayName=`${firstName} ${lastName} ${Math.floor(randomBetween(2,99))}`; }
  const entityId=uuid(); const attributes={worldResident:true,npc:true,role:"NEIGHBOR",profile:profile?.description||"A person living in the neighborhood.",interests:profile?.preferred?[profile.preferred]:[],personalitySeed:profile?.traits||{}};
  await pool.query(`INSERT INTO entities(id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'ACTIVE', ?, ?,1)`,[entityId,simulationId,PERSON_ENTITY_TYPE_ID,displayName,attributes.profile,JSON.stringify(attributes),simulationTime]);
  const ageDays=Math.floor(randomBetween(20*365,45*365)),birthAt=new Date(new Date(simulationTime).getTime()-ageDays*86400000);
  await pool.query(`INSERT INTO persons(entity_id,first_name,last_name,birth_simulation_at,sex,gender,education_level) VALUES(UUID_TO_BIN(?),?,?,?,?,?,?)`,[entityId,firstName,lastName,birthAt,null,null,null]);
  await pool.query(`INSERT INTO autonomy_policies(id,simulation_id,entity_id,policy_type,enabled,configuration,scope_entity_id,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'AUTONOMY',1,?,UUID_TO_BIN(?),1)`,[uuid(),simulationId,entityId,JSON.stringify({deterministicFallback:true,decisionMode:"deterministic_npc"}),entityId]);
  await ensureEntityState(entityId,simulationTime);
  if(profile?.traits){ for(const [code,value] of Object.entries(profile.traits)){ const [trait]=await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM trait_definitions WHERE code=? AND active=1 LIMIT 1`,[code]); if(trait.length)await pool.query(`UPDATE entity_traits_current SET value=?,updated_simulation_at=?,version=version+1 WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?)`,[Math.max(0,Math.min(1,Number(value))),simulationTime,entityId,trait[0].id]); } }
  await pool.query(`INSERT INTO entity_development(entity_id,development_stage_id,physical_score,cognitive_score,social_score,emotional_score,education_score,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),NULL,?,?,?,?,?, ?,1)`,[entityId,.5,.5,.5,.5,.5,simulationTime]);
  return {id:entityId,displayName};
}
async function ensurePopulation(simulationId,simulationTime){
  const [rows]=await pool.query(`SELECT COUNT(*) AS count FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND entity_type_id=UUID_TO_BIN(?) AND status='ACTIVE' AND display_name<>'Observer'`,[simulationId,PERSON_ENTITY_TYPE_ID]);
  let count=Number(rows[0]?.count||0),created=[];
  for(const profile of NPC_PROFILES){ if(count>=MIN_WORLD_PEOPLE)break; const [exists]=await pool.query(`SELECT id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND display_name=? LIMIT 1`,[simulationId,`${profile.firstName} ${profile.lastName}`]); if(exists.length)continue; created.push(await createPerson(simulationId,simulationTime,profile,false)); count++; }
  while(count<MIN_WORLD_PEOPLE){created.push(await createPerson(simulationId,simulationTime,null,true));count++;}
  if(count<MAX_WORLD_PEOPLE && Math.random()<0.001)created.push(await createPerson(simulationId,simulationTime,null,true));
  return created;
}
async function ensureWorld(simulationId,simulationTime){
  await ensurePartnerType(); const locations=await seedLocations(simulationId,simulationTime); const asamiId=await findAsami(simulationId);
  if(asamiId){ const home=locations.find(l=>parseJson(l.addressData).worldCode==='HOME'); if(home){ const [current]=await pool.query(`SELECT location_id FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,asamiId]); if(!current.length)await assignLocation(simulationId,asamiId,home.locationId,simulationTime,"WORLD_INITIALIZATION"); } }
  const created=await ensurePopulation(simulationId,simulationTime),refreshed=await getLocationRows(simulationId);
  for(const person of created){ const preferred=NPC_PROFILES.find(p=>`${p.firstName} ${p.lastName}`===person.displayName)?.preferred; const loc=refreshed.find(l=>parseJson(l.addressData).worldCode===preferred)||pick(refreshed); if(loc)await assignLocation(simulationId,person.id,loc.locationId,simulationTime,"WORLD_SPAWN"); }
  const [unplaced]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id FROM entities e WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM entity_locations_current elc WHERE elc.simulation_id=e.simulation_id AND elc.entity_id=e.id) LIMIT 50`,[simulationId,PERSON_ENTITY_TYPE_ID]);
  for(const row of unplaced){const loc=pick(refreshed);if(loc)await assignLocation(simulationId,row.id,loc.locationId,simulationTime,"WORLD_REPAIR");}
  return {locationCount:refreshed.length,createdPeople:created.length};
}
async function evolveRelationships(simulationId,simulationTime){ const {maintainRelationships}=require("./social-relationship-service"); return maintainRelationships(simulationId,simulationTime); }
async function endRelationship(relationshipId,simulationTime,reason){ const {endRelationship:endSocialRelationship}=require("./social-relationship-service"); return endSocialRelationship(relationshipId,simulationTime,reason); }
module.exports={ensureWorld,evolveRelationships,endRelationship,seedLocations,ensurePopulation,MIN_WORLD_PEOPLE,MAX_WORLD_PEOPLE,WORLD_LOCATIONS};
