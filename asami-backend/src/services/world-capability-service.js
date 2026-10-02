const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const DEFAULTS={
  BUY_FOOD:{name:"Buy food",category:"ECONOMY",needWeights:{HUNGER:2.9},gate:["HUNGER",.25],durationMinutes:25,effect:{type:"BUY_FOOD",good:"FOOD",quantity:1}},
  WORK_JOB:{name:"Work a local job",category:"WORK",needWeights:{ACHIEVEMENT:1.8},gate:["ACHIEVEMENT",.22],durationMinutes:120,effect:{type:"WORK_JOB"}},
  ATTEND_COMMUNITY:{name:"Join a community activity",category:"SOCIAL",needWeights:{BELONGING:1.7,FUN:.7},gate:["BELONGING",.28],durationMinutes:60,effect:{type:"SOCIAL_ACTIVITY"}},
  PRODUCE_GOODS:{name:"Produce goods",category:"PRODUCTION",needWeights:{ACHIEVEMENT:1.5,CURIOSITY:.4},gate:["ACHIEVEMENT",.25],durationMinutes:180,effect:{type:"PRODUCE_GOODS"}}
};

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value)}catch{return fallback}}
function normalize(value){return String(value||"").trim().toUpperCase()}

function normalizeDefinition(row){
  const parameters=parseJson(row.parameters,{});
  return {
    id:row.id||null,code:normalize(row.code),name:row.name||normalize(row.code),category:row.category||"GENERAL",
    locationId:row.locationId||null,sourceEntityId:row.sourceEntityId||null,
    parameters:{...(DEFAULTS[normalize(row.code)]||{}),...parameters},active:Boolean(Number(row.active??1))
  };
}

async function ensureCapabilitiesForEmergentStructures(simulationId,simulationTime){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) scopeLocationId,es.structure_type structureType,es.activities FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,[simulationId]);
  const mappings={MARKET:["BUY_FOOD","WORK_JOB"],WORKSHOP:["WORK_JOB","PRODUCE_GOODS"],COMMUNITY_HUB:["ATTEND_COMMUNITY"]};
  let created=0;
  for(const row of rows){
    const codes=[...new Set([...(mappings[normalize(row.structureType)]||[]),...parseJson(row.activities,[]).map(normalize).filter(Boolean)])];
    for(const code of codes){
      const defaults=DEFAULTS[code]||{name:code.replaceAll("_"," ").toLowerCase(),category:"EMERGENT",needWeights:{},durationMinutes:45,effect:{type:"GENERIC"}};
      const [existing]=await pool.query(`SELECT id FROM world_capabilities WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND code=? LIMIT 1`,[simulationId,row.entityId,code]);
      if(existing.length)continue;
      await pool.query(`INSERT INTO world_capabilities (id,simulation_id,location_id,source_entity_id,code,name,category,parameters,active,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,1,?,1)`,
        [uuid(),simulationId,row.entityId,row.entityId,code,defaults.name,defaults.category,JSON.stringify(defaults),simulationTime]);
      created++;
    }
  }
  return {created};
}

async function loadCapabilitiesForEntities(simulationId,entityIds=[]){
  const ids=[...new Set(entityIds.filter(Boolean).map(String))];if(!ids.length)return new Map();
  const placeholders=ids.map(()=>`UUID_TO_BIN(?)`).join(",");
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(elc.entity_id) entityId,BIN_TO_UUID(wc.id) id,BIN_TO_UUID(wc.location_id) locationId,BIN_TO_UUID(wc.source_entity_id) sourceEntityId,wc.code,wc.name,wc.category,wc.parameters,wc.active FROM entity_locations_current elc JOIN world_capabilities wc ON wc.location_id=elc.location_id AND wc.simulation_id=elc.simulation_id WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id IN (${placeholders}) AND wc.active=1`.replace("${placeholders}",placeholders),[simulationId,...ids]);
  const result=new Map(ids.map(id=>[id,[]]));for(const row of rows)result.get(String(row.entityId))?.push(normalizeDefinition(row));return result;
}

function scoreDynamicActivity(activity,needs=[],traits=[]){
  const definition=normalizeDefinition(activity),params=definition.parameters||{};
  const gate=Array.isArray(params.gate)?params.gate:null;
  if(gate){const value=Number(needs.find(n=>normalize(n.code)===normalize(gate[0]))?.value||0);if(value<Number(gate[1]||0))return 0;}
  let score=0;const weights=params.needWeights&&typeof params.needWeights==="object"?params.needWeights:{};
  for(const [code,weight] of Object.entries(weights)){score+=Number(needs.find(n=>normalize(n.code)===normalize(code))?.value||0)*Number(weight||0)}
  const traitBias=traits.reduce((sum,t)=>{const code=normalize(t.code);if(code==="DISCIPLINE"&&definition.category==="WORK")return sum+(Number(t.value)-.5)*.8;if(code==="SOCIABILITY"&&definition.category==="SOCIAL")return sum+(Number(t.value)-.5)*.7;return sum},0);
  return Math.max(0,score+traitBias);
}

function dynamicCodes(activities=[]){return activities.map(a=>normalize(a.code||a)).filter(Boolean)}
module.exports={DEFAULTS,ensureCapabilitiesForEmergentStructures,loadCapabilitiesForEntities,scoreDynamicActivity,dynamicCodes,normalizeDefinition};