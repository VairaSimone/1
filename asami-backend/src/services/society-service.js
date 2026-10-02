const { pool, withTransaction } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent } = require("./event-service");
const logger = require("../lib/logger");

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value)}catch{return fallback}}
function normalize(value){return String(value||"").trim().toUpperCase()}
function clamp(value,min=0,max=1){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):min}
function gini(values){const a=values.map(Number).filter(Number.isFinite).map(x=>Math.max(0,x)).sort((x,y)=>x-y);const n=a.length;if(n<2)return 0;const sum=a.reduce((s,x)=>s+x,0);if(sum<=0)return 0;let weighted=0;for(let i=0;i<n;i++)weighted+=(i+1)*a[i];return clamp((2*weighted)/(n*sum)-(n+1)/n,0,1)}
function hoursBetween(a,b){const x=new Date(a).getTime(),y=new Date(b).getTime();return Number.isFinite(x)&&Number.isFinite(y)?Math.max(0,(y-x)/3600000):1}

async function ensureCatalog(simulationId,simulationTime){
  const goods=[
    ["FOOD","Food","ESSENTIAL",1],
    ["TOOLS","Tools","CAPITAL",4],
    ["SERVICES","Services","SERVICE",2]
  ];
  for(const [code,name,category,basePrice] of goods){
    await pool.query(`INSERT INTO emergent_goods(id,simulation_id,code,name,category,unit,base_price,created_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,"unit",?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),base_price=VALUES(base_price)`,
      [uuid(),simulationId,code,name,category,basePrice,simulationTime]);
  }
}

async function ensureAccounts(simulationId,simulationTime){
  const [entities]=await pool.query(`SELECT DISTINCT BIN_TO_UUID(e.id) id,et.code entityType
    FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND e.status="ACTIVE"
      AND (et.code IN ("PERSON","ORGANIZATION") OR EXISTS (SELECT 1 FROM emergent_structures es WHERE es.simulation_id=e.simulation_id AND es.entity_id=e.id))`,[simulationId]);
  for(const entity of entities){
    const [rows]=await pool.query(`SELECT balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entity.id]);
    if(!rows.length){
      const starting=normalize(entity.entityType)==="PERSON"?20:0;
      await pool.query(`INSERT INTO emergent_economy_accounts(id,simulation_id,entity_id,balance,lifetime_income,lifetime_spending,last_updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,0,0,?,1)`,[uuid(),simulationId,entity.id,starting,simulationTime]);
    }
  }
}

function definitionFromStructure(row) {
  return parseJson(row.attributes, {})?.definition || {};
}

function isMarketStructure(row) {
  const definition=definitionFromStructure(row);
  const category=normalize(definition.category);
  return normalize(row.type||row.systemType)==="MARKET" ||
    Boolean(definition.market===true) ||
    category==="MARKET" ||
    category==="COMMERCE";
}

function isProducerStructure(row) {
  const definition=definitionFromStructure(row);
  if(definition.production && typeof definition.production==="object") return true;
  const activities=Array.isArray(definition.activities)?definition.activities:[];
  return activities.some(activity=>{
    const category=normalize(activity?.category);
    return category==="WORK"||category==="PRODUCTION"||category==="CRAFT";
  }) || ["WORKSHOP","FARM"].includes(normalize(row.type||row.systemType));
}

async function ensureMarketInventory(simulationId,simulationTime){
  const [structures]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,es.structure_type type,es.attributes
       FROM emergent_structures es
      WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  for(const market of structures){
    if(!isMarketStructure(market))continue;
    const [rows]=await pool.query(
      `SELECT quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code='FOOD'
        LIMIT 1`,
      [simulationId,market.entityId]
    );
    if(rows.length)continue;
    await pool.query(
      `INSERT INTO emergent_inventory
        (id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'FOOD',12,?,1)`,
      [uuid(),simulationId,market.entityId,simulationTime]
    );
  }
}
async function ensureJobs(simulationId,simulationTime){
  const economicPolicy=await latestEconomicPolicy(simulationId);
  const [structures]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) employerId,BIN_TO_UUID(es.project_id) projectId,
            es.structure_type type,es.attributes
       FROM emergent_structures es
      WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );

  for(const structure of structures){
    const definition=definitionFromStructure(structure);
    const [businessRows]=await pool.query(
      `SELECT production_capacity productionCapacity,status
         FROM emergent_businesses
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,structure.employerId]
    );
    if(businessRows.length && String(businessRows[0].status)!=="ACTIVE")continue;
    const capacity=Math.max(.25,Math.min(10,Number(businessRows[0]?.productionCapacity||1)));
    const maxWorkers=Math.max(1,Math.min(12,Math.ceil(capacity*3)));
    const definitionWorkActivities=Array.isArray(definition.activities)
      ?definition.activities.filter(activity=>{
          const category=normalize(activity?.category);
          return category==="WORK"||category==="PRODUCTION"||category==="CRAFT";
        })
      : [];
    const shouldHire=isMarketStructure(structure)||isProducerStructure(structure)||definitionWorkActivities.length>0;
    if(!shouldHire)continue;

    const role=definitionWorkActivities[0]?.name
      ? String(definitionWorkActivities[0].name).slice(0,80)
      : isMarketStructure(structure)?"SELLER":(normalize(structure.type)==="WORKSHOP"?"CRAFTSPERSON":"WORKER");
    const wage=Number(
      definitionWorkActivities[0]?.wagePerHour ??
      (normalize(definition.category)==="HIGH_SKILL" ? 1.1 : 0.75)
    );
    const policyMinimumWage=Math.max(0,Math.min(5,Number(economicPolicy.minimumWage||0)));
    const safeWage=Number.isFinite(wage)?Math.max(0.25,Math.min(5,Math.max(wage,policyMinimumWage))):Math.max(0.75,policyMinimumWage);

    const [members]=await pool.query(
      `SELECT BIN_TO_UUID(entity_id) entityId
         FROM emergent_project_members
        WHERE simulation_id=UUID_TO_BIN(?) AND project_id=UUID_TO_BIN(?) AND entity_id<>UUID_TO_BIN(?)
        ORDER BY joined_simulation_at LIMIT ?`,
      [simulationId,structure.projectId,structure.employerId,maxWorkers]
    );

    for(const member of members){
      const [existing]=await pool.query(
        `SELECT id FROM emergent_jobs
          WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,
        [simulationId,member.entityId]
      );
      if(existing.length)continue;
      await pool.query(
        `INSERT INTO emergent_jobs
          (id,simulation_id,employer_entity_id,employee_entity_id,role,wage_per_hour,status,hired_simulation_at,version)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'ACTIVE',?,1)`,
        [uuid(),simulationId,structure.employerId,member.entityId,role,safeWage,simulationTime]
      );
    }
  }
  const [systems]=await pool.query(
    \`SELECT BIN_TO_UUID(es.id) systemId,es.attributes
       FROM emergent_systems es
      WHERE es.simulation_id=UUID_TO_BIN(?) AND es.stage<>'ENDED'\`,
    [simulationId]
  );
  for(const system of systems){
    const attributes=parseJson(system.attributes,{});
    const systemEntityId=attributes.systemEntityId;
    const definition=attributes.definition||{};
    const work=Array.isArray(definition.activities)
      ?definition.activities.find(activity=>{
          const c=normalize(activity?.category);
          return c==='WORK'||c==='PRODUCTION'||c==='CRAFT';
        })
      : null;
    if(!systemEntityId||!work)continue;
    const [businessRows]=await pool.query(
      \`SELECT production_capacity productionCapacity,status
         FROM emergent_businesses
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1\`,
      [simulationId,systemEntityId]
    );
    if(businessRows.length&&String(businessRows[0].status)!=='ACTIVE')continue;
    const capacity=Math.max(.25,Math.min(10,Number(businessRows[0]?.productionCapacity||1)));
    const maxWorkers=Math.max(1,Math.min(12,Math.ceil(capacity*3)));
    let wage=Number(work.wagePerHour??.75);
    wage=Math.max(wage,Math.max(0,Math.min(5,Number(economicPolicy.minimumWage||0))));
    const safeWage=Number.isFinite(wage)?Math.max(.25,Math.min(5,wage)):.75;
    const [members]=await pool.query(
      \`SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_system_members
        WHERE simulation_id=UUID_TO_BIN(?) AND system_id=UUID_TO_BIN(?) ORDER BY joined_simulation_at LIMIT ?\`,
      [simulationId,system.systemId,maxWorkers]
    );
    for(const member of members){
      const [existing]=await pool.query(
        \`SELECT id FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1\`,
        [simulationId,member.entityId]
      );
      if(existing.length)continue;
      await pool.query(
        \`INSERT INTO emergent_jobs
          (id,simulation_id,employer_entity_id,employee_entity_id,role,wage_per_hour,status,hired_simulation_at,version)
         VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'ACTIVE',?,1)\`,
        [uuid(),simulationId,systemEntityId,member.entityId,String(work.name||'WORKER').slice(0,80),safeWage,simulationTime]
      );
    }
  }

}

async function matchLaborMarket(simulationId,simulationTime){
  const economicPolicy=await latestEconomicPolicy(simulationId);
  const [people]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) entityId
       FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND et.code='PERSON' AND e.status='ACTIVE'`,
    [simulationId]
  );
  let changed=0;
  for(const person of people){
    const [currentRows]=await pool.query(
      `SELECT id,wage_per_hour wage,employer_entity_id employerId
         FROM emergent_jobs
        WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status='ACTIVE'
        LIMIT 1`,
      [simulationId,person.entityId]
    );
    const current=currentRows[0]||null;

    const [candidates]=await pool.query(
      `SELECT
          BIN_TO_UUID(es.entity_id) employerId,
          BIN_TO_UUID(es.scope_location_id) locationId,
          es.structure_type type,
          es.attributes,
          BIN_TO_UUID(es.project_id) projectId
         FROM emergent_structures es
         JOIN emergent_businesses eb ON eb.simulation_id=es.simulation_id AND eb.entity_id=es.entity_id AND eb.status='ACTIVE'
         JOIN emergent_project_members epm ON epm.simulation_id=es.simulation_id AND epm.project_id=es.project_id
          AND epm.entity_id=UUID_TO_BIN(?)
        WHERE es.simulation_id=UUID_TO_BIN(?)`,
      [person.entityId,simulationId]
    );
    const [systemCandidates]=await pool.query(
      `SELECT
          JSON_UNQUOTE(JSON_EXTRACT(es.attributes,'$.systemEntityId')) employerId,
          BIN_TO_UUID(es.scope_location_id) locationId,
          es.system_type type,
          es.attributes
         FROM emergent_systems es
         JOIN emergent_businesses eb ON eb.simulation_id=es.simulation_id
          AND BIN_TO_UUID(eb.entity_id)=JSON_UNQUOTE(JSON_EXTRACT(es.attributes,'$.systemEntityId')) AND eb.status='ACTIVE'
         JOIN emergent_system_members esm ON esm.simulation_id=es.simulation_id
          AND esm.system_id=es.id AND esm.entity_id=UUID_TO_BIN(?)
        WHERE es.simulation_id=UUID_TO_BIN(?) AND es.stage<>'ENDED'`,
      [person.entityId,simulationId]
    );
    const allCandidates=[...candidates,...systemCandidates];
    let best=null;
    for(const candidate of allCandidates){
      const definition=definitionFromStructure(candidate);
      const activities=Array.isArray(definition.activities)?definition.activities:[];
      const work=activities.find(activity=>{
        const c=normalize(activity?.category);
        return c==='WORK'||c==='PRODUCTION'||c==='CRAFT';
      });
      const wage=Number(work?.wagePerHour ?? (normalize(candidate.type)==='WORKSHOP'?.9:.75));
      if(!Number.isFinite(wage))continue;
      wage=Math.max(wage,Math.max(0,Math.min(5,Number(economicPolicy.minimumWage||0))));
      if(!best || wage>best.wage)best={...candidate,wage:Math.max(.25,Math.min(5,wage)),role:String(work?.name||'WORKER').slice(0,80)};
    }
    if(!best)continue;

    const currentWage=Number(current?.wage||0);
    const shouldSwitch=!current || (
      String(current.employerId)!==String(best.employerId) &&
      best.wage>currentWage*1.10
    );
    if(!shouldSwitch)continue;
    if(current){
      await pool.query(
        `UPDATE emergent_jobs SET status='ENDED',version=version+1
          WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
        [current.id]
      );
    }
    await pool.query(
      `INSERT INTO emergent_jobs
        (id,simulation_id,employer_entity_id,employee_entity_id,role,wage_per_hour,status,hired_simulation_at,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'ACTIVE',?,1)`,
      [uuid(),simulationId,best.employerId,person.entityId,best.role,best.wage,simulationTime]
    );
    changed++;
  }
  return changed;
}

