const { pool } = require("../db/pool");
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
  const [entities]=await pool.query(`SELECT BIN_TO_UUID(e.id) id FROM entities e WHERE e.simulation_id=UUID_TO_BIN(?) AND e.status="ACTIVE"`,[simulationId]);
  for(const entity of entities){
    const [rows]=await pool.query(`SELECT balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entity.id]);
    if(!rows.length){
      const starting=entity.id===null?20:20;
      await pool.query(`INSERT INTO emergent_economy_accounts(id,simulation_id,entity_id,balance,lifetime_income,lifetime_spending,last_updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,0,0,?,1)`,[uuid(),simulationId,entity.id,starting,simulationTime]);
    }
  }
}

async function ensureMarketInventory(simulationId,simulationTime){
  const [markets]=await pool.query(`SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,[simulationId]);
  for(const market of markets){
    if(!["MARKET","WORKSHOP"].includes(normalize(market.type)))continue;
    const good=normalize(market.type)==="MARKET"?"FOOD":"TOOLS";
    const seed=normalize(market.type)==="MARKET"?120:24;
    const [rows]=await pool.query(`SELECT quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1`,[simulationId,market.entityId,good]);
    if(!rows.length){
      await pool.query(`INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)`,[uuid(),simulationId,market.entityId,good,seed,simulationTime]);
    }else if(Number(rows[0].quantity)<5){
      await pool.query(`UPDATE emergent_inventory SET quantity=?,updated_simulation_at=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=?`,[seed,simulationTime,simulationId,market.entityId,good]);
    }
  }
}

async function ensureJobs(simulationId,simulationTime){
  const [structures]=await pool.query(`SELECT BIN_TO_UUID(es.id) id,BIN_TO_UUID(es.entity_id) employerId,BIN_TO_UUID(es.scope_location_id) locationId,es.structure_type type,BIN_TO_UUID(es.project_id) projectId FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)`,[simulationId]);
  for(const structure of structures){
    const role=normalize(structure.type)==="WORKSHOP"?"CRAFTSPERSON":"SELLER";
    const wage=normalize(structure.type)==="WORKSHOP"?.9:.75;
    const [members]=await pool.query(`SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_project_members WHERE simulation_id=UUID_TO_BIN(?) AND project_id=UUID_TO_BIN(?) AND entity_id<>UUID_TO_BIN(?) ORDER BY joined_simulation_at LIMIT 8`,[simulationId,structure.projectId,structure.employerId]);
    for(const member of members){
      const [existing]=await pool.query(`SELECT id FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status="ACTIVE" LIMIT 1`,[simulationId,member.entityId]);
      if(existing.length)continue;
      await pool.query(`INSERT INTO emergent_jobs(id,simulation_id,employer_entity_id,employee_entity_id,role,wage_per_hour,status,hired_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, "ACTIVE",?,1)`,
        [uuid(),simulationId,structure.employerId,member.entityId,role,wage,simulationTime]);
    }
  }
}

async function evolvePrices(simulationId,simulationTime){
  const [markets]=await pool.query(`SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) locationId FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?) AND es.structure_type="MARKET"`,[simulationId]);
  for(const market of markets){
    const [stock]=await pool.query(`SELECT COALESCE(SUM(quantity),0) supply FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code="FOOD"`,[simulationId,market.entityId]);
    const [demand]=await pool.query(`SELECT COUNT(*) demand FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND action_type="BUY_FOOD" AND completed_simulation_at>=DATE_SUB(?,INTERVAL 24 HOUR) AND result IS NOT NULL`,[simulationId,simulationTime]);
    const [base]=await pool.query(`SELECT base_price FROM emergent_goods WHERE simulation_id=UUID_TO_BIN(?) AND code="FOOD" LIMIT 1`,[simulationId]);
    const supplyValue=Number(stock[0]?.supply||0),demandValue=Number(demand[0]?.demand||0),basePrice=Number(base[0]?.base_price||1);
    const price=Number((basePrice*clamp(1+(demandValue*.18)/Math.max(5,supplyValue),.55,3)).toFixed(4));
    await pool.query(`INSERT INTO emergent_market_state(id,simulation_id,location_id,good_code,price,supply,demand,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),"FOOD",?,?,?,?,1) ON DUPLICATE KEY UPDATE price=VALUES(price),supply=VALUES(supply),demand=VALUES(demand),updated_simulation_at=VALUES(updated_simulation_at),version=version+1`,[uuid(),simulationId,market.locationId,price,supplyValue,demandValue,simulationTime]);
  }
}

async function evolvePolitics(simulationId,simulationTime){
  const [systems]=await pool.query(`SELECT BIN_TO_UUID(id) id FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type="GOVERNANCE" AND stage<>"ENDED" LIMIT 1`,[simulationId]);
  if(!systems.length)return {governanceId:null,enacted:[]};
  const governanceId=systems[0].id;
  const [people]=await pool.query(`SELECT BIN_TO_UUID(e.id) entityId,e.display_name displayName FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN("00000000-0000-4000-8000-000000000001") AND e.status="ACTIVE"`,[simulationId]);
  const traitIds=people.map(x=>x.entityId),placeholders=traitIds.map(()=>"UUID_TO_BIN(?)").join(",");
  const traitRows=traitIds.length?(await pool.query(`SELECT BIN_TO_UUID(etc.entity_id) entityId,td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id IN (${placeholders})`.replace("${placeholders}",placeholders),traitIds))[0]:[];
  const traitMap=new Map();for(const row of traitRows){if(!traitMap.has(row.entityId))traitMap.set(row.entityId,{});traitMap.get(row.entityId)[normalize(row.code)]=Number(row.value)}
  const [policies]=await pool.query(`SELECT BIN_TO_UUID(id) id,title,statement,parameters,status FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND governance_system_id=UUID_TO_BIN(?) AND status="PROPOSED" ORDER BY created_simulation_at ASC LIMIT 6`,[simulationId,governanceId]);
  const enacted=[];
  for(const policy of policies){
    for(const person of people){
      const [existing]=await pool.query(`SELECT id FROM emergent_policy_votes WHERE simulation_id=UUID_TO_BIN(?) AND policy_id=UUID_TO_BIN(?) AND voter_entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,policy.id,person.entityId]);
      if(existing.length)continue;
      const traits=traitMap.get(person.entityId)||{},params=parseJson(policy.parameters,{}),rate=Number(params.contributionRate||0);
      const title=normalize(policy.title),isVoluntary=title.includes("VOLUNTARY")||normalize(params.fundingModel)==="VOLUNTARY";
      const score=clamp((isVoluntary?Number(traits.INDEPENDENCE||.5)-.5:Number(traits.CONSCIENTIOUSNESS||.5)-.5)*1.25+Number(traits.EMPATHY||.5)*.25+.5);
      const choice=score>=.5?"YES":"NO";
      await pool.query(`INSERT INTO emergent_policy_votes(id,simulation_id,policy_id,voter_entity_id,choice,score,rationale,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,[uuid(),simulationId,policy.id,person.entityId,choice,score,JSON.stringify({independence:Number(traits.INDEPENDENCE||.5),conscientiousness:Number(traits.CONSCIENTIOUSNESS||.5),empathy:Number(traits.EMPATHY||.5),contributionRate:rate}),simulationTime]);
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
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(entity_id) entityId,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY balance DESC`,[simulationId]);
  const pop=rows.length;if(!pop)return null;
  const values=rows.map(r=>Number(r.balance||0)),total=values.reduce((s,v)=>s+v,0),avg=total/pop,inequality=gini(values);
  for(let i=0;i<rows.length;i++)await pool.query(`INSERT INTO emergent_wealth_history(id,simulation_id,entity_id,balance,rank_position,population_count,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,[uuid(),simulationId,rows[i].entityId,Number(rows[i].balance||0),i+1,pop,simulationTime]);
  const [price]=await pool.query(`SELECT AVG(price) value FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) AND good_code="FOOD"`,[simulationId]);
  const [trade]=await pool.query(`SELECT COALESCE(SUM(total),0) value FROM emergent_trades WHERE simulation_id=UUID_TO_BIN(?) AND simulation_at>=DATE_SUB(?,INTERVAL 24 HOUR)`,[simulationId,simulationTime]);
  await pool.query(`INSERT INTO emergent_economic_metrics(id,simulation_id,population_count,total_wealth,average_wealth,gini,average_food_price,total_trade_value,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?)`,[uuid(),simulationId,pop,total,avg,inequality,Number(price[0]?.value||1),Number(trade[0]?.value||0),simulationTime]);
  return {population:pop,totalWealth:total,averageWealth:avg,gini:inequality};
}

async function executeEconomicAction({conn,simulationId,entityId,actionType,simulationTime}){
  const action=normalize(actionType);
  if(action==="BUY_FOOD"){
    const [loc]=await conn.query(`SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);
    const locationId=loc[0]?.locationId;if(!locationId)return {ok:false,failureReason:"NO_LOCATION"};
    const [seller]=await conn.query(`SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND structure_type="MARKET" LIMIT 1`,[simulationId,locationId]);
    if(!seller.length)return {ok:false,failureReason:"NO_MARKET"};
    const sellerId=seller[0].entityId;
    const [price]=await conn.query(`SELECT price FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND good_code="FOOD" LIMIT 1`,[simulationId,locationId]);
    const unitPrice=Number(price[0]?.price||1);
    const [stock]=await conn.query(`SELECT id,quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code="FOOD" FOR UPDATE`,[simulationId,sellerId]);
    const [account]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,entityId]);
    if(!stock.length||Number(stock[0].quantity)<1)return {ok:false,failureReason:"FOOD_OUT_OF_STOCK",resource:"FOOD"};
    if(!account.length||Number(account[0].balance)<unitPrice)return {ok:false,failureReason:"INSUFFICIENT_FUNDS",price:unitPrice};
    const [sellerAccount]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,sellerId]);
    if(!sellerAccount.length)return {ok:false,failureReason:"SELLER_ACCOUNT_MISSING"};
    await conn.query(`UPDATE emergent_inventory SET quantity=quantity-1,updated_simulation_at=?,version=version+1 WHERE id=?`,[simulationTime,stock[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,lifetime_spending=lifetime_spending+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[unitPrice,unitPrice,simulationTime,account[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[unitPrice,unitPrice,simulationTime,sellerAccount[0].id]);
    await conn.query(`INSERT INTO emergent_trades(id,simulation_id,buyer_entity_id,seller_entity_id,location_id,good_code,quantity,unit_price,total,simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),"FOOD",1,?,?,?)`,[uuid(),simulationId,entityId,sellerId,locationId,unitPrice,unitPrice,simulationTime]);
    return {ok:true,economicType:"TRADE",good:"FOOD",quantity:1,unitPrice,total:unitPrice,resource:"FOOD",sellerEntityId:sellerId};
  }
  if(action==="WORK_JOB"){
    const [job]=await conn.query(`SELECT id,wage_per_hour wage,employer_entity_id employerId FROM emergent_jobs WHERE simulation_id=UUID_TO_BIN(?) AND employee_entity_id=UUID_TO_BIN(?) AND status="ACTIVE" LIMIT 1 FOR UPDATE`,[simulationId,entityId]);
    if(!job.length)return {ok:false,failureReason:"NO_JOB"};
    const wage=Number(job[0].wage||0.75);
    const amount=Number((wage*2).toFixed(4));
    const [employer]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,job[0].employerId]);
    const [employee]=await conn.query(`SELECT id,balance FROM emergent_economy_accounts WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) FOR UPDATE`,[simulationId,entityId]);
    if(!employer.length||Number(employer[0].balance)<amount)return {ok:false,failureReason:"EMPLOYER_CANNOT_PAY",required:amount};
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance-?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[amount,simulationTime,employer[0].id]);
    await conn.query(`UPDATE emergent_economy_accounts SET balance=balance+?,lifetime_income=lifetime_income+?,last_updated_simulation_at=?,version=version+1 WHERE id=?`,[amount,amount,simulationTime,employee[0].id]);
    return {ok:true,economicType:"WAGE",grossWage:amount,netWage:amount,employerEntityId:job[0].employerId};
  }
  return null;
}

async function evolveSociety(simulationId,simulationTime){
  await ensureCatalog(simulationId,simulationTime);
  await ensureAccounts(simulationId,simulationTime);
  await ensureMarketInventory(simulationId,simulationTime);
  await ensureJobs(simulationId,simulationTime);
  await evolvePrices(simulationId,simulationTime);
  await ensureGovernanceMembers(simulationId,simulationTime);
  const politics=await evolvePolitics(simulationId,simulationTime);
  const wealth=await recordWealth(simulationId,simulationTime);
  logger.info({simulationId,simulationTime,wealth,politics},"society evolution completed");
  return {wealth,politics};
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
  const decode=rows=>rows.map(row=>{for(const k of ["attributes","parameters","metadata"])if(row[k]!==undefined)row[k]=parseJson(row[k],row[k]);return row;});
  return {systems:decode(systems),goods,markets,accounts,jobs,trades,metrics,policies:decode(policies),conflicts:decode(conflicts)};
}

module.exports={evolveSociety,evolvePolitics,executeEconomicAction,getSocietySnapshot,gini,ensureCatalog};