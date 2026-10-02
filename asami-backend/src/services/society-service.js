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
      AND (
        et.code IN ("PERSON","ORGANIZATION")
        OR EXISTS (
          SELECT 1 FROM emergent_structures es
          WHERE es.simulation_id=e.simulation_id AND es.entity_id=e.id
        )
        OR EXISTS (
          SELECT 1 FROM emergent_systems es
          WHERE es.simulation_id=e.simulation_id
            AND JSON_UNQUOTE(JSON_EXTRACT(es.attributes,"$.systemEntityId"))=BIN_TO_UUID(e.id)
            AND es.stage<>"ENDED"
        )
      )`,[simulationId]);
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
  return normalize(row.type)==="MARKET" ||
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
  }) || ["WORKSHOP","FARM"].includes(normalize(row.type));
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
  const [systems]=await pool.query(
    'SELECT BIN_TO_UUID(JSON_UNQUOTE(JSON_EXTRACT(attributes,"$.systemEntityId"))) entityId,attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND stage<>"ENDED"',
    [simulationId]
  );
  for(const system of systems){
    const systemMarket={type:parseJson(system.attributes,{}).definition?.market===true?"MARKET":parseJson(system.attributes,{}).definition?.category,attributes:system.attributes,entityId:system.entityId};
    if(!system.entityId||!isMarketStructure(systemMarket))continue;
    const [rows]=await pool.query(
      'SELECT quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code="FOOD" LIMIT 1',
      [simulationId,system.entityId]
    );
    if(rows.length)continue;
    await pool.query(
      'INSERT INTO emergent_inventory (id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),"FOOD",12,?,1)',
      [uuid(),simulationId,system.entityId,simulationTime]
    );
  }
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
    'SELECT BIN_TO_UUID(id) systemId,attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND stage<>"ENDED"',
    [simulationId]
  );
  for(const system of systems){
    const attrs=parseJson(system.attributes,{}),definition=attrs.definition||{},systemEntityId=attrs.systemEntityId;
    const work=Array.isArray(definition.activities)?definition.activities.find(activity=>{const category=normalize(activity?.category);return category==='WORK'||category==='PRODUCTION'||category==='CRAFT';}):null;
    if(!work||!systemEntityId)continue;
    const [businessRows]=await pool.query('SELECT production_capacity productionCapacity,status FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1',[simulationId,systemEntityId]);
    if(businessRows.length&&String(businessRows[0].status)!=='ACTIVE')continue;
    const capacity=Math.max(.25,Math.min(10,Number(businessRows[0]?.productionCapacity||1)));
    const maxWorkers=Math.max(1,Math.min(12,Math.ceil(capacity*3)));
    let wage=Number(work.wagePerHour??.75);
    wage=Math.max(wage,Math.max(0,Math.min(5,Number(economicPolicy.minimumWage||0))));
    const safeWage=Number.isFinite(wage)?Math.max(.25,Math.min(5,wage)):.75;
    const [members]=await pool.query('SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_system_members WHERE simulation_id=UUID_TO_BIN(?) AND system_id=UUID_TO_BIN(?) ORDER BY joined_simulation_at LIMIT ?',[simulationId,system.systemId,maxWorkers]);
    for(const member of members){
      const [existing]=await pool.query('SELECT id FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status=\'ACTIVE\' LIMIT 1',[simulationId,member.entityId]);
      if(existing.length)continue;
      await pool.query('INSERT INTO emergent_jobs (id,simulation_id,employer_entity_id,employee_entity_id,role,wage_per_hour,status,hired_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?, ?,\'ACTIVE\',?,1)',[uuid(),simulationId,systemEntityId,member.entityId,String(work.name||'WORKER').slice(0,80),safeWage,simulationTime]);
    }
  }}

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
      'SELECT JSON_UNQUOTE(JSON_EXTRACT(es.attributes,\'$.systemEntityId\')) employerId,BIN_TO_UUID(es.scope_location_id) locationId,es.system_type type,es.attributes FROM emergent_systems es JOIN emergent_businesses eb ON eb.simulation_id=es.simulation_id AND eb.entity_id=UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(es.attributes,\'$.systemEntityId\'))) AND eb.status=\'ACTIVE\' JOIN emergent_system_members esm ON esm.simulation_id=es.simulation_id AND esm.system_id=es.id AND esm.entity_id=UUID_TO_BIN(?) WHERE es.simulation_id=UUID_TO_BIN(?) AND es.stage<>\'ENDED\'',
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

async function evolvePrices(simulationId,simulationTime){
  const [structureMarkets]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type,es.attributes
       FROM emergent_structures es
      WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  const [systemMarkets]=await pool.query(
    'SELECT JSON_UNQUOTE(JSON_EXTRACT(es.attributes,"$.systemEntityId")) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.system_type type,es.attributes FROM emergent_systems es WHERE es.simulation_id=UUID_TO_BIN(?) AND es.stage<>"ENDED"',
    [simulationId]
  );
  const marketRows=[...structureMarkets,...systemMarkets].filter(isMarketStructure);
  const economicPolicy=await latestEconomicPolicy(simulationId);
  const [goods]=await pool.query(
    `SELECT code,base_price basePrice FROM emergent_goods WHERE simulation_id=UUID_TO_BIN(?) ORDER BY code`,
    [simulationId]
  );

  for(const market of marketRows){
    for(const good of goods){
      const [stock]=await pool.query(
        `SELECT COALESCE(SUM(quantity),0) supply FROM emergent_inventory
          WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=?`,
        [simulationId,market.entityId,good.code]
      );
      const [demand]=await pool.query(
        `SELECT COUNT(*) demand FROM emergent_trades
          WHERE simulation_id=UUID_TO_BIN(?) AND seller_entity_id=UUID_TO_BIN(?)
            AND good_code=? AND simulation_at>=DATE_SUB(?,INTERVAL 24 HOUR)`,
        [simulationId,market.entityId,good.code,simulationTime]
      );
      const supplyValue=Number(stock[0]?.supply||0);
      const demandValue=Number(demand[0]?.demand||0);
      const basePrice=Number(good.basePrice||1);
      const pressure=(demandValue*.18)/Math.max(1,supplyValue);
      let price=Number((basePrice*clamp(1+pressure,.55,3)).toFixed(4));
      const ceiling=Number(economicPolicy.priceCeilingMultiplier||0);
      if(good.code==="FOOD"&&ceiling>0)price=Math.min(price,Number((basePrice*Math.max(.55,Math.min(3,ceiling))).toFixed(4)));
      await pool.query(
        `INSERT INTO emergent_market_state
          (id,simulation_id,location_id,good_code,price,supply,demand,updated_simulation_at,version)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,1)
          ON DUPLICATE KEY UPDATE price=VALUES(price),supply=VALUES(supply),demand=VALUES(demand),
            updated_simulation_at=VALUES(updated_simulation_at),version=version+1`,
        [uuid(),simulationId,market.locationId,good.code,price,supplyValue,demandValue,simulationTime]
      );
    }
  }
}

async function loadLocationGraph(simulationId){
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) locationId,l.address_data addressData
       FROM locations l JOIN entities e ON e.id=l.entity_id
      WHERE l.simulation_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,
    [simulationId,simulationId]
  );
  return rows.map(row=>({locationId:row.locationId,connections:parseJson(row.addressData,{})?.connections||[]}));
}

function graphDistance(graph,originId,targetId){
  if(String(originId)===String(targetId))return 0;
  const byId=new Map(graph.map(row=>[String(row.locationId),row]));
  const queue=[[String(originId),0]],seen=new Set([String(originId)]);
  while(queue.length){
    const [current,distance]=queue.shift();
    const row=byId.get(current);
    for(const next of Array.isArray(row?.connections)?row.connections:[]){
      const id=String(next);
      if(id===String(targetId))return distance+1;
      if(!seen.has(id)&&byId.has(id)){seen.add(id);queue.push([id,distance+1]);}
    }
  }
  return Infinity;
}

async function restockMarkets(simulationId,simulationTime){
  const [structureRows]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type,es.attributes
       FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  const [systemRows]=await pool.query(
    'SELECT JSON_UNQUOTE(JSON_EXTRACT(es.attributes,"$.systemEntityId")) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.system_type type,es.attributes FROM emergent_systems es WHERE es.simulation_id=UUID_TO_BIN(?) AND es.stage<>"ENDED"',
    [simulationId]
  );
  const rows=[...structureRows,...systemRows].filter(row=>row.entityId);
  const markets=rows.filter(isMarketStructure), producers=rows.filter(isProducerStructure);
  if(!markets.length||!producers.length)return {transfers:0,value:0};
  const graph=await loadLocationGraph(simulationId);
  const transfers=[];

  for(const market of markets){
    const [marketAccount]=await pool.query(
      `SELECT id,balance FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,
      [simulationId,market.entityId]
    );
    if(!marketAccount.length)continue;

    const [goods]=await pool.query(
      `SELECT DISTINCT good_code goodCode FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id IN (SELECT entity_id FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?)) AND quantity>0`,
      [simulationId,simulationId]
    );

    for(const good of goods){
      const candidates=[];
      for(const producer of producers){
        if(String(producer.entityId)===String(market.entityId))continue;
        const distance=graphDistance(graph,producer.locationId,market.locationId);
        if(!Number.isFinite(distance))continue;
        const [stock]=await pool.query(
          `SELECT id,quantity FROM emergent_inventory
            WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? AND quantity>0
            FOR UPDATE`,
          [simulationId,producer.entityId,good.goodCode]
        );
        if(stock.length&&Number(stock[0].quantity)>0)candidates.push({producer,stock:stock[0],distance});
      }
      candidates.sort((a,b)=>a.distance-b.distance);
      const candidate=candidates[0];
      if(!candidate)continue;

      const [priceRows]=await pool.query(
        `SELECT price FROM emergent_market_state
          WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1`,
        [simulationId,market.locationId,good.goodCode]
      );
      const unitPrice=Number(priceRows[0]?.price||1)*0.72;
      const quantity=Math.min(4,Number(candidate.stock.quantity||0));
      const total=Number((unitPrice*quantity).toFixed(4));
      if(quantity<=0||Number(marketAccount[0].balance)<total)continue;

      const [producerAccount]=await pool.query(
        `SELECT id FROM emergent_economy_accounts
          WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,
        [simulationId,candidate.producer.entityId]
      );
      if(!producerAccount.length)continue;

      await pool.query(`UPDATE emergent_inventory SET quantity=quantity-?,updated_simulation_at=?,version=version+1 WHERE id=?`,
        [quantity,simulationTime,candidate.stock.id]);
      const [marketStock]=await pool.query(
        `SELECT id FROM emergent_inventory
          WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? FOR UPDATE`,
        [simulationId,market.entityId,good.goodCode]
      );
      if(marketStock.length){
        await pool.query(`UPDATE emergent_inventory SET quantity=quantity+?,updated_simulation_at=?,version=version+1 WHERE id=?`,
          [quantity,simulationTime,marketStock[0].id]);
      }else{
        await pool.query(
          `INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
           VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)`,
          [uuid(),simulationId,market.entityId,good.goodCode,quantity,simulationTime]
        );
      }

      await pool.query(
        `UPDATE emergent_economy_accounts
           SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
        [total,total,simulationTime,marketAccount[0].id]
      );
      await pool.query(
        `UPDATE emergent_economy_accounts
           SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
        [total,total,simulationTime,producerAccount[0].id]
      );
      const policy=await latestEconomicPolicy(simulationId);
      const subsidyRate=Math.max(0,Math.min(.35,Number(policy.productionSubsidyRate||0)));
      if(subsidyRate>0){
        const [govSystemRows]=await pool.query(
          `SELECT attributes FROM emergent_systems
            WHERE simulation_id=UUID_TO_BIN(?) AND system_type='GOVERNANCE' LIMIT 1`,
          [simulationId]
        );
        const govId=parseJson(govSystemRows[0]?.attributes,{}).systemEntityId;
        if(govId){
          const [govRows]=await pool.query(
            `SELECT id,balance FROM emergent_economy_accounts
              WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
            [simulationId,govId]
          );
          const subsidy=Math.min(Number(govRows[0]?.balance||0),Number((total*subsidyRate).toFixed(4)));
          if(govRows.length&&subsidy>0){
            await pool.query(
              `UPDATE emergent_economy_accounts
                SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
              [subsidy,subsidy,simulationTime,govRows[0].id]
            );
            await pool.query(
              `UPDATE emergent_economy_accounts
                SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
              [subsidy,subsidy,simulationTime,producerAccount[0].id]
            );
            transfers.push({marketEntityId:market.entityId,producerEntityId:candidate.producer.entityId,goodCode:good.goodCode,quantity,unitPrice:subsidy/Math.max(.0001,quantity),total:subsidy,simulationAt:simulationTime,type:"GOVERNMENT_SUBSIDY"});
          }
        }
      }
      await pool.query(
        `INSERT INTO emergent_trades
          (id,simulation_id,buyer_entity_id,seller_entity_id,location_id,good_code,quantity,unit_price,total,simulation_at)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`,
        [uuid(),simulationId,market.entityId,candidate.producer.entityId,market.locationId,good.goodCode,quantity,unitPrice,total,simulationTime]
      );
      transfers.push({marketEntityId:market.entityId,producerEntityId:candidate.producer.entityId,goodCode:good.goodCode,quantity,unitPrice,total,simulationAt:simulationTime,type:"WHOLESALE"});
    }
  }
  return {transfers,totalValue:Number(transfers.reduce((sum,item)=>sum+item.total,0).toFixed(4))};
}
async function evolvePolitics(simulationId,simulationTime){
  const [systems]=await pool.query(`SELECT BIN_TO_UUID(id) id FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type="GOVERNANCE" AND stage<>"ENDED" LIMIT 1`,[simulationId]);
  if(!systems.length)return {governanceId:null,enacted:[]};
  const governanceId=systems[0].id;
  const [people]=await pool.query(`SELECT BIN_TO_UUID(e.id) entityId,e.display_name displayName,COALESCE(ea.balance,20) balance,EXISTS(SELECT 1 FROM emergent_jobs ej WHERE ej.simulation_id=e.simulation_id AND ej.employee_entity_id=e.id AND ej.status="ACTIVE") employed FROM entities e JOIN entity_types et ON et.id=e.entity_type_id LEFT JOIN emergent_economy_accounts ea ON ea.simulation_id=e.simulation_id AND ea.entity_id=e.id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN("00000000-0000-4000-8000-000000000001") AND e.status="ACTIVE"`,[simulationId]);
  const traitIds=people.map(x=>x.entityId),placeholders=traitIds.map(()=>"UUID_TO_BIN(?)").join(",");
  const traitRows=traitIds.length?(await pool.query(`SELECT BIN_TO_UUID(etc.entity_id) entityId,td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id IN (${placeholders})`.replace("${placeholders}",placeholders),traitIds))[0]:[];
  const traitMap=new Map();for(const row of traitRows){if(!traitMap.has(row.entityId))traitMap.set(row.entityId,{});traitMap.get(row.entityId)[normalize(row.code)]=Number(row.value)}
  const [policies]=await pool.query(`SELECT BIN_TO_UUID(id) id,title,statement,parameters,status FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND governance_system_id=UUID_TO_BIN(?) AND status="PROPOSED" ORDER BY created_simulation_at ASC LIMIT 6`,[simulationId,governanceId]);
  const enacted=[];
  for(const policy of policies){
    for(const person of people){
      const [existing]=await pool.query(`SELECT id FROM emergent_policy_votes WHERE simulation_id=UUID_TO_BIN(?) AND policy_id=UUID_TO_BIN(?) AND voter_entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,policy.id,person.entityId]);
      if(existing.length)continue;
      const traits=traitMap.get(person.entityId)||{},params=parseJson(policy.parameters,{}),rate=Number(params.contributionRate||0),balance=Number(person.balance||20),wealthSignal=clamp((balance-20)/40,-1,1),employmentSignal=person.employed?0.12:-0.08;
      const title=normalize(policy.title),isVoluntary=title.includes("VOLUNTARY")||normalize(params.fundingModel)==="VOLUNTARY";
      const economicInterest=isVoluntary ? wealthSignal*.34 : -wealthSignal*.34;
      const score=clamp((isVoluntary?Number(traits.INDEPENDENCE||.5)-.5:Number(traits.CONSCIENTIOUSNESS||.5)-.5)*1.25+Number(traits.EMPATHY||.5)*.25+economicInterest+employmentSignal+.5);
      const choice=score>=.5?"YES":"NO";
      await pool.query(`INSERT INTO emergent_policy_votes(id,simulation_id,policy_id,voter_entity_id,choice,score,rationale,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,[uuid(),simulationId,policy.id,person.entityId,choice,score,JSON.stringify({independence:Number(traits.INDEPENDENCE||.5),conscientiousness:Number(traits.CONSCIENTIOUSNESS||.5),empathy:Number(traits.EMPATHY||.5),economicInterest:Number(economicInterest.toFixed(4)),wealthSignal:Number(wealthSignal.toFixed(4)),employmentSignal,contributionRate:rate}),simulationTime]);
    }
    const [tally]=await pool.query(`SELECT COUNT(*) total,SUM(choice="YES") yes FROM emergent_policy_votes WHERE simulation_id=UUID_TO_BIN(?) AND policy_id=UUID_TO_BIN(?)`,[simulationId,policy.id]);
    const total=Number(tally[0]?.total||0),yes=Number(tally[0]?.yes||0),ratio=total?yes/total:0;
    if(total>=Math.min(7,people.length) && ratio>=.60){
      await pool.query(`UPDATE emergent_policies SET status="ENACTED",support_score=?,opposition_score=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status="PROPOSED"`,[ratio,1-ratio,simulationTime,policy.id]);
      enacted.push(policy.id);
      await createEvent({simulationId,eventTypeCode:"SOCIAL",title:"A policy was enacted: "+policy.title,description:policy.statement,simulationAt:simulationTime,importance:.74,metadata:{emergent:true,kind:"POLICY_ENACTED",policyId:policy.id,governanceSystemId}});
    }else if(total>=Math.min(7,people.length) && ratio<=.40){
      await pool.query(`UPDATE emergent_policies SET status="REJECTED",support_score=?,opposition_score=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status="PROPOSED"`,[ratio,1-ratio,simulationTime,policy.id]);
    }
  }
  return {governanceId,enacted};
}

async function ensureGovernanceMembers(simulationId,simulationTime){
  const [systems]=await pool.query(`SELECT BIN_TO_UUID(id) id FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type="GOVERNANCE" AND stage<>"ENDED" LIMIT 1`,[simulationId]);
  if(!systems.length)return;
  const systemId=systems[0].id;
  const [people]=await pool.query(`SELECT BIN_TO_UUID(e.id) entityId,MAX(CASE WHEN td.code="CONFIDENCE" THEN etc.value ELSE 0 END) confidence,MAX(CASE WHEN td.code="EMPATHY" THEN etc.value ELSE 0 END) empathy,MAX(CASE WHEN td.code="CONSCIENTIOUSNESS" THEN etc.value ELSE 0 END) conscientiousness FROM entities e JOIN entity_types et ON et.id=e.entity_type_id LEFT JOIN entity_traits_current etc ON etc.entity_id=e.id LEFT JOIN trait_definitions td ON td.id=etc.trait_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN("00000000-0000-4000-8000-000000000001") AND e.status="ACTIVE" GROUP BY e.id`,[simulationId]);
  people.sort((a,b)=>((Number(b.confidence)+Number(b.empathy)+Number(b.conscientiousness))-(Number(a.confidence)+Number(a.empathy)+Number(a.conscientiousness))));
  for(let i=0;i<Math.min(5,people.length);i++){const p=people[i];await pool.query(`INSERT IGNORE INTO emergent_governance_members(system_id,simulation_id,entity_id,role,support_score,joined_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?)`,[systemId,simulationId,p.entityId,i===0?"COORDINATOR":"MEMBER",clamp((Number(p.confidence)+Number(p.empathy)+Number(p.conscientiousness))/3),simulationTime]);}
}

async function recordWealth(simulationId,simulationTime){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(ea.entity_id) entityId,ea.balance
    FROM emergent_economy_accounts ea JOIN entities e ON e.id=ea.entity_id AND e.simulation_id=ea.simulation_id
    JOIN entity_types et ON et.id=e.entity_type_id
    WHERE ea.simulation_id=UUID_TO_BIN(?) AND et.code="PERSON" ORDER BY ea.balance DESC`,[simulationId]);
  const pop=rows.length;if(!pop)return null;
  const values=rows.map(r=>Number(r.balance||0)),total=values.reduce((s,v)=>s+v,0),avg=total/pop,inequality=gini(values);
  for(let i=0;i<rows.length;i++)await pool.query(`INSERT INTO emergent_wealth_history(id,simulation_id,entity_id,balance,rank_position,population_count,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,[uuid(),simulationId,rows[i].entityId,Number(rows[i].balance||0),i+1,pop,simulationTime]);
  const [price]=await pool.query(`SELECT AVG(price) value FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) AND good_code="FOOD"`,[simulationId]);
  const [trade]=await pool.query(`SELECT COALESCE(SUM(total),0) value FROM emergent_trades WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at>=DATE_SUB(?,INTERVAL 24 HOUR)`,[simulationId,simulationTime]);
  await pool.query(`INSERT INTO emergent_economic_metrics(id,simulation_id,population_count,total_wealth,average_wealth,gini,average_food_price,total_trade_value,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?)`,[uuid(),simulationId,pop,total,avg,inequality,Number(price[0]?.value||1),Number(trade[0]?.value||0),simulationTime]);
  return {population:pop,totalWealth:total,averageWealth:avg,gini:inequality};
}


async function ensureBusinesses(simulationId,simulationTime){
  const [structures]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.project_id) projectId,es.structure_type type,es.attributes
       FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  let created=0;
  for(const structure of structures){
    const producer=isProducerStructure(structure),market=isMarketStructure(structure);
    if(!producer&&!market)continue;
    const [existing]=await pool.query(
      `SELECT id FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,structure.entityId]
    );
    if(existing.length)continue;
    const [project]=await pool.query(
      `SELECT BIN_TO_UUID(proposer_entity_id) ownerEntityId
         FROM emergent_projects WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,structure.projectId]
    );
    const ownerEntityId=project[0]?.ownerEntityId||structure.entityId;
    await pool.query(
      `INSERT INTO emergent_businesses
        (id,simulation_id,entity_id,owner_entity_id,status,production_capacity,created_simulation_at,updated_simulation_at,version)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'ACTIVE',1,?,?,1)`,
      [uuid(),simulationId,structure.entityId,ownerEntityId,simulationTime,simulationTime]
    );
    if(String(ownerEntityId)!==String(structure.entityId)){
      const [ownerAccount]=await pool.query(
        `SELECT id,balance FROM emergent_economy_accounts
          WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [simulationId,ownerEntityId]
      );
      const [businessAccount]=await pool.query(
        `SELECT id,balance FROM emergent_economy_accounts
          WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [simulationId,structure.entityId]
      );
      if(ownerAccount.length&&businessAccount.length&&Number(ownerAccount[0].balance)>0){
        const capital=Number(Math.min(10,Math.max(0,Number(ownerAccount[0].balance)*.25)).toFixed(4));
        if(capital>0){
          await pool.query(
            `UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
            [capital,capital,simulationTime,ownerAccount[0].id]
          );
          await pool.query(
            `UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
            [capital,capital,simulationTime,businessAccount[0].id]
          );
        }
      }
    }
    created++;
  }
  const [systems]=await pool.query(
    'SELECT BIN_TO_UUID(id) systemId,attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND stage<>"ENDED"',
    [simulationId]
  );
  for(const system of systems){
    const attrs=parseJson(system.attributes,{}),definition=attrs.definition||{},systemEntityId=attrs.systemEntityId;
    const economic=Boolean(definition.market||definition.production)||
      (Array.isArray(definition.activities)&&definition.activities.some(activity=>{
        const category=normalize(activity?.category);
        return category==='WORK'||category==='PRODUCTION'||category==='CRAFT';
      }));
    if(!economic||!systemEntityId)continue;
    const [existing]=await pool.query(
      'SELECT id FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1',
      [simulationId,systemEntityId]
    );
    if(existing.length)continue;
    const [origin]=await pool.query(
      'SELECT BIN_TO_UUID(origin_entity_id) ownerEntityId FROM emergent_definition_catalog WHERE simulation_id=UUID_TO_BIN(?) AND code=? AND kind IN ("SYSTEM","INSTITUTION","STRUCTURE") ORDER BY created_simulation_at DESC LIMIT 1',
      [simulationId,normalize(definition.code)]
    );
    const ownerEntityId=origin[0]?.ownerEntityId||systemEntityId;
    await pool.query(
      'INSERT INTO emergent_businesses (id,simulation_id,entity_id,owner_entity_id,status,production_capacity,created_simulation_at,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),\'ACTIVE\',1,?,?,1)',
      [uuid(),simulationId,systemEntityId,ownerEntityId,simulationTime,simulationTime]
    );
    if(String(ownerEntityId)!==String(systemEntityId)){
      const [ownerAccount]=await pool.query(
        'SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE',
        [simulationId,ownerEntityId]
      );
      const [businessAccount]=await pool.query(
        'SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE',
        [simulationId,systemEntityId]
      );
      if(ownerAccount.length&&businessAccount.length){
        const capital=Number(Math.min(10,Math.max(0,Number(ownerAccount[0].balance||0)*.25)).toFixed(4));
        if(capital>0){
          await pool.query('UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?',[capital,capital,simulationTime,ownerAccount[0].id]);
          await pool.query('UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?',[capital,capital,simulationTime,businessAccount[0].id]);
        }
      }
    }
    created++;
  }  return created;
}


async function latestEconomicPolicy(simulationId){
  const [rows]=await pool.query(
    `SELECT parameters FROM emergent_policies
      WHERE simulation_id=UUID_TO_BIN(?) AND status='ENACTED'
      ORDER BY updated_simulation_at DESC LIMIT 1`,
    [simulationId]
  );
  return parseJson(rows[0]?.parameters,{});
}

async function ensureEconomicPolicyProposal(simulationId,simulationTime,business){
  const [governanceRows]=await pool.query(
    `SELECT BIN_TO_UUID(id) id FROM emergent_systems
      WHERE simulation_id=UUID_TO_BIN(?) AND system_type='GOVERNANCE' AND stage<>'ENDED'
      LIMIT 1`,
    [simulationId]
  );
  if(!governanceRows.length||!business)return null;
  const [recent]=await pool.query(
    `SELECT id FROM emergent_policies
      WHERE simulation_id=UUID_TO_BIN(?) AND issue_code LIKE 'ECONOMIC_%'
        AND created_simulation_at>=DATE_SUB(?,INTERVAL 24 HOUR)
      LIMIT 1`,
    [simulationId,simulationTime]
  );
  if(recent.length)return null;
  const unemployment=Number(business.unemployed||0)/Math.max(1,Number(business.employed||0)+Number(business.unemployed||0));
  const inequalityRows=await pool.query(
    `SELECT gini,average_food_price averageFoodPrice FROM emergent_economic_metrics
      WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 1`,
    [simulationId]
  );
  const giniValue=Number(inequalityRows[0][0]?.gini||0);
  const foodPrice=Number(inequalityRows[0][0]?.averageFoodPrice||1);
  if(unemployment<.35&&giniValue<.48&&foodPrice<1.35)return null;

  let issueCode,title,statement,parameters;
  if(unemployment>=.35){
    issueCode='ECONOMIC_EMPLOYMENT';
    title='Support employment and production';
    statement='Create a temporary production incentive financed through the common pool so businesses can sustain employment.';
    parameters={fundingModel:'COMMON_POOL',contributionRate:.06,productionSubsidyRate:.12};
  }else if(foodPrice>=1.35){
    issueCode='ECONOMIC_PRICES';
    title='Limit essential food price pressure';
    statement='Introduce a temporary ceiling for essential food prices while supply adjusts.';
    parameters={fundingModel:'VOLUNTARY',priceCeilingMultiplier:1.25};
  }else{
    issueCode='ECONOMIC_DISTRIBUTION';
    title='Increase contribution to the common pool';
    statement='Increase the common contribution to fund collective economic support.';
    parameters={fundingModel:'COMMON_POOL',contributionRate:.08,wageSubsidyRate:.10};
  }
  const [proposer]=await pool.query(
    `SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_governance_members
      WHERE simulation_id=UUID_TO_BIN(?) AND system_id=UUID_TO_BIN(?)
      ORDER BY role='COORDINATOR' DESC,joined_simulation_at ASC LIMIT 1`,
    [simulationId,governanceRows[0].id]
  );
  const [fallback]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) entityId FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND et.code='PERSON' AND e.status='ACTIVE'
      ORDER BY e.created_simulation_at LIMIT 1`,
    [simulationId]
  );
  const proposerId=proposer[0]?.entityId||fallback[0]?.entityId;
  if(!proposerId)return null;
  const id=uuid();
  await pool.query(
    `INSERT INTO emergent_policies
      (id,simulation_id,proposer_entity_id,governance_system_id,scope_location_id,issue_code,title,statement,parameters,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,?,?,?, 'PROPOSED',?,?,1)`,
    [id,simulationId,proposerId,governanceRows[0].id,issueCode,title,statement,JSON.stringify(parameters),simulationTime,simulationTime]
  );
  return {id,issueCode,parameters};
}

async function evolveBusinesses(simulationId,simulationTime){
  const [businesses]=await pool.query(
    `SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(entity_id) entityId,status,production_capacity productionCapacity,
            recent_revenue recentRevenue,recent_input_cost recentInputCost,recent_wage_cost recentWageCost,
            failure_count failureCount,last_evaluated_simulation_at lastEvaluated
       FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  let active=0,failed=0,totalRevenue=0,totalInputCost=0,totalWageCost=0,totalProfit=0,totalProductionValue=0,totalInvestment=0;

  for(const business of businesses){
    const last=business.lastEvaluated?new Date(business.lastEvaluated).getTime():NaN;
    const now=new Date(simulationTime).getTime();
    if(Number.isFinite(last)&&Number.isFinite(now)&&now-last<6*3600000) {
      if(String(business.status)==='ACTIVE')active++; else failed++;
      totalRevenue+=Number(business.recentRevenue||0);
      totalInputCost+=Number(business.recentInputCost||0);
      totalWageCost+=Number(business.recentWageCost||0);
      totalProfit+=Number(business.recentRevenue||0)-Number(business.recentInputCost||0)-Number(business.recentWageCost||0);
      continue;
    }

    const [revenueRows]=await pool.query(
      `SELECT COALESCE(SUM(total),0) value FROM emergent_trades
        WHERE simulation_id=UUID_TO_BIN(?) AND seller_entity_id=UUID_TO_BIN(?) AND simulation_at>=DATE_SUB(?,INTERVAL 6 HOUR)`,
      [simulationId,business.entityId,simulationTime]
    );
    const [inputRows]=await pool.query(
      `SELECT COALESCE(SUM(total),0) value FROM emergent_trades
        WHERE simulation_id=UUID_TO_BIN(?) AND buyer_entity_id=UUID_TO_BIN(?) AND simulation_at>=DATE_SUB(?,INTERVAL 6 HOUR)`,
      [simulationId,business.entityId,simulationTime]
    );
    const [wageRows]=await pool.query(
      `SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(result,'$.economic.grossWage')) AS DECIMAL(16,4))),0) value
         FROM actions
        WHERE simulation_id=UUID_TO_BIN(?) AND action_type='WORK_JOB'
          AND completed_simulation_at>=DATE_SUB(?,INTERVAL 6 HOUR)
          AND JSON_UNQUOTE(JSON_EXTRACT(result,'$.outcome'))='SUCCESS'
          AND JSON_UNQUOTE(JSON_EXTRACT(result,'$.economic.employerEntityId'))=?`,
      [simulationId,simulationTime,business.entityId]
    );
    const [productionRows]=await pool.query(
      `SELECT COALESCE(SUM(eph.quantity*eg.base_price),0) value
         FROM emergent_production_history eph
         JOIN emergent_goods eg ON eg.simulation_id=eph.simulation_id AND eg.code=eph.good_code
        WHERE eph.simulation_id=UUID_TO_BIN(?) AND eph.structure_entity_id=UUID_TO_BIN(?) AND eph.simulation_at>=DATE_SUB(?,INTERVAL 6 HOUR)`,
      [simulationId,business.entityId,simulationTime]
    );
    const revenue=Number(revenueRows[0]?.value||0),inputCost=Number(inputRows[0]?.value||0),wageCost=Number(wageRows[0]?.value||0);
    const profit=Number((revenue-inputCost-wageCost).toFixed(4));
    const productionValue=Number(productionRows[0]?.value||0);

    const [accountRows]=await pool.query(
      `SELECT id,balance FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,business.entityId]
    );
    const balance=Number(accountRows[0]?.balance||0);
    const [jobReserveRows]=await pool.query(
      `SELECT COALESCE(SUM(wage_per_hour*2),0) value FROM emergent_jobs
        WHERE simulation_id=UUID_TO_BIN(?) AND employer_entity_id=UUID_TO_BIN(?) AND status='ACTIVE'`,
      [simulationId,business.entityId]
    );
    const nextWageReserve=Number(jobReserveRows[0]?.value||0);

    let capacity=Number(business.productionCapacity||1),investment=0,failures=Number(business.failureCount||0),status=String(business.status||"ACTIVE");
    if(status==='ACTIVE' && profit>0.5 && accountRows.length){
      investment=Number(Math.min(profit*.15,Math.max(0,balance-nextWageReserve*.5)).toFixed(4));
      if(investment>0){
        await pool.query(
          `UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
          [investment,investment,simulationTime,accountRows[0].id]
        );
        capacity=Number(Math.min(10,capacity+Math.max(.05,Math.min(.5,investment/10))).toFixed(4));
        totalInvestment+=investment;
      }
    }

    const shouldFail=status==='ACTIVE' && (
      failures>=2 ||
      (balance<Math.max(.25,nextWageReserve*.35) && profit<0 && revenue<=0)
    );
    if(shouldFail){
      status='FAILED';
      failures++;
      await pool.query(
        `UPDATE emergent_jobs SET status='ENDED',version=version+1
          WHERE simulation_id=UUID_TO_BIN(?) AND employer_entity_id=UUID_TO_BIN(?) AND status='ACTIVE'`,
        [simulationId,business.entityId]
      );
      await createEvent({
        simulationId,eventTypeCode:"ECONOMIC",
        title:"Business failure: "+business.entityId.slice(0,8),
        description:"The business could no longer sustain its current activity.",
        simulationAt:simulationTime,importance:.78,
        metadata:{emergent:true,kind:"BUSINESS_FAILED",businessEntityId:business.entityId,revenue,inputCost,wageCost,profit}
      });
    } else if(status==='ACTIVE' && profit<0){
      failures++;
    } else if(status==='ACTIVE' && profit>=0){
      failures=0;
    }

    if(accountRows.length){
      await pool.query(
        `UPDATE emergent_businesses
          SET status=?,production_capacity=?,recent_revenue=?,recent_input_cost=?,recent_wage_cost=?,
              recent_profit=?,cumulative_profit=cumulative_profit+?,cumulative_investment=cumulative_investment+?,
              failure_count=?,last_evaluated_simulation_at=?,updated_simulation_at=?,version=version+1
          WHERE id=UUID_TO_BIN(?)`,
        [status,capacity,revenue,inputCost,wageCost,profit,profit,investment,failures,simulationTime,simulationTime,business.id]
      );
    }
    if(status==='ACTIVE')active++;else failed++;
    totalRevenue+=revenue;totalInputCost+=inputCost;totalWageCost+=wageCost;totalProfit+=profit;totalProductionValue+=productionValue;
  }

  const [employmentRows]=await pool.query(
    `SELECT
       SUM(et.code='PERSON') people,
       SUM(et.code='PERSON' AND EXISTS(
         SELECT 1 FROM emergent_jobs ej
          WHERE ej.simulation_id=e.simulation_id AND ej.employee_entity_id=e.id AND ej.status='ACTIVE'
       )) employed
      FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
     WHERE e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,
    [simulationId]
  );
  const people=Number(employmentRows[0]?.people||0),employed=Number(employmentRows[0]?.employed||0);
  const unemployed=Math.max(0,people-employed);
  await pool.query(
    `INSERT INTO emergent_business_metrics
      (id,simulation_id,business_count,active_business_count,failed_business_count,unemployed_count,employed_count,
       revenue,input_cost,wage_cost,profit,production_value,investment,simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(),simulationId,businesses.length,active,failed,unemployed,employed,totalRevenue,totalInputCost,totalWageCost,totalProfit,totalProductionValue,totalInvestment,simulationTime]
  );
  return {businessCount:businesses.length,activeBusinessCount:active,failedBusinessCount:failed,employed,unemployed,revenue:totalRevenue,inputCost:totalInputCost,wageCost:totalWageCost,profit:totalProfit,productionValue:totalProductionValue,investment:totalInvestment};
}

async function consumePurchasedFood({simulationId,entityId,simulationTime,db=pool}){
  const [rows]=await db.query(
    `SELECT id,quantity FROM emergent_inventory
      WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code='FOOD'
      LIMIT 1 FOR UPDATE`,
    [simulationId,entityId]
  );
  if(!rows.length || Number(rows[0].quantity) < 1) return null;
  await db.query(
    `UPDATE emergent_inventory
      SET quantity=quantity-1,updated_simulation_at=?,version=version+1
      WHERE id=? AND quantity>=1`,
    [simulationTime,rows[0].id]
  );
  return {
    ok:true,
    resource:"food",
    consumed:1,
    remaining:Math.max(0,Number(rows[0].quantity)-1),
    source:"PURCHASED_INVENTORY"
  };
}

async function executeEconomicAction({conn,simulationId,entityId,actionType,simulationTime,durationMinutes=120}){
  const action=normalize(actionType);
  const buyMatch=action.match(/^BUY_(?:GOOD_)?([A-Z][A-Z0-9_]*)$/);
  if(buyMatch){
    const goodCode=normalize(buyMatch[1]);
    const [loc]=await conn.query(
      `SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,entityId]
    );
    const locationId=loc[0]?.locationId;
    if(!locationId)return {ok:false,failureReason:"NO_LOCATION"};

    const [sellerStructureRows]=await conn.query(
      `SELECT BIN_TO_UUID(entity_id) entityId,structure_type type,attributes
         FROM emergent_structures
        WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?)`,
      [simulationId,locationId]
    );
    const [sellerSystemRows]=await conn.query(
      'SELECT BIN_TO_UUID(JSON_UNQUOTE(JSON_EXTRACT(attributes,"$.systemEntityId"))) entityId,system_type type,attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND stage<>"ENDED"',
      [simulationId,locationId]
    );
    const seller=[...sellerStructureRows,...sellerSystemRows].filter(row=>row.entityId).find(isMarketStructure);
    if(!seller)return {ok:false,failureReason:"NO_MARKET"};
    const sellerId=seller.entityId;

    const [priceRows]=await conn.query(
      `SELECT price FROM emergent_market_state
        WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1`,
      [simulationId,locationId,goodCode]
    );
    const unitPrice=Number(priceRows[0]?.price||0);
    if(unitPrice<=0)return {ok:false,failureReason:"GOOD_NOT_PRICED",goodCode};

    const [stock]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE`,
      [simulationId,sellerId,goodCode]
    );
    const [account]=await conn.query(
      `SELECT id,balance FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,entityId]
    );
    if(!stock.length||Number(stock[0].quantity)<1)return {ok:false,failureReason:"GOOD_OUT_OF_STOCK",goodCode};
    if(!account.length||Number(account[0].balance)<unitPrice)return {ok:false,failureReason:"INSUFFICIENT_FUNDS",price:unitPrice,goodCode};

    const [sellerAccount]=await conn.query(
      `SELECT id,balance FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,sellerId]
    );
    if(!sellerAccount.length)return {ok:false,failureReason:"SELLER_ACCOUNT_MISSING"};

    await conn.query(
      `UPDATE emergent_inventory SET quantity=quantity-1,updated_simulation_at=?,version=version+1 WHERE id=?`,
      [simulationTime,stock[0].id]
    );
    const [buyerStock]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE`,
      [simulationId,entityId,goodCode]
    );
    if(buyerStock.length){
      await conn.query(
        `UPDATE emergent_inventory SET quantity=quantity+1,updated_simulation_at=?,version=version+1 WHERE id=?`,
        [simulationTime,buyerStock[0].id]
      );
    }else{
      await conn.query(
        `INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)`,
        [uuid(),simulationId,entityId,goodCode,1,simulationTime]
      );
    }
    await conn.query(
      `UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
      [unitPrice,unitPrice,simulationTime,account[0].id]
    );
    await conn.query(
      `UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
      [unitPrice,unitPrice,simulationTime,sellerAccount[0].id]
    );
    await conn.query(
      `INSERT INTO emergent_trades
        (id,simulation_id,buyer_entity_id,seller_entity_id,location_id,good_code,quantity,unit_price,total,simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`,
      [uuid(),simulationId,entityId,sellerId,locationId,goodCode,1,unitPrice,unitPrice,simulationTime]
    );
    return {ok:true,economicType:"TRADE",good:goodCode,quantity:1,unitPrice,total:unitPrice,sellerEntityId:sellerId,locationId};
  }

  const sellMatch=action.match(/^SELL_(?:GOOD_)?([A-Z][A-Z0-9_]*)$/);
  if(sellMatch){
    const goodCode=normalize(sellMatch[1]);
    const [loc]=await conn.query(
      `SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,entityId]
    );
    const locationId=loc[0]?.locationId;
    if(!locationId)return {ok:false,failureReason:"NO_LOCATION"};
    const [marketStructureRows]=await conn.query(
      `SELECT BIN_TO_UUID(entity_id) entityId,structure_type type,attributes
         FROM emergent_structures
        WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?)`,
      [simulationId,locationId]
    );
    const [marketSystemRows]=await conn.query(
      'SELECT BIN_TO_UUID(JSON_UNQUOTE(JSON_EXTRACT(attributes,"$.systemEntityId"))) entityId,system_type type,attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND stage<>"ENDED"',
      [simulationId,locationId]
    );
    const market=[...marketStructureRows,...marketSystemRows].filter(row=>row.entityId).find(isMarketStructure);
    if(!market)return {ok:false,failureReason:"NO_MARKET"};
    const marketId=market.entityId;
    const [inventory]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE`,
      [simulationId,entityId,goodCode]
    );
    if(!inventory.length||Number(inventory[0].quantity)<1)return {ok:false,failureReason:"GOOD_NOT_IN_INVENTORY",goodCode};
    const [priceRows]=await conn.query(
      `SELECT price FROM emergent_market_state
        WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1`,
      [simulationId,locationId,goodCode]
    );
    const marketPrice=Number(priceRows[0]?.price||0);
    if(marketPrice<=0)return {ok:false,failureReason:"GOOD_NOT_PRICED",goodCode};
    const unitPrice=Number((marketPrice*.80).toFixed(4));
    const [sellerAccount]=await conn.query(
      `SELECT id FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,entityId]
    );
    const [marketAccount]=await conn.query(
      `SELECT id,balance FROM emergent_economy_accounts
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,marketId]
    );
    if(!sellerAccount.length||!marketAccount.length)return {ok:false,failureReason:"ECONOMIC_ACCOUNT_MISSING"};
    if(Number(marketAccount[0].balance)<unitPrice)return {ok:false,failureReason:"MARKET_CANNOT_BUY",required:unitPrice};
    await conn.query(
      `UPDATE emergent_inventory SET quantity=quantity-1,updated_simulation_at=?,version=version+1 WHERE id=?`,
      [simulationTime,inventory[0].id]
    );
    const [marketStock]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE`,
      [simulationId,marketId,goodCode]
    );
    if(marketStock.length){
      await conn.query(
        `UPDATE emergent_inventory SET quantity=quantity+1,updated_simulation_at=?,version=version+1 WHERE id=?`,
        [simulationTime,marketStock[0].id]
      );
    }else{
      await conn.query(
        `INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
         VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)`,
        [uuid(),simulationId,marketId,goodCode,1,simulationTime]
      );
    }
    await conn.query(
      `UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
      [unitPrice,unitPrice,simulationTime,sellerAccount[0].id]
    );
    await conn.query(
      `UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,
      [unitPrice,unitPrice,simulationTime,marketAccount[0].id]
    );
    await conn.query(
      `INSERT INTO emergent_trades
        (id,simulation_id,buyer_entity_id,seller_entity_id,location_id,good_code,quantity,unit_price,total,simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`,
      [uuid(),simulationId,marketId,entityId,locationId,goodCode,1,unitPrice,unitPrice,simulationTime]
    );
    return {ok:true,economicType:"TRADE",good:goodCode,quantity:1,unitPrice,total:unitPrice,buyerEntityId:marketId,locationId};
  }

  if(action==="PRODUCE_GOODS"){
    const [location]=await conn.query(
      `SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,entityId]
    );
    const locationId=location[0]?.locationId;
    if(!locationId)return {ok:false,failureReason:"NO_LOCATION"};

    const [structure]=await conn.query(
      `SELECT BIN_TO_UUID(entity_id) producerEntityId
        FROM emergent_structures
        WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,locationId]
    );
    const producer=structure[0]?.producerEntityId;
    if(!producer)return {ok:false,failureReason:"NO_PRODUCTION_STRUCTURE"};

    const [job]=await conn.query(
      `SELECT id FROM emergent_jobs
        WHERE simulation_id=UUID_TO_BIN(?) AND employer_entity_id=UUID_TO_BIN(?)
          AND employee_entity_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,
      [simulationId,producer,entityId]
    );
    if(!job.length)return {ok:false,failureReason:"PRODUCTION_REQUIRES_ACTIVE_JOB"};

    const [locationRows]=await conn.query(
      `SELECT attributes,version FROM entities
        WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [locationId,simulationId]
    );
    if(!locationRows.length)return {ok:false,failureReason:"LOCATION_NOT_FOUND"};
    const attributes=parseJson(locationRows[0].attributes,{});
    const resources={...(attributes.resources||{})};
    const water=Number(resources.water||0);
    if(water<1)return {ok:false,failureReason:"PRODUCTION_RESOURCE_UNAVAILABLE",resource:"water",available:water,required:1};
    resources.water=Number((water-1).toFixed(4));
    await conn.query(
      `UPDATE entities SET attributes=?,version=version+1
        WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,
      [JSON.stringify({...attributes,resources}),locationId,simulationId,Number(locationRows[0].version||1)]
    );

    const [business]=await conn.query(
      `SELECT production_capacity productionCapacity,status FROM emergent_businesses
        WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [simulationId,producer]
    );
    if(business.length&&String(business[0].status)!=="ACTIVE")return {ok:false,failureReason:"BUSINESS_NOT_ACTIVE"};
    const capacity=Math.max(.25,Math.min(10,Number(business[0]?.productionCapacity||1)));
    const quantity=Number((2*capacity).toFixed(4));

    const [stock]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code='TOOLS' LIMIT 1 FOR UPDATE`,
      [simulationId,producer]
    );
    if(stock.length){
      await conn.query(
        `UPDATE emergent_inventory SET quantity=quantity+?,updated_simulation_at=?,version=version+1 WHERE id=?`,
        [quantity,simulationTime,stock[0].id]
      );
    }else{
      await conn.query(
        `INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'TOOLS',?,?,1)`,
        [uuid(),simulationId,producer,quantity,simulationTime]
      );
    }
    await conn.query(
      `INSERT INTO emergent_production_history
        (id,simulation_id,producer_entity_id,structure_entity_id,good_code,quantity,inputs,simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'TOOLS',?,?,?,?)`,
      [uuid(),simulationId,entityId,producer,quantity,JSON.stringify({water:1,capacity}),simulationTime]
    );
    return {ok:true,economicType:"PRODUCTION",good:"TOOLS",quantity,producerEntityId:producer,inputResource:"water",inputQuantity:1,capacity};
  }
  if(action==="WORK_JOB"){
    const [job]=await conn.query(`SELECT id,wage_per_hour wage,employer_entity_id employerId FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status="ACTIVE" LIMIT 1 FOR UPDATE`,[simulationId,entityId]);
    if(!job.length)return {ok:false,failureReason:"NO_JOB"};
    const wage=Number(job[0].wage||0.75);
    const workedHours=Math.max(0.25,Math.min(12,Number(durationMinutes||120)/60));
    const gross=Number((wage*workedHours).toFixed(4));
    const [policyRows]=await conn.query(`SELECT parameters FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND status="ENACTED" ORDER BY updated_simulation_at DESC LIMIT 1`,[simulationId]);
    const policy=parseJson(policyRows[0]?.parameters,{});
    const mandatoryTax=normalize(policy.fundingModel)==="COMMON_POOL" ? clamp(Number(policy.contributionRate||0),0,.35) : 0;
    const tax=Number((gross*mandatoryTax).toFixed(4));
    const amount=Number((gross-tax).toFixed(4));
    const [employer]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,job[0].employerId]);
    const [employee]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,entityId]);
    if(!employer.length||!employee.length)return {ok:false,failureReason:"ECONOMIC_ACCOUNT_MISSING"};

    let governmentAccount=null;
    const subsidyRate=Math.max(0,Math.min(.35,Number(policy.wageSubsidyRate||0)));
    if(tax>0||subsidyRate>0){
      const [systemRows]=await conn.query(`SELECT attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type="GOVERNANCE" LIMIT 1`,[simulationId]);
      const govAttrs=parseJson(systemRows[0]?.attributes,{});
      const govId=govAttrs.systemEntityId;
      if(govId){
        const [rows]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,govId]);
        if(rows.length) governmentAccount=rows[0];
      }
    }
    const wageSubsidy=governmentAccount&&subsidyRate>0
      ?Math.min(Number(governmentAccount.balance||0),Number((gross*subsidyRate).toFixed(4)))
      :0;
    const employerAvailable=Number(employer[0].balance||0);
    if(employerAvailable+wageSubsidy<gross){
      await conn.query(`UPDATE emergent_jobs SET status='ENDED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,[job[0].id]);
      return {ok:false,failureReason:"EMPLOYER_CANNOT_PAY",required:gross,available:employerAvailable};
    }
    if(wageSubsidy>0){
      await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[wageSubsidy,wageSubsidy,simulationTime,employer[0].id]);
      await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[wageSubsidy,wageSubsidy,simulationTime,governmentAccount.id]);
    }
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[gross,simulationTime,employer[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[amount,amount,simulationTime,employee[0].id]);
    if(governmentAccount&&tax>0){await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[tax,tax,simulationTime,governmentAccount.id]);}
    return {ok:true,economicType:"WAGE",grossWage:gross,netWage:amount,tax,wageSubsidy,workedHours,employerEntityId:job[0].employerId};
  }
  return null;
}

async function evolveSociety(simulationId,simulationTime){
  await ensureCatalog(simulationId,simulationTime);
  await ensureAccounts(simulationId,simulationTime);
  await ensureMarketInventory(simulationId,simulationTime);
  await ensureBusinesses(simulationId,simulationTime);
  await ensureJobs(simulationId,simulationTime);
  const laborChanges=await matchLaborMarket(simulationId,simulationTime);
  const wholesale=await restockMarkets(simulationId,simulationTime);
  await evolvePrices(simulationId,simulationTime);
  await ensureGovernanceMembers(simulationId,simulationTime);
  const politics=await evolvePolitics(simulationId,simulationTime);
  const business=await evolveBusinesses(simulationId,simulationTime);
  const economicPolicy=await ensureEconomicPolicyProposal(simulationId,simulationTime,business);
  const wealth=await recordWealth(simulationId,simulationTime);
  logger.debugThrottled(`SOCIETY_EVOLUTION:${simulationId}`,120000,{simulationId,simulationTime,wealth,politics,wholesale,business,laborChanges,economicPolicy},"society evolution completed");
  return {wealth,politics,wholesale,business,laborChanges,economicPolicy};
}

async function getSocietySnapshot(simulationId){
  const [[systems],[goods],[markets],[accounts],[jobs],[trades],[metrics],[policies],[conflicts],[businessMetrics],[businesses],[events]] = await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) id,system_type systemType,name,stage,attributes,created_simulation_at createdAt,updated_simulation_at updatedAt FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 30`,[simulationId]),
    pool.query(`SELECT code,name,category,unit,base_price basePrice FROM emergent_goods WHERE simulation_id=UUID_TO_BIN(?) ORDER BY code`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(location_id) locationId,good_code goodCode,price,supply,demand,updated_simulation_at updatedAt FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) ORDER BY updated_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(entity_id) entityId,balance,lifetime_income lifetimeIncome,lifetime_spending lifetimeSpending,last_updated_simulation_at updatedAt FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY balance DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(employer_entity_id) employerEntityId,BIN_TO_UUID(employee_entity_id) employeeEntityId,role,wage_per_hour wagePerHour,status,hired_simulation_at hiredAt FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) ORDER BY hired_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(buyer_entity_id) buyerEntityId,BIN_TO_UUID(seller_entity_id) sellerEntityId,BIN_TO_UUID(location_id) locationId,good_code goodCode,quantity,unit_price unitPrice,total,simulation_at simulationAt FROM emergent_trades WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT population_count populationCount,total_wealth totalWealth,average_wealth averageWealth,gini,average_food_price averageFoodPrice,total_trade_value totalTradeValue,simulation_at simulationAt FROM emergent_economic_metrics WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 48`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(governance_system_id) governanceSystemId,issue_code issueCode,title,statement,parameters,support_score supportScore,opposition_score oppositionScore,status,created_simulation_at createdAt FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,conflict_type conflictType,left_type leftType,BIN_TO_UUID(left_id) leftId,right_type rightType,BIN_TO_UUID(right_id) rightId,intensity,status,metadata,created_simulation_at createdAt,resolved_simulation_at resolvedAt FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId])
,    pool.query(`SELECT business_count businessCount,active_business_count activeBusinessCount,failed_business_count failedBusinessCount,unemployed_count unemployedCount,employed_count employedCount,revenue,input_cost inputCost,wage_cost wageCost,profit,production_value productionValue,investment,simulation_at simulationAt FROM emergent_business_metrics WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 48`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(entity_id) entityId,BIN_TO_UUID(owner_entity_id) ownerEntityId,status,production_capacity productionCapacity,recent_revenue recentRevenue,recent_input_cost recentInputCost,recent_wage_cost recentWageCost,recent_profit recentProfit,cumulative_profit cumulativeProfit,cumulative_investment cumulativeInvestment,failure_count failureCount,last_evaluated_simulation_at lastEvaluated,updated_simulation_at updatedAt FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) ORDER BY updated_simulation_at DESC LIMIT 80`,[simulationId]),
    pool.query(
      `SELECT BIN_TO_UUID(e.id) id,et.code type,et.category,e.title,e.description,e.simulation_at simulationAt,e.importance,e.status,
              JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.locationId')) locationId,e.metadata
         FROM events e
         JOIN event_types et ON et.id=e.event_type_id
        WHERE e.simulation_id=UUID_TO_BIN(?)
          AND e.status<>'CANCELLED'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.emergent'))='true'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.kind')) IS NOT NULL
        ORDER BY e.simulation_at DESC
        LIMIT 40`,
      [simulationId]
    )
  ]);
  const [[openProposals],[openDefinitions]]=await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(scope_location_id) scopeLocationId,
      kind,code,title,definition,validation,support_score supportScore,required_support requiredSupport,status,
      created_simulation_at createdAt,decided_simulation_at decidedAt
      FROM emergent_world_proposals WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 40`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,kind,code,name,category,BIN_TO_UUID(scope_location_id) scopeLocationId,
      BIN_TO_UUID(origin_entity_id) originEntityId,definition,status,created_simulation_at createdAt
      FROM emergent_definition_catalog WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 60`,[simulationId])
  ]);
  const decode=rows=>rows.map(row=>{for(const k of ["attributes","parameters","metadata"])if(row[k]!==undefined)row[k]=parseJson(row[k],row[k]);return row;});
  const decodeOpen=rows=>rows.map(row=>{for(const k of ["definition","validation"])if(row[k]!==undefined)row[k]=parseJson(row[k],row[k]);return row;});
  return {systems:decode(systems),goods,markets,accounts,jobs,trades,metrics,policies:decode(policies),conflicts:decode(conflicts),businessMetrics,businesses,events:decode(events),openEnded:{proposals:decodeOpen(openProposals),definitions:decodeOpen(openDefinitions)}};
}

module.exports={evolveSociety,evolvePolitics,executeEconomicAction,consumePurchasedFood,getSocietySnapshot,gini,ensureCatalog,restockMarkets,isMarketStructure,isProducerStructure,ensureBusinesses,evolveBusinesses,matchLaborMarket,latestEconomicPolicy,ensureEconomicPolicyProposal};