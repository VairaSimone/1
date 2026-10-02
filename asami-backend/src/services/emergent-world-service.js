const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent } = require("./event-service");
const logger = require("../lib/logger");

const PERSON = "00000000-0000-4000-8000-000000000001";
const LOCATION = "00000000-0000-4000-8000-000000000003";

const PROJECT_RULES = [
  { projectType:"LOCAL_MARKET", issueCode:"FOOD_ACCESS", primaryNeed:"HUNGER", supportNeeds:["ACHIEVEMENT","SOCIAL_NEED"], threshold:.54, minPeople:3, requiredSupport:3, structureType:"MARKET", locationType:"MARKET", activities:["BUY_FOOD","SELL_FOOD","STORE_FOOD","EXCHANGE_GOODS"], resources:{food:80,water:25}, description:"Make food and everyday supplies easier to access locally." },
  { projectType:"COMMUNITY_HUB", issueCode:"SOCIAL_SPACE", primaryNeed:"BELONGING", supportNeeds:["SOCIAL_NEED","FUN"], threshold:.58, minPeople:3, requiredSupport:3, structureType:"COMMUNITY_HUB", locationType:"COMMUNITY", activities:["MEET","TEACH","LEARN","PLAY","ORGANIZE_EVENTS"], resources:{food:12,water:20}, description:"Create a shared place for meetings, learning and social activities." },
  { projectType:"WORKSHOP_COOPERATIVE", issueCode:"LOCAL_PRODUCTION", primaryNeed:"ACHIEVEMENT", supportNeeds:["CURIOSITY","SOCIAL_NEED"], threshold:.58, minPeople:3, requiredSupport:3, structureType:"WORKSHOP", locationType:"WORKSHOP", activities:["BUILD","REPAIR","TEACH_SKILLS","PRODUCE_GOODS","TRADE"], resources:{food:8,water:12}, description:"Pool skills, tools and time to produce or repair useful things." }
];

function parseJson(value, fallback={}) {
  if (value===null || value===undefined) return fallback;
  if (typeof value==="object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalize(value) { return String(value||"").trim().toUpperCase(); }
function clamp(value,min=0,max=1) { const n=Number(value); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):min; }
function average(values) { const a=values.map(Number).filter(Number.isFinite); return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
function needValue(actor,code) { return Number(actor?.needs?.[normalize(code)]||0); }

function candidateProjectRule(actors) {
  if (!Array.isArray(actors) || !actors.length) return null;
  let best=null;
  for (const rule of PROJECT_RULES) {
    const primary=average(actors.map(a=>needValue(a,rule.primaryNeed)));
    const support=average(actors.flatMap(a=>rule.supportNeeds.map(code=>needValue(a,code))));
    const qualifying=actors.filter(a=>needValue(a,rule.primaryNeed)>=rule.threshold && average(rule.supportNeeds.map(code=>needValue(a,code)))>=.25).length;
    if (qualifying<rule.minPeople || primary<rule.threshold) continue;
    const score=clamp((primary-rule.threshold)*1.65+support*.35+Math.min(1,qualifying/rule.minPeople)*.15);
    if (!best || score>best.score) best={rule,score,primary,qualifying};
  }
  return best;
}

function buildProjectName(rule, proposerName, scopeName) {
  const first=String(proposerName||"Locali").trim().split(/\\s+/)[0]||"Locali";
  if (rule.projectType==="LOCAL_MARKET") return "Mercato "+first+(scopeName?" di "+scopeName:"");
  if (rule.projectType==="COMMUNITY_HUB") return "Casa "+first+(scopeName?" "+scopeName:"");
  if (rule.projectType==="WORKSHOP_COOPERATIVE") return "Officina "+first;
  return rule.projectType;
}

function buildProjectProposal(rule,{proposer,scope,qualifyingPeople,score}) {
  return {
    schemaVersion:1,
    origin:"EMERGENT_NEED",
    projectType:rule.projectType,
    issueCode:rule.issueCode,
    name:buildProjectName(rule,proposer?.displayName,scope?.name),
    activities:[...rule.activities],
    resources:{...rule.resources},
    rationale:{primaryNeed:rule.primaryNeed,qualifyingPeople,emergenceScore:Number(score.toFixed(4))},
    formationModel:"COLLECTIVE_SUPPORT",
    generatedWithoutPlayerInput:true
  };
}

async function loadActors(simulationId) {
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) entityId,e.display_name displayName,BIN_TO_UUID(elc.location_id) locationId
       FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
       LEFT JOIN entity_locations_current elc ON elc.entity_id=e.id AND elc.simulation_id=e.simulation_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,
    [simulationId,PERSON]
  );
  if (!rows.length) return [];
  const ids=rows.map(x=>String(x.entityId));
  const placeholders=ids.map(()=> "UUID_TO_BIN(?)").join(",");
  const [needs]=await pool.query(
    `SELECT BIN_TO_UUID(enc.entity_id) entityId,nd.code,enc.value
       FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id
      WHERE enc.entity_id IN (${placeholders}) AND nd.active=1`.replace("${placeholders}",placeholders),
    ids
  );
  const byId=new Map(rows.map(x=>[String(x.entityId),{...x,needs:{}}]));
  for (const row of needs) { const actor=byId.get(String(row.entityId)); if (actor) actor.needs[normalize(row.code)]=Number(row.value); }
  return [...byId.values()];
}

async function loadLocations(simulationId) {
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) locationId,e.display_name name,e.description,e.attributes,
                    l.location_type locationType,l.latitude,l.longitude,l.address_data addressData
       FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE'
      ORDER BY e.created_simulation_at`,
    [simulationId,LOCATION]
  );
  return rows.map(row=>{
    const attributes=parseJson(row.attributes,{});
    return {...row,attributes,addressData:parseJson(row.addressData,{}),resources:attributes.resources||{}};
  });
}

async function hasRecentProject(simulationId,projectType,scopeLocationId,simulationTime) {
  const [rows]=await pool.query(
    `SELECT id FROM emergent_projects
      WHERE simulation_id=UUID_TO_BIN(?) AND project_type=? AND scope_location_id=UUID_TO_BIN(?)
        AND (status IN ('PROPOSED','ORGANIZING','ACTIVE') OR created_simulation_at>=DATE_SUB(?,INTERVAL 168 HOUR))
      LIMIT 1`,
    [simulationId,projectType,scopeLocationId,simulationTime]
  );
  return rows.length>0;
}

function selectProposer(actors,rule,scope) {
  return [...actors].filter(a=>String(a.locationId)===String(scope.locationId)).map(a=>({
    ...a,
    score:needValue(a,rule.primaryNeed)*.50+
      needValue(a,"ACHIEVEMENT")*.25+
      needValue(a,"CURIOSITY")*.15+
      average(["SOCIAL_NEED","BELONGING"].map(c=>needValue(a,c)))*.10
  })).sort((a,b)=>b.score-a.score)[0]||null;
}

async function proposeProject(simulationId,simulationTime,actors,scope,candidate) {
  const {rule}=candidate;
  if (await hasRecentProject(simulationId,rule.projectType,scope.locationId,simulationTime)) return null;
  const proposer=selectProposer(actors,rule,scope);
  if (!proposer) return null;
  const projectId=uuid();
  const proposal=buildProjectProposal(rule,{proposer,scope,qualifyingPeople:candidate.qualifying,score:candidate.score});

  await pool.query(
    `INSERT INTO emergent_projects
      (id,simulation_id,proposer_entity_id,scope_location_id,project_type,issue_code,title,description,status,support_score,required_support,proposal,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'PROPOSED',0,?,?,?,1)`,
    [projectId,simulationId,proposer.entityId,scope.locationId,rule.projectType,rule.issueCode,proposal.name,rule.description,rule.requiredSupport,JSON.stringify(proposal),simulationTime,simulationTime]
  );

  await pool.query(
    `INSERT IGNORE INTO emergent_project_members
      (project_id,simulation_id,entity_id,role,motivation,joined_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'FOUNDER',?,?)`,
    [projectId,simulationId,proposer.entityId,JSON.stringify({source:"PERSONAL_NEED",need:rule.primaryNeed,pressure:needValue(proposer,rule.primaryNeed)}),simulationTime]
  );

  await createEvent({
    simulationId,eventTypeCode:"SOCIAL",
    title:proposer.displayName+" proposed "+proposal.name,
    description:rule.description,simulationAt:simulationTime,importance:.58,
    metadata:{emergent:true,kind:"PROJECT_PROPOSED",projectId,projectType:rule.projectType,issueCode:rule.issueCode,scopeLocationId:scope.locationId},
    participants:[{entityId:proposer.entityId,role:"PROPOSER"}]
  });
  return projectId;
}

async function recruit(simulationId,projectId,simulationTime,actors,rule,scope) {
  const candidates=actors.filter(a=>String(a.locationId)===String(scope.locationId)).map(a=>({
    ...a,
    score:needValue(a,rule.primaryNeed)*.55+average(["SOCIAL_NEED","BELONGING"].map(c=>needValue(a,c)))*.25+needValue(a,"ACHIEVEMENT")*.20
  })).sort((a,b)=>b.score-a.score);

  const [existing]=await pool.query(
    `SELECT BIN_TO_UUID(entity_id) entityId FROM emergent_project_members WHERE project_id=UUID_TO_BIN(?)`,
    [projectId]
  );
  const members=new Set(existing.map(x=>String(x.entityId)));
  for (const actor of candidates) {
    if (members.has(String(actor.entityId)) || actor.score<.42) continue;
    await pool.query(
      `INSERT IGNORE INTO emergent_project_members
        (project_id,simulation_id,entity_id,role,motivation,joined_simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'SUPPORTER',?,?)`,
      [projectId,simulationId,actor.entityId,JSON.stringify({source:"SHARED_LOCAL_NEED",score:Number(actor.score.toFixed(4))}),simulationTime]
    );
  }
  const [countRows]=await pool.query(`SELECT COUNT(*) count FROM emergent_project_members WHERE project_id=UUID_TO_BIN(?)`,[projectId]);
  const count=Number(countRows[0]?.count||0);
  const [projectRows]=await pool.query(`SELECT required_support requiredSupport,status,proposal FROM emergent_projects WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1`,[projectId,simulationId]);
  if (!projectRows.length) return null;
  const required=Math.max(2,Number(projectRows[0].requiredSupport||2));
  const status=count>=required?"ACTIVE":"ORGANIZING";
  await pool.query(
    `UPDATE emergent_projects SET status=?,support_score=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)`,
    [status,clamp(count/required),simulationTime,projectId,simulationId]
  );
  return {count,required,status,proposal:parseJson(projectRows[0].proposal,{})};
}

async function materialize(simulationId,simulationTime,project,rule,anchor,actors) {
  const entityId=uuid();
  const worldCode="EMERGENT_"+rule.structureType+"_"+entityId.slice(0,8).toUpperCase();
  const connections=[anchor.locationId];
  const attributes={
    worldCode,emergent:true,structureType:rule.structureType,activities:rule.activities,
    resources:{...rule.resources},objects:[],connections,
    createdByProjectId:project.id,activityDefinitions:rule.activities.map(code=>({code,autonomous:true}))
  };

  await pool.query(
    `INSERT INTO entities
      (id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'ACTIVE', ?, ?,1)`,
    [entityId,simulationId,LOCATION,project.proposal.name,"Created by inhabitants in response to a persistent collective need.",JSON.stringify(attributes),simulationTime]
  );
  await pool.query(
    `INSERT INTO locations(entity_id,simulation_id,location_type,latitude,longitude,address_data)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)`,
    [entityId,simulationId,rule.locationType,Number(anchor.latitude)+.0012,Number(anchor.longitude)+.0010,
      JSON.stringify({worldCode,emergent:true,structureType:rule.structureType,activities:rule.activities,connections})]
  );
  const [anchorRows]=await pool.query(
    `SELECT attributes,address_data addressData,version FROM entities e JOIN locations l ON l.entity_id=e.id
       WHERE e.id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) LIMIT 1`,
    [anchor.locationId,simulationId,LOCATION]
  );
  if(anchorRows.length){
    const attrs=parseJson(anchorRows[0].attributes,{});
    const current=Array.isArray(attrs.connections)?[...attrs.connections]:[];
    if(!current.includes(worldCode)) current.push(worldCode);
    await pool.query(
      `UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,
      [JSON.stringify({...attrs,connections:current}),anchor.locationId,simulationId,Number(anchorRows[0].version||1)]
    );
    await pool.query(
      `UPDATE locations SET address_data=JSON_SET(COALESCE(address_data,JSON_OBJECT()),'$.connections',?) WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)`,
      [JSON.stringify(current),anchor.locationId,simulationId]
    );
  }

  const structureId=uuid();
  await pool.query(
    `INSERT INTO emergent_structures
      (id,simulation_id,project_id,entity_id,structure_type,name,scope_location_id,activities,attributes,created_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,UUID_TO_BIN(?),?,?,?,1)`,
    [structureId,simulationId,project.id,entityId,rule.structureType,project.proposal.name,anchor.locationId,JSON.stringify(rule.activities),
      JSON.stringify({origin:"COLLECTIVE_NEED",projectType:rule.projectType,issueCode:rule.issueCode,resources:rule.resources}),simulationTime]
  );
  await pool.query(
    `UPDATE emergent_projects SET status='COMPLETED',support_score=1,updated_simulation_at=?,completed_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)`,
    [simulationTime,simulationTime,project.id,simulationId]
  );
  const eventId=await createEvent({
    simulationId,eventTypeCode:"SOCIAL",
    title:project.proposal.name+" was created",
    description:rule.description,simulationAt:simulationTime,importance:.72,
    metadata:{emergent:true,kind:"WORLD_STRUCTURE_CREATED",projectId:project.id,structureId,entityId,locationId:anchor.locationId,activities:rule.activities},
    participants:actors.filter(a=>String(a.locationId)===String(anchor.locationId)).slice(0,8).map(a=>({entityId:a.entityId,role:"FOUNDER_OR_SUPPORTER"}))
  });
  return {structureId,entityId,name:project.proposal.name,type:rule.structureType,activities:rule.activities,eventId};
}

async function ensureSystem(simulationId,simulationTime,systemType,name,scopeLocationId,attributes) {
  const [existing]=await pool.query(
    `SELECT BIN_TO_UUID(id) id FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type=? AND stage<>'ENDED' LIMIT 1`,
    [simulationId,systemType]
  );
  if (existing.length) return existing[0].id;
  const id=uuid();
  await pool.query(
    `INSERT INTO emergent_systems
      (id,simulation_id,system_type,name,scope_location_id,stage,attributes,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,UUID_TO_BIN(?),'EMERGING',?,?,?,1)`,
    [id,simulationId,systemType,name,scopeLocationId||null,JSON.stringify(attributes||{}),simulationTime,simulationTime]
  );
  await createEvent({
    simulationId,eventTypeCode:"SOCIAL",title:name+" began to emerge",
    description:"A persistent social system formed from repeated collective behavior.",
    simulationAt:simulationTime,importance:.76,metadata:{emergent:true,kind:"SYSTEM_EMERGED",systemId:id,systemType}
  });
  return id;
}

async function evolveMacroSystems(simulationId,simulationTime) {
  const [structures]=await pool.query(`SELECT structure_type type,COUNT(*) count FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?) GROUP BY structure_type`,[simulationId]);
  const productive=structures.filter(x=>["MARKET","WORKSHOP"].includes(String(x.type))).reduce((s,x)=>s+Number(x.count||0),0);
  const economyId=productive>=2?await ensureSystem(simulationId,simulationTime,"ECONOMY","Local Exchange Economy",null,{formation:"BOTTOM_UP",pricing:"NEGOTIATED",productiveStructures:productive}):null;

  const [people]=await pool.query(`SELECT COUNT(*) count FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND entity_type_id=UUID_TO_BIN(?) AND status='ACTIVE'`,[simulationId,PERSON]);
  const [conflicts]=await pool.query(`SELECT COUNT(*) count FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'`,[simulationId]);
  const [structureCount]=await pool.query(`SELECT COUNT(*) count FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?)`,[simulationId]);

  let governanceId=null;
  if(Number(people[0]?.count||0)>=7 && (Number(conflicts[0]?.count||0)>=1 || Number(structureCount[0]?.count||0)>=3)) {
    governanceId=await ensureSystem(simulationId,simulationTime,"GOVERNANCE","Local Civic Council",null,{
      formation:"COLLECTIVE_COORDINATION",population:Number(people[0]?.count||0),persistentStructures:Number(structureCount[0]?.count||0),activeConflicts:Number(conflicts[0]?.count||0),decisionModel:"EMERGENT"
    });
  }

  let settlementId=null;
  if(Number(people[0]?.count||0)>=8 && Number(structureCount[0]?.count||0)>=2) {
    settlementId=await ensureSystem(simulationId,simulationTime,"SETTLEMENT","Emergent Settlement",null,{
      formation:"EMERGENT",population:Number(people[0]?.count||0),persistentStructures:Number(structureCount[0]?.count||0),
      settlementLevel:Number(people[0]?.count||0)>=12&&Number(structureCount[0]?.count||0)>=5?"TOWN":"HAMLET"
    });
  }
  return {economyId,governanceId,settlementId};
}

async function createPolicyAlternatives(simulationId,simulationTime) {
  const [governance]=await pool.query(
    `SELECT BIN_TO_UUID(id) id FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND system_type='GOVERNANCE' AND stage<>'ENDED' LIMIT 1`,
    [simulationId]
  );
  if (!governance.length) return [];
  const [activeConflict]=await pool.query(
    `SELECT conflict_type type FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY created_simulation_at DESC LIMIT 1`,
    [simulationId]
  );
  if (!activeConflict.length) return [];
  const [existing]=await pool.query(
    `SELECT title FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND governance_system_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 4`,
    [simulationId,governance[0].id]
  );
  if (existing.length>=2) return existing.map(x=>x.title);

  const [people]=await pool.query(
    `SELECT BIN_TO_UUID(e.id) entityId,e.display_name displayName,
      MAX(CASE WHEN td.code='CONSCIENTIOUSNESS' THEN etc.value ELSE 0 END) conscientiousness,
      MAX(CASE WHEN td.code='INDEPENDENCE' THEN etc.value ELSE 0 END) independence,
      MAX(CASE WHEN td.code='EMPATHY' THEN etc.value ELSE 0 END) empathy
      FROM entities e JOIN entity_types et ON et.id=e.entity_type_id
      LEFT JOIN entity_traits_current etc ON etc.entity_id=e.id
      LEFT JOIN trait_definitions td ON td.id=etc.trait_id
      WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN(?) AND e.status='ACTIVE'
      GROUP BY e.id,e.display_name`,
    [simulationId,PERSON]
  );
  if (people.length<4) return [];
  const planner=[...people].sort((a,b)=>(Number(b.conscientiousness)+Number(b.empathy))-(Number(a.conscientiousness)+Number(a.empathy)))[0];
  const individualist=[...people].sort((a,b)=>Number(b.independence)-Number(a.independence))[0];
  const variants=[
    {p:planner,title:"Shared contribution for shared services",statement:"Contribute a common share to fund shared resources and infrastructure.",rate:.06,model:"COMMON_POOL"},
    {p:individualist,title:"Voluntary contribution with local ownership",statement:"Keep contributions voluntary and let contributors choose which local structures receive support.",rate:.03,model:"VOLUNTARY"}
  ];
  const created=[];
  for (const variant of variants) {
    if (existing.some(x=>String(x.title)===variant.title)) continue;
    const id=uuid();
    await pool.query(
      `INSERT INTO emergent_policies
        (id,simulation_id,proposer_entity_id,governance_system_id,scope_location_id,issue_code,title,statement,parameters,support_score,opposition_score,status,created_simulation_at,updated_simulation_at,version)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,?,?,?,0,0,'PROPOSED',?,?,1)`,
      [id,simulationId,variant.p.entityId,governance[0].id,"RESOURCE_ALLOCATION",variant.title,variant.statement,JSON.stringify({contributionRate:variant.rate,fundingModel:variant.model,origin:"EMERGENT_CONFLICT",generatedWithoutPlayerInput:true}),simulationTime,simulationTime]
    );
    await createEvent({simulationId,eventTypeCode:"SOCIAL",title:variant.title,description:variant.statement,simulationAt:simulationTime,importance:.62,metadata:{emergent:true,kind:"POLICY_PROPOSED",policyId:id,governanceSystemId:governance[0].id}});
    created.push(id);
  }
  return created;
}

async function createConflicts(simulationId,simulationTime) {
  const [structures]=await pool.query(
    `SELECT BIN_TO_UUID(id) id,structure_type type,BIN_TO_UUID(scope_location_id) scopeLocationId FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 30`,
    [simulationId]
  );
  const groups=new Map();
  for (const row of structures) { const key=String(row.scopeLocationId||""); if(key){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);} }
  let created=0;
  for (const items of groups.values()) {
    if(items.length<2) continue;
    for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) {
      const left=items[i],right=items[j];
      const [exists]=await pool.query(
        `SELECT id FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) AND conflict_type='RESOURCE_COMPETITION' AND left_id=UUID_TO_BIN(?) AND right_id=UUID_TO_BIN(?) LIMIT 1`,
        [simulationId,left.id,right.id]
      );
      if(exists.length) continue;
      await pool.query(
        `INSERT INTO emergent_conflicts
          (id,simulation_id,scope_location_id,conflict_type,left_type,left_id,right_type,right_id,intensity,status,metadata,created_simulation_at,version)
          VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'RESOURCE_COMPETITION','STRUCTURE',UUID_TO_BIN(?),'STRUCTURE',UUID_TO_BIN(?),?,'ACTIVE',?, ?,1)`,
        [uuid(),simulationId,left.scopeLocationId,left.id,right.id,left.type===right.type ? .48 : .56,JSON.stringify({leftType:left.type,rightType:right.type,reason:"emergent structures compete for local resources or space"}),simulationTime]
      );
      created++;
    }
  }

  const [policies]=await pool.query(
    `SELECT BIN_TO_UUID(id) id,issue_code issueCode,BIN_TO_UUID(governance_system_id) governanceId,parameters
      FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) AND status='PROPOSED'
      ORDER BY created_simulation_at DESC LIMIT 20`,
    [simulationId]
  );
  const byIssue=new Map();
  for(const p of policies){const key=String(p.governanceId)+":"+String(p.issueCode);if(!byIssue.has(key))byIssue.set(key,[]);byIssue.get(key).push(p);}
  for(const items of byIssue.values()) {
    if(items.length<2) continue;
    const a=items[0],b=items[1];
    const [exists]=await pool.query(
      `SELECT id FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) AND conflict_type='POLICY_COMPETITION' AND left_id=UUID_TO_BIN(?) AND right_id=UUID_TO_BIN(?) LIMIT 1`,
      [simulationId,a.id,b.id]
    );
    if(exists.length) continue;
    const pa=parseJson(a.parameters,{}),pb=parseJson(b.parameters,{});
    const divergence=Math.abs(Number(pa.contributionRate||0)-Number(pb.contributionRate||0));
    await pool.query(
      `INSERT INTO emergent_conflicts
        (id,simulation_id,scope_location_id,conflict_type,left_type,left_id,right_type,right_id,intensity,status,metadata,created_simulation_at,version)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,'POLICY_COMPETITION','POLICY',UUID_TO_BIN(?),'POLICY',UUID_TO_BIN(?),?,'ACTIVE',?, ?,1)`,
      [uuid(),simulationId,a.id,b.id,clamp(.45+divergence*2),JSON.stringify({reason:"competing policy alternatives",issueCode:a.issueCode,parameterDivergence:divergence}),simulationTime]
    );
    created++;
  }
  return created;
}

async function progressEmergence(simulationId,simulationTime) {
  const [actors,locations]=await Promise.all([loadActors(simulationId),loadLocations(simulationId)]);
  if(!actors.length || !locations.length) return {skipped:true};
  const byLocation=new Map(locations.map(l=>[String(l.locationId),l]));
  const local=new Map();
  for(const actor of actors){const key=String(actor.locationId||"");if(key){if(!local.has(key))local.set(key,[]);local.get(key).push(actor);}}
  const proposed=[],materialized=[];
  for(const [locationId,localActors] of local.entries()) {
    if(localActors.length<3) continue;
    const scope=byLocation.get(locationId);if(!scope) continue;
    const candidate=candidateProjectRule(localActors);if(!candidate) continue;
    const projectId=await proposeProject(simulationId,simulationTime,localActors,scope,candidate);
    if(projectId)proposed.push(projectId);
  }
  const [projects]=await pool.query(
    `SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,project_type projectType,status,required_support requiredSupport,proposal
      FROM emergent_projects WHERE simulation_id=UUID_TO_BIN(?) AND status IN ('PROPOSED','ORGANIZING','ACTIVE')
      ORDER BY created_simulation_at LIMIT 50`,
    [simulationId]
  );
  for(const project of projects){
    const rule=PROJECT_RULES.find(x=>x.projectType===String(project.projectType));if(!rule)continue;
    const scope=byLocation.get(String(project.scopeLocationId));if(!scope)continue;
    const localActors=actors.filter(a=>String(a.locationId)===String(scope.locationId));
    const progress=await recruit(simulationId,project.id,simulationTime,localActors,rule,scope);
    if(progress?.status==="ACTIVE"){
      const result=await materialize(simulationId,simulationTime,{...project,proposal:parseJson(project.proposal,{})},rule,scope,actors);
      if(result)materialized.push(result);
    }
  }
  const systems=await evolveMacroSystems(simulationId,simulationTime);
  const resourceConflicts=await createConflicts(simulationId,simulationTime);
  const policies=systems.governanceId?await createPolicyAlternatives(simulationId,simulationTime):[];
  const policyConflicts=await createConflicts(simulationId,simulationTime);
  logger.info({simulationId,simulationTime,proposedProjects:proposed.length,materializedStructures:materialized.length,resourceConflicts,policyCount:policies.length,policyConflicts},"emergent world maintenance completed");
  return {proposedProjects:proposed,materializedStructures:materialized,systems,policies,conflicts:resourceConflicts+policyConflicts};
}

async function getEmergentSnapshot(simulationId) {
  const [[projects],[structures],[systems],[policies],[conflicts]]=await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(scope_location_id) scopeLocationId,project_type projectType,issue_code issueCode,title,description,status,support_score supportScore,required_support requiredSupport,proposal,created_simulation_at createdAt,completed_simulation_at completedAt FROM emergent_projects WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(project_id) projectId,BIN_TO_UUID(entity_id) entityId,structure_type structureType,name,BIN_TO_UUID(scope_location_id) scopeLocationId,activities,attributes,created_simulation_at createdAt FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,system_type systemType,name,BIN_TO_UUID(scope_location_id) scopeLocationId,stage,attributes,created_simulation_at createdAt,updated_simulation_at updatedAt FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 20`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(governance_system_id) governanceSystemId,BIN_TO_UUID(scope_location_id) scopeLocationId,issue_code issueCode,title,statement,parameters,support_score supportScore,opposition_score oppositionScore,status,created_simulation_at createdAt FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId]),
    pool.query(`SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,conflict_type conflictType,left_type leftType,BIN_TO_UUID(left_id) leftId,right_type rightType,BIN_TO_UUID(right_id) rightId,intensity,status,metadata,created_simulation_at createdAt,resolved_simulation_at resolvedAt FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 50`,[simulationId])
  ]);
  const decode=rows=>rows.map(row=>{for(const k of ["proposal","activities","attributes","parameters","metadata"])if(row[k]!==undefined)row[k]=parseJson(row[k],row[k]);return row;});
  return {projects:decode(projects),structures:decode(structures),systems:decode(systems),policies:decode(policies),conflicts:decode(conflicts)};
}

module.exports={PROJECT_RULES,candidateProjectRule,buildProjectName,buildProjectProposal,progressEmergence,getEmergentSnapshot};
