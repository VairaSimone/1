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
  const [entities]=await pool.query(`SELECT DISTINCT BIN_TO_UUID(e.id) id
    FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND e.status="ACTIVE"
      AND (et.code IN ("PERSON","ORGANIZATION") OR EXISTS (SELECT 1 FROM emergent_structures es WHERE es.simulation_id=e.simulation_id AND es.entity_id=e.id))`,[simulationId]);
  for(const entity of entities){
    const [rows]=await pool.query(`SELECT balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entity.id]);
    if(!rows.length){
      const starting=entity.id===null?20:20;
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
  }
}
async function ensureJobs(simulationId,simulationTime){
  const [structures]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) employerId,BIN_TO_UUID(es.project_id) projectId,
            es.structure_type type,es.attributes
       FROM emergent_structures es
      WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );

  for(const structure of structures){
    const definition=definitionFromStructure(structure);
    const workActivities=Array.isArray(definition.activities)
      ?definition.activities.filter(activity=>{
          const category=normalize(activity?.category);
          return category==="WORK"||category==="PRODUCTION"||category==="CRAFT";
        })
      : [];
    const shouldHire=isProducerStructure(structure)||workActivities.length>0;
    if(!shouldHire)continue;

    const role=workActivities[0]?.name
      ? String(workActivities[0].name).slice(0,80)
      : normalize(structure.type)==="WORKSHOP"?"CRAFTSPERSON":"WORKER";
    const wage=Number(
      workActivities[0]?.wagePerHour ??
      (normalize(definition.category)==="HIGH_SKILL" ? 1.1 : 0.75)
    );
    const safeWage=Number.isFinite(wage)?Math.max(0.25,Math.min(5,wage)):0.75;

    const [members]=await pool.query(
      `SELECT BIN_TO_UUID(entity_id) entityId
         FROM emergent_project_members
        WHERE simulation_id=UUID_TO_BIN(?) AND project_id=UUID_TO_BIN(?) AND entity_id<>UUID_TO_BIN(?)
        ORDER BY joined_simulation_at LIMIT 8`,
      [simulationId,structure.projectId,structure.employerId]
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
}
async function evolvePrices(simulationId,simulationTime){
  const [markets]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type,es.attributes
       FROM emergent_structures es
      WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  const marketRows=markets.filter(isMarketStructure);
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
      const price=Number((basePrice*clamp(1+pressure,.55,3)).toFixed(4));
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
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type,es.attributes
       FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
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
      transfers.push({marketEntityId:market.entityId,producerEntityId:candidate.producer.entityId,goodCode:good.goodCode,quantity,unitPrice,total,simulationAt:simulationTime});
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

async function executeEconomicAction({conn,simulationId,entityId,actionType,simulationTime,durationMinutes=120}){
  const action=normalize(actionType);
  if(action==="BUY_FOOD"){
    const [loc]=await conn.query(`SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);
    const locationId=loc[0]?.locationId;if(!locationId)return {ok:false,failureReason:"NO_LOCATION"};
    const [sellerRows]=await conn.query(
      `SELECT BIN_TO_UUID(entity_id) entityId,structure_type type,attributes
         FROM emergent_structures
        WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?)`,
      [simulationId,locationId]
    );
    const seller=sellerRows.find(isMarketStructure);
    if(!seller)return {ok:false,failureReason:"NO_MARKET"};
    const sellerId=seller.entityId;
    const [price]=await conn.query(`SELECT price FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND good_code="FOOD" LIMIT 1`,[simulationId,locationId]);
    const unitPrice=Number(price[0]?.price||1);
    const [stock]=await conn.query(`SELECT id,quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code="FOOD" FOR UPDATE`,[simulationId,sellerId]);
    const [account]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,entityId]);
    if(!stock.length||Number(stock[0].quantity)<1)return {ok:false,failureReason:"FOOD_OUT_OF_STOCK",resource:"FOOD"};
    if(!account.length||Number(account[0].balance)<unitPrice)return {ok:false,failureReason:"INSUFFICIENT_FUNDS",price:unitPrice};
    const [sellerAccount]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,sellerId]);
    if(!sellerAccount.length)return {ok:false,failureReason:"SELLER_ACCOUNT_MISSING"};
    await conn.query(`UPDATE emergent_inventory SET quantity=quantity-1,updated_simulation_at=?,version=version+1 WHERE id=?`,[simulationTime,stock[0].id]);
    const [buyerFood]=await conn.query(`SELECT id,quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code="FOOD" FOR UPDATE`,[simulationId,entityId]);
    if(buyerFood.length) await conn.query(`UPDATE emergent_inventory SET quantity=quantity+1,updated_simulation_at=?,version=version+1 WHERE id=?`,[simulationTime,buyerFood[0].id]);
    else await conn.query(`INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),"FOOD",1,?,1)`,[uuid(),simulationId,entityId,simulationTime]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[unitPrice,unitPrice,simulationTime,account[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[unitPrice,unitPrice,simulationTime,sellerAccount[0].id]);
    await conn.query(`INSERT INTO emergent_trades(id,simulation_id,buyer_entity_id,seller_entity_id,location_id,good_code,quantity,unit_price,total,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),"FOOD",1,?,?,?)`,[uuid(),simulationId,entityId,sellerId,locationId,unitPrice,unitPrice,simulationTime]);
    return {ok:true,economicType:"TRADE",good:"FOOD",quantity:1,unitPrice,total:unitPrice,resource:"FOOD",sellerEntityId:sellerId,locationId,needEffect:null};
  }
  if(action==="PRODUCE_GOODS"){
    const [location]=await conn.query(
      `SELECT BIN_TO_UUID(location_id) locationId
         FROM entity_locations_current
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

    const [stock]=await conn.query(
      `SELECT id,quantity FROM emergent_inventory
        WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code='TOOLS'
        LIMIT 1 FOR UPDATE`,
      [simulationId,producer]
    );
    const quantity=2;
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
    return {ok:true,economicType:"PRODUCTION",good:"TOOLS",quantity,producerEntityId:producer,inputResource:"water",inputQuantity:1};
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
    if(!employer.length||Number(employer[0].balance)<gross)return {ok:false,failureReason:"EMPLOYER_CANNOT_PAY",required:gross};
    let governmentAccount=null;
    if(tax>0){
      const [govRows]=await conn.query(`SELECT parameters FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND status="ENACTED" ORDER BY updated_simulation_at DESC LIMIT 1`,[simulationId]);
      const govParams=parseJson(govRows[0]?.parameters,{});
      const [systemRows]=await conn.query(`SELECT attributes FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type="GOVERNANCE" LIMIT 1`,[simulationId]);
      const govAttrs=parseJson(systemRows[0]?.attributes,{});
      const govId=govAttrs.systemEntityId;
      if(govId){
        const [rows]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,govId]);
        if(rows.length) governmentAccount=rows[0];
      }
    }
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[gross,simulationTime,employer[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[amount,amount,simulationTime,employee[0].id]);
    if(governmentAccount){await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[tax,tax,simulationTime,governmentAccount.id]);}
    return {ok:true,economicType:"WAGE",grossWage:gross,netWage:amount,tax,workedHours,employerEntityId:job[0].employerId};
  }
  return null;
}

async function evolveSociety(simulationId,simulationTime){
  await ensureCatalog(simulationId,simulationTime);
  await ensureAccounts(simulationId,simulationTime);
  await ensureMarketInventory(simulationId,simulationTime);
  await ensureJobs(simulationId,simulationTime);
  const wholesale=await restockMarkets(simulationId,simulationTime);
  await evolvePrices(simulationId,simulationTime);
  await ensureGovernanceMembers(simulationId,simulationTime);
  const politics=await evolvePolitics(simulationId,simulationTime);
  const wealth=await recordWealth(simulationId,simulationTime);
  logger.info({simulationId,simulationTime,wealth,politics,wholesale},"society evolution completed");
  return {wealth,politics,wholesale};
}

async function getSocietySnapshot(simulationId){
  const [[systems],[goods],[markets],[accounts],[jobs],[trades],[metrics],[policies],[conflicts]] = await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) id,system_type systemType,name,stage,attributes,created_simulation_at createdAt,updated_simulation_at updatedAt FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 30`,[simulationId]),
    pool.query(`SELECT code,name,category,unit,base_price basePrice FROM emergent_goods WHERE simulation_id=UUID_TO_BIN(?) ORDER BY code`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(location_id) locationId,good_code goodCode,price,supply,demand,updated_simulation_at updatedAt FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) ORDER BY updated_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(entity_id) entityId,balance,lifetime_income lifetimeIncome,lifetime_spending lifetimeSpending,last_updated_simulation_at updatedAt FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY balance DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(employer_entity_id) employerEntityId,BIN_TO_UUID(employee_entity_id) employeeEntityId,role,wage_per_hour wagePerHour,status,hired_simulation_at hiredAt FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) ORDER BY hired_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(buyer_entity_id) buyerEntityId,BIN_TO_UUID(seller_entity_id) sellerEntityId,BIN_TO_UUID(location_id) locationId,good_code goodCode,quantity,unit_price unitPrice,total,simulation_at simulationAt FROM emergent_trades WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT population_count populationCount,total_wealth totalWealth,average_wealth averageWealth,gini,average_food_price averageFoodPrice,total_trade_value totalTradeValue,simulation_at simulationAt FROM emergent_economic_metrics WHERE simulation_id=UUID_TO_BIN(?) ORDER BY simulation_at DESC LIMIT 48`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(governance_system_id) governanceSystemId,issue_code issueCode,title,statement,parameters,support_score supportScore,opposition_score oppositionScore,status,created_simulation_at createdAt FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,conflict_type conflictType,left_type leftType,BIN_TO_UUID(left_id) leftId,right_type rightType,BIN_TO_UUID(right_id) rightId,intensity,status,metadata,created_simulation_at createdAt,resolved_simulation_at resolvedAt FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId])
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
  return {systems:decode(systems),goods,markets,accounts,jobs,trades,metrics,policies:decode(policies),conflicts:decode(conflicts),openEnded:{proposals:decodeOpen(openProposals),definitions:decodeOpen(openDefinitions)}};
}

module.exports={evolveSociety,evolvePolitics,executeEconomicAction,getSocietySnapshot,gini,ensureCatalog,restockMarkets,isMarketStructure,isProducerStructure};