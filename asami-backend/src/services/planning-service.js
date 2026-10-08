const { pool, withTransaction } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { isCriticalResourceReachable } = require("./physical-world-service");
const observability = require("./simulation-observability");
const logger = require("../lib/logger");
const { assertTransition } = require("./state-machine");
const { compactActionResult } = require("./storage-compaction");
const GOAL_PRESSURE_CODES=new Set(["HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN","CURIOSITY","ACHIEVEMENT","BELONGING"]);
const GOAL_TEMPLATES={HUNGER:{title:"Find food",description:"Get food and satisfy the current hunger pressure.",goalType:"NEED",steps:[{title:"Go somewhere with food",description:"Travel to a reachable place where food is available.",actionType:"WALKING"},{title:"Eat",description:"Consume available food and verify the result.",actionType:"EATING"}]},THIRST:{title:"Find water",description:"Find accessible water and satisfy the current thirst pressure.",goalType:"NEED",steps:[{title:"Go somewhere with water",description:"Travel to a reachable place where water is available.",actionType:"WALKING"},{title:"Drink",description:"Consume available water and verify the result.",actionType:"DRINKING"}]},SOCIAL_NEED:{title:"Connect with someone",description:"Have a meaningful social interaction to reduce social pressure.",goalType:"NEED",steps:[{title:"Talk with someone",description:"Find an appropriate person and have a social interaction.",actionType:"TALKING"}]},BELONGING:{title:"Strengthen belonging",description:"Build or reinforce a meaningful social connection.",goalType:"NEED",steps:[{title:"Talk with someone",description:"Have an interaction that can contribute to belonging.",actionType:"TALKING"}]},FUN:{title:"Do something enjoyable",description:"Choose an enjoyable activity and follow through with it.",goalType:"NEED",steps:[{title:"Go somewhere interesting",description:"Travel to a suitable place for leisure.",actionType:"WALKING"},{title:"Have fun",description:"Perform an activity that meaningfully satisfies fun.",actionType:"PLAYING"}]},CURIOSITY:{title:"Learn something new",description:"Seek a novel experience and turn it into learning.",goalType:"NEED",steps:[{title:"Explore somewhere new",description:"Visit a location that is interesting and not recently visited.",actionType:"EXPLORING"},{title:"Learn from the experience",description:"Read or study something connected to the experience.",actionType:"READING"}]},ACHIEVEMENT:{title:"Accomplish something",description:"Complete a meaningful productive activity.",goalType:"NEED",steps:[{title:"Work toward the objective",description:"Perform a productive activity that advances the objective.",actionType:"STUDYING"},{title:"Complete the objective",description:"Continue with a productive activity until the goal is complete.",actionType:"WORKING"}]},SLEEPINESS:{title:"Get enough sleep",description:"Restore sleep and energy when sleep pressure is high.",goalType:"NEED",steps:[{title:"Sleep",description:"Get enough uninterrupted sleep and verify recovery.",actionType:"SLEEPING"}]}};
const MAX_STEP_ATTEMPTS=1,MAX_GOAL_AGE_HOURS=24,MAX_PLAN_REPLANS=3;
const GOAL_STAGNATION_REPLAN_HOURS=Math.max(24,Math.min(168,Number(process.env.GOAL_STAGNATION_REPLAN_HOURS)||48));
const MAX_GOAL_STAGNATION_REPLANS=Math.max(1,Math.min(5,Number(process.env.GOAL_STAGNATION_MAX_REPLANS)||2));
const PERSONAL_GOAL_INTERVAL_HOURS=24;
const LONG_TERM_GOAL_INTERVAL_HOURS=72;
const PERSISTENT_GOAL_TYPES=new Set(["PERSONAL","LONG_TERM"]);

const PERSONAL_GOAL_TEMPLATES=[
  {key:"SOCIAL_CONNECTION",title:"Build a meaningful connection",description:"Spend time developing a genuine relationship with someone you value.",goalType:"PERSONAL",actionType:"TALKING",motivation:{source:"AUTONOMOUS_PERSONAL",domain:"RELATIONSHIPS"}},
  {key:"CREATIVE_EXPLORATION",title:"Explore your creativity",description:"Seek experiences and ideas that can inspire something new and personally meaningful.",goalType:"PERSONAL",actionType:"EXPLORING",motivation:{source:"AUTONOMOUS_PERSONAL",domain:"CREATIVITY"}},
  {key:"EXPLORATION",title:"Discover something new",description:"Seek a new experience and turn it into something personally meaningful.",goalType:"PERSONAL",actionType:"EXPLORING",motivation:{source:"AUTONOMOUS_PERSONAL",domain:"EXPLORATION"}}
];

const LONG_TERM_GOAL_TEMPLATES=[
  {key:"GROWTH",title:"Develop a skill",description:"Gradually improve a skill through repeated learning and practice.",goalType:"LONG_TERM",steps:["STUDYING","WORKING"],motivation:{source:"AUTONOMOUS_LONG_TERM",domain:"GROWTH"}},
  {key:"KNOWLEDGE",title:"Build knowledge through exploration",description:"Explore the world, learn from experiences and turn them into lasting knowledge.",goalType:"LONG_TERM",steps:["EXPLORING","READING"],motivation:{source:"AUTONOMOUS_LONG_TERM",domain:"KNOWLEDGE"}},
  {key:"RELATIONSHIPS",title:"Build lasting relationships",description:"Develop a meaningful social connection through repeated positive interactions.",goalType:"LONG_TERM",steps:["TALKING","TALKING"],motivation:{source:"AUTONOMOUS_LONG_TERM",domain:"RELATIONSHIPS"}}
];
function normalizeAction(value){return String(value||"").trim().toUpperCase();}
function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function mysqlSimulationDateTime(value){const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.getTime()))throw Object.assign(new Error("Invalid simulation time"),{code:"INVALID_SIMULATION_TIME"});const pad=n=>String(n).padStart(2,"0"),ms=String(date.getUTCMilliseconds()).padStart(3,"0");return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;}
function simulationTimestampMs(value){
  if(value instanceof Date)return value.getTime();
  const direct=new Date(value);
  if(Number.isFinite(direct.getTime()))return direct.getTime();
  const normalized=String(value||"").trim();
  if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(normalized)){
    const sqlDate=new Date(normalized.replace(" ","T")+"Z");
    if(Number.isFinite(sqlDate.getTime()))return sqlDate.getTime();
  }
  return NaN;
}
function selectTopNeed(needs){return(needs||[]).filter(need=>GOAL_PRESSURE_CODES.has(normalizeAction(need.code))).map(need=>({...need,value:Number(need.value),priorityWeight:Number(need.priorityWeight||1)})).filter(need=>Number.isFinite(need.value)&&need.value>.30).sort((a,b)=>(b.value*b.priorityWeight)-(a.value*a.priorityWeight))[0]||null;}
async function getActiveGoal(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,title,goal_type AS goalType,priority,progress,status,motivation,result,created_simulation_at AS createdAt FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED') ORDER BY CASE goal_type WHEN 'NEED' THEN 0 ELSE 1 END, CASE status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 WHEN 'PAUSED' THEN 2 WHEN 'BLOCKED' THEN 3 ELSE 4 END,priority DESC,created_simulation_at ASC LIMIT 1`,[simulationId,entityId]);return rows[0]||null;}
async function getPlanForGoal(simulationId,entityId,goalId,db=pool){if(!goalId)return null;const[plans]=await db.query(`SELECT BIN_TO_UUID(id) AS id,version,title,status,strategy FROM plans WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED') ORDER BY created_simulation_at DESC LIMIT 1`,[simulationId,entityId,goalId]);if(!plans.length)return null;const plan=plans[0];const[steps]=await db.query(`SELECT BIN_TO_UUID(id) AS id,sequence,title,description,status,activity_type_id AS activityTypeId,intended_start_simulation_at AS intendedStart,deadline_simulation_at AS deadline,result,version FROM plan_steps WHERE plan_id=UUID_TO_BIN(?) ORDER BY sequence ASC`,[plan.id]);return{...plan,strategy:parseJson(plan.strategy,{}),steps:steps.map(step=>({...step,result:parseJson(step.result,null)}))};}
async function createPlanForGoal({simulationId,entityId,goalId,simulationTime,needCode,pressure,priority,replanCount=0,avoidLocationIds=[],avoidTargetEntityIds=[],db=pool}){const template=GOAL_TEMPLATES[needCode];if(!template?.steps?.length||!goalId)return null;const existing=await getPlanForGoal(simulationId,entityId,goalId,db);if(existing)return existing;const planId=uuid(),mysqlTime=mysqlSimulationDateTime(simulationTime);await db.query(`INSERT INTO plans (id,simulation_id,entity_id,goal_id,title,status,strategy,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,[planId,simulationId,entityId,goalId,template.title,JSON.stringify({source:"AUTONOMOUS_NEED",need:needCode,initialPressure:Number(pressure),priority:Number(priority),replanCount:Number(replanCount),avoidLocationIds:Array.isArray(avoidLocationIds)?avoidLocationIds.slice(0,8):[],avoidTargetEntityIds:Array.isArray(avoidTargetEntityIds)?avoidTargetEntityIds.slice(0,8):[]}),mysqlTime]);for(let i=0;i<template.steps.length;i+=1){const step=template.steps[i],actionType=normalizeAction(step.actionType);let activityTypeId=null;if(actionType){const[activityRows]=await db.query(`SELECT id FROM activity_types WHERE code=? AND active=1 LIMIT 1`,[actionType]);activityTypeId=activityRows[0]?.id||null;}await db.query(`INSERT INTO plan_steps (id,plan_id,sequence,title,description,status,activity_type_id,intended_start_simulation_at,deadline_simulation_at,result,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,'PENDING',?,NULL,NULL,?,1)`,[uuid(),planId,i+1,step.title,step.description,activityTypeId,JSON.stringify({actionType,attempts:0,avoidLocationIds:Array.isArray(avoidLocationIds)?avoidLocationIds.slice(0,8):[],avoidTargetEntityIds:Array.isArray(avoidTargetEntityIds)?avoidTargetEntityIds.slice(0,8):[]})]);}await db.query(`UPDATE plan_steps SET status='ACTIVE',version=version+1 WHERE plan_id=UUID_TO_BIN(?) AND sequence=1 AND status='PENDING'`,[planId]);return getPlanForGoal(simulationId,entityId,goalId,db);}
function resourceForGoalNeed(needCode){
  return {HUNGER:"food",THIRST:"water"}[normalizeAction(needCode)]||null;
}

async function isFoodMarketAvailable(simulationId,entityId){
  if(!simulationId||!entityId)return false;
  const [rows]=await pool.query(
    `SELECT ms.price,ms.supply,ea.balance
       FROM emergent_market_state ms
       JOIN emergent_economy_accounts ea
         ON ea.simulation_id=ms.simulation_id
        AND ea.entity_id=UUID_TO_BIN(?)
      WHERE ms.simulation_id=UUID_TO_BIN(?)
        AND ms.good_code='FOOD'
        AND ms.supply>0
        AND ms.price>0
        AND ea.balance>=ms.price
      ORDER BY ms.price ASC
      LIMIT 1`,
    [entityId,simulationId]
  );
  return rows.length>0;
}

function resourceForAction(actionType){
  return{
    EATING:"food",
    DRINKING:"water"
  }[normalizeAction(actionType)]||null;
}

function stepRequiresResource(step,resource){
  const normalizedResource=String(resource||"").trim().toLowerCase();
  if(!normalizedResource)return false;
  const stepResult=parseJson(step?.result,{})||{};
  const expectedAction=normalizeAction(stepResult.actionType||step?.actionType);
  const declaredResource=String(
    stepResult.resource||
    stepResult.requiredResource||
    step?.resource||
    step?.requiredResource||
    ""
  ).trim().toLowerCase();
  return declaredResource===normalizedResource ||
    resourceForAction(expectedAction)===normalizedResource;
}

function isResourceBlockedFailure(actionType,outcome,actionResult){
  const normalizedAction=normalizeAction(actionType);
  if(!["EATING","DRINKING"].includes(normalizedAction))return null;
  const normalizedOutcome=String(outcome||"").trim().toUpperCase();
  if(!["FAILURE","PARTIAL"].includes(normalizedOutcome))return null;
  const failureReason=String(actionResult?.failureReason||actionResult?.resource?.failureReason||"").toUpperCase();
  const resource=String(actionResult?.resource?.resource||"").trim().toLowerCase()||(
    normalizedAction==="DRINKING"?"water":normalizedAction==="EATING"?"food":null
  );
  if(!["RESOURCE_UNAVAILABLE","RESOURCE_PARTIALLY_AVAILABLE","CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE"].includes(failureReason)&&
     Number(actionResult?.resource?.remaining)>=1)return null;
  if(!["water","food"].includes(resource))return null;
  return{resource,reason:failureReason||"RESOURCE_UNAVAILABLE"};
}

async function blockGoalForResource({simulationId,entityId,goalId,simulationTime,resource,reason,actionType,actionResult=null}){
  if(!goalId||!resource)return false;
  return withTransaction(async conn=>{
    const[goalRows]=await conn.query(
      `SELECT status,result,version FROM goals
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
       LIMIT 1 FOR UPDATE`,
      [goalId,simulationId,entityId]
    );
    if(!goalRows.length)return false;
    const goal=goalRows[0];
    const goalStatus=String(goal.status||"").toUpperCase();
    if(!["ACTIVE","DRAFT","PAUSED","BLOCKED"].includes(goalStatus))return false;
    assertTransition("goal",goalStatus,"BLOCKED");

    const[planRows]=await conn.query(
      `SELECT BIN_TO_UUID(id) AS id,status,version,strategy
       FROM plans
       WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?)
         AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')
       ORDER BY created_simulation_at DESC FOR UPDATE`,
      [simulationId,entityId,goalId]
    );

    const goalResult=parseJson(goal.result,{})||{};
    const blockedResult={
      ...goalResult,
      status:"BLOCKED",
      reason:"RESOURCE_UNAVAILABLE",
      blockedReason:reason||"RESOURCE_UNAVAILABLE",
      resource,
      actionType:normalizeAction(actionType),
      blockedAt:simulationTime,
      retryWhenResourceAvailable:true,
      lastFailure:actionResult||null
    };

    await conn.query(
      `UPDATE goals
       SET status='BLOCKED',result=?,completed_simulation_at=NULL,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED','BLOCKED')`,
      [JSON.stringify(blockedResult),goalId,goal.version]
    );

    for(const plan of planRows){
      const[stepRows]=await conn.query(
        `SELECT status FROM plan_steps
         WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE')
         FOR UPDATE`,
        [plan.id]
      );
      for(const step of stepRows)assertTransition("plan_step",String(step.status||"").toUpperCase(),"BLOCKED");
      await conn.query(
        `UPDATE plan_steps
         SET status='BLOCKED',
             result=JSON_SET(
               COALESCE(result,JSON_OBJECT()),
               '$.blockedReason','RESOURCE_UNAVAILABLE',
               '$.resource',?,
               '$.blockedAt',?,
               '$.retryWhenResourceAvailable',true
             ),
             version=version+1
         WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE')`,
        [resource,simulationTime,plan.id]
      );
      const strategy=parseJson(plan.strategy,{})||{};
      assertTransition("plan",String(plan.status||"").toUpperCase(),"BLOCKED");
      await conn.query(
        `UPDATE plans
         SET status='BLOCKED',
             strategy=?,
             version=version+1
         WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')`,
        [JSON.stringify({...strategy,blockedReason:"RESOURCE_UNAVAILABLE",resource,blockedAt:simulationTime}),plan.id]
      );
    }

    observability.recordGoalBlocked(simulationId,{resource,reason});
    logger.warnThrottled(
      `planning:resource-blocked:${simulationId}:${resource}`,
      600000,
      {
        simulationId,
        entityId,
        goalId,
        simulationTime,
        resource,
        reason:reason||"RESOURCE_UNAVAILABLE",
        actionType:normalizeAction(actionType)
      },
      "goal blocked by unavailable critical resource"
    );
    return true;
  });
}
async function unblockBlockedGoal({simulationId,entityId,goalId,simulationTime}){
  if(!goalId)return false;
  return withTransaction(async conn=>{
    const[goalRows]=await conn.query(
      `SELECT status,version FROM goals
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [goalId,simulationId,entityId]
    );
    if(!goalRows.length||String(goalRows[0].status||"").toUpperCase()!=="BLOCKED")return false;

    const[plans]=await conn.query(
      `SELECT BIN_TO_UUID(id) AS id,status,version FROM plans
       WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?)
         AND status='BLOCKED' ORDER BY created_simulation_at DESC FOR UPDATE`,
      [simulationId,entityId,goalId]
    );

    for(const plan of plans){
      const[steps]=await conn.query(
        `SELECT BIN_TO_UUID(id) AS id,sequence,status,version
         FROM plan_steps WHERE plan_id=UUID_TO_BIN(?) AND status='BLOCKED'
         ORDER BY sequence ASC FOR UPDATE`,
        [plan.id]
      );
      const nextStep=steps[0];
      if(nextStep){
        for(const step of steps)assertTransition("plan_step",String(step.status||"").toUpperCase(),"PENDING");
        assertTransition("plan_step","PENDING","ACTIVE");
        await conn.query(
          `UPDATE plan_steps SET status='PENDING',version=version+1
           WHERE plan_id=UUID_TO_BIN(?) AND status='BLOCKED'`,
          [plan.id]
        );
        await conn.query(
          `UPDATE plan_steps SET status='ACTIVE',version=version+1
           WHERE id=UUID_TO_BIN(?) AND status='PENDING'`,
          [nextStep.id]
        );
      }
      assertTransition("plan","BLOCKED","ACTIVE");
      await conn.query(
        `UPDATE plans
         SET status='ACTIVE',
             strategy=JSON_SET(COALESCE(strategy,JSON_OBJECT()),'$.unblockedAt',CAST(? AS CHAR)),
             version=version+1
         WHERE id=UUID_TO_BIN(?) AND status='BLOCKED'`,
        [simulationTime,plan.id]
      );
    }

    assertTransition("goal","BLOCKED","ACTIVE");
    await conn.query(
      `UPDATE goals
       SET status='ACTIVE',result=JSON_SET(COALESCE(result,JSON_OBJECT()),
           '$.status','ACTIVE',
           '$.unblockedAt',CAST(? AS CHAR),
           '$.retryWhenResourceAvailable',false),
           version=version+1
       WHERE id=UUID_TO_BIN(?) AND status='BLOCKED'`,
      [simulationTime,goalId]
    );
    return true;
  });
}
async function revalidateBlockedResourceGoals({simulationId,simulationTime,limit=100}={}){
  if(!simulationId)return{checked:0,eligible:0,reachable:0,unblocked:0};

  const safeLimit=Math.max(1,Math.min(500,Number(limit)||100));
  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(id) AS goalId,
            BIN_TO_UUID(entity_id) AS entityId,
            result
     FROM goals
     WHERE simulation_id=UUID_TO_BIN(?)
       AND status='BLOCKED'
     ORDER BY created_simulation_at ASC
     LIMIT ?`,
    [simulationId,safeLimit]
  );

  let eligible=0,reachable=0,unblocked=0;
  for(const row of rows){
    const result=parseJson(row.result,{})||{};
    const reason=String(result.reason||result.blockedReason||"").toUpperCase();
    const resource=String(result.resource||"").trim().toLowerCase();
    const retry=Boolean(result.retryWhenResourceAvailable);

    if(reason!=="RESOURCE_UNAVAILABLE" || !retry || !["food","water"].includes(resource)){
      continue;
    }

    eligible+=1;
    try{
      const available=await isCriticalResourceReachable(
        simulationId,
        row.entityId,
        resource
      );
      if(!available)continue;

      reachable+=1;
      if(await unblockBlockedGoal({
        simulationId,
        entityId:row.entityId,
        goalId:row.goalId,
        simulationTime
      })){
        unblocked+=1;
      }
    }catch(err){
      logger.warnThrottled(
        `planning:blocked-resource-revalidate:${simulationId}:${resource}`,
        600000,
        {
          simulationId,
          entityId:row.entityId,
          goalId:row.goalId,
          resource,
          simulationTime,
          error:String(err?.message||err)
        },
        "blocked resource goal revalidation failed"
      );
    }
  }

  return{
    checked:rows.length,
    eligible,
    reachable,
    unblocked
  };
}

async function abandonGoal({simulationId,entityId,goalId,simulationTime,reason}){
  if(!goalId)return false;
  const mysqlTime=mysqlSimulationDateTime(simulationTime);
  return withTransaction(async conn=>{
    const[goalRows]=await conn.query(
      `SELECT status FROM goals
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [goalId,simulationId,entityId]
    );
    if(!goalRows.length)return false;
    const goalStatus=String(goalRows[0].status||"").toUpperCase();
    assertTransition("goal",goalStatus,"ABANDONED");
    const[updated]=await conn.query(
      `UPDATE goals SET status='ABANDONED',result=?,completed_simulation_at=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
         AND status IN ('ACTIVE','DRAFT','PAUSED','BLOCKED')`,
      [JSON.stringify({reason,at:simulationTime}),mysqlTime,goalId,simulationId,entityId]
    );
    if(!updated.affectedRows)return false;
    const[plans]=await conn.query(
      `SELECT BIN_TO_UUID(id) AS id,status FROM plans
       WHERE simulation_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?)
         AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')
       FOR UPDATE`,
      [simulationId,goalId]
    );
    for(const plan of plans){
      assertTransition("plan",String(plan.status||"").toUpperCase(),"CANCELLED");
      const[steps]=await conn.query(
        `SELECT status FROM plan_steps
         WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')
         FOR UPDATE`,
        [plan.id]
      );
      for(const step of steps)assertTransition("plan_step",String(step.status||"").toUpperCase(),"CANCELLED");
      await conn.query(
        `UPDATE plan_steps SET status='CANCELLED',version=version+1
         WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')`,
        [plan.id]
      );
      await conn.query(
        `UPDATE plans SET status='CANCELLED',version=version+1
         WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')`,
        [plan.id]
      );
    }
    return true;
  });
}
async function hasRecentPersistentGoal(simulationId,entityId,goalType,simulationTime,intervalHours){
  const cutoff=new Date(new Date(simulationTime).getTime()-intervalHours*3600000);
  const [rows]=await pool.query(
    `SELECT id
     FROM goals
     WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
       AND goal_type=? AND created_simulation_at>=?
       AND status NOT IN ('CANCELLED','ABANDONED','FAILED')
     ORDER BY created_simulation_at DESC
     LIMIT 1`,
    [simulationId,entityId,goalType,mysqlSimulationDateTime(cutoff)]
  );
  return rows.length>0;
}

async function hasActivePersistentGoal(simulationId,entityId,goalType){
  const [rows]=await pool.query(
    `SELECT id
     FROM goals
     WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
       AND goal_type=? AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')
     LIMIT 1`,
    [simulationId,entityId,goalType]
  );
  return rows.length>0;
}

async function choosePersonalGoalTemplate(simulationId,entityId){
  const [rows]=await pool.query(
    `SELECT code,value
     FROM entity_traits_current etc
     JOIN trait_definitions td ON td.id=etc.trait_id
     WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
     ORDER BY value DESC
     LIMIT 8`,
    [entityId]
  );
  const traits=new Map(rows.map(row=>[String(row.code||"").toUpperCase(),Number(row.value||0)]));
  if((traits.get("SOCIABILITY")||0)>.62 || (traits.get("EXTRAVERSION")||0)>.62) return PERSONAL_GOAL_TEMPLATES.find(t=>t.key==="SOCIAL_CONNECTION");
  if((traits.get("CREATIVITY")||0)>.62 || (traits.get("OPENNESS")||0)>.62) return PERSONAL_GOAL_TEMPLATES.find(t=>t.key==="CREATIVE_EXPLORATION");
  return PERSONAL_GOAL_TEMPLATES.find(t=>t.key==="EXPLORATION");
}

async function chooseLongTermGoalTemplate(entityId){
  const [rows]=await pool.query(
    `SELECT code,value
     FROM entity_traits_current etc
     JOIN trait_definitions td ON td.id=etc.trait_id
     WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
     ORDER BY value DESC
     LIMIT 8`,
    [entityId]
  );
  const traits=new Map(rows.map(row=>[String(row.code||"").toUpperCase(),Number(row.value||0)]));
  if((traits.get("CONSCIENTIOUSNESS")||0)>.62 || (traits.get("DISCIPLINE")||0)>.62) return LONG_TERM_GOAL_TEMPLATES.find(t=>t.key==="GROWTH");
  if((traits.get("SOCIABILITY")||0)>.62 || (traits.get("EXTRAVERSION")||0)>.62) return LONG_TERM_GOAL_TEMPLATES.find(t=>t.key==="RELATIONSHIPS");
  return LONG_TERM_GOAL_TEMPLATES.find(t=>t.key==="KNOWLEDGE");
}

async function createPersistentGoal({simulationId,entityId,simulationTime,template,priority=.45}){
  if(!template)return null;
  const goalId=uuid(),mysqlTime=mysqlSimulationDateTime(simulationTime);
  const steps=Array.isArray(template.steps)?template.steps:[template.actionType];
  await pool.query(
    `INSERT INTO goals (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,created_simulation_at,motivation,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',0,?,CAST(? AS JSON),1)`,
    [
      goalId,simulationId,entityId,template.title,template.description,template.goalType,
      priority,mysqlTime,
      JSON.stringify({
        ...template.motivation,
        goalKey:template.key,
        createdFromPersonality:true
      })
    ]
  );

  if(steps.length){
    const planId=uuid();
    await pool.query(
      `INSERT INTO plans (id,simulation_id,entity_id,goal_id,title,status,strategy,created_simulation_at,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,
      [
        planId,simulationId,entityId,goalId,template.title,
        JSON.stringify({source:template.goalType,goalKey:template.key,progressDriven:true}),
        mysqlTime
      ]
    );
    for(let i=0;i<steps.length;i+=1){
      const actionType=normalizeAction(steps[i]);
      let activityTypeId=null;
      if(actionType){
        const [activityRows]=await pool.query(
          `SELECT id FROM activity_types WHERE code=? AND active=1 LIMIT 1`,
          [actionType]
        );
        activityTypeId=activityRows[0]?.id||null;
      }
      await pool.query(
        `INSERT INTO plan_steps
         (id,plan_id,sequence,title,description,status,activity_type_id,intended_start_simulation_at,deadline_simulation_at,result,version)
         VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,'PENDING',?,NULL,NULL,?,1)`,
        [
          uuid(),planId,i+1,
          `Progress: ${actionType.toLowerCase().replaceAll("_"," ")}`,
          `Complete ${actionType.toLowerCase().replaceAll("_"," ")} as part of the persistent goal.`,
          activityTypeId,
          JSON.stringify({
            actionType,
            attempts:0,
            completions:0,
            requiredCompletions:template.goalType==="LONG_TERM"?6:3,
            progressModel:"CUMULATIVE_ACTIONS"
          })
        ]
      );
    }
    await pool.query(
      `UPDATE plan_steps SET status='ACTIVE',version=version+1
       WHERE plan_id=UUID_TO_BIN(?) AND sequence=1 AND status='PENDING'`,
      [planId]
    );
  }

  return goalId;
}

async function ensurePersistentGoals({simulationId,entityId,simulationTime}){
  const created=[];
  if(
    !(await hasActivePersistentGoal(simulationId,entityId,"PERSONAL")) &&
    !(await hasRecentPersistentGoal(simulationId,entityId,"PERSONAL",simulationTime,PERSONAL_GOAL_INTERVAL_HOURS))
  ){
    const template=await choosePersonalGoalTemplate(simulationId,entityId);
    const goalId=await createPersistentGoal({simulationId,entityId,simulationTime,template,priority:.45});
    if(goalId)created.push({goalId,goalType:"PERSONAL",key:template.key});
  }

  if(
    !(await hasActivePersistentGoal(simulationId,entityId,"LONG_TERM")) &&
    !(await hasRecentPersistentGoal(simulationId,entityId,"LONG_TERM",simulationTime,LONG_TERM_GOAL_INTERVAL_HOURS))
  ){
    const template=await chooseLongTermGoalTemplate(entityId);
    const goalId=await createPersistentGoal({simulationId,entityId,simulationTime,template,priority:.35});
    if(goalId)created.push({goalId,goalType:"LONG_TERM",key:template.key});
  }
  return created;
}

async function ensureGoalPlan({simulationId,entityId,simulationTime,needs}){
  let activeGoal=await getActiveGoal(simulationId,entityId);

  if(activeGoal){
    const motivation=parseJson(activeGoal.motivation,{})||{};
    const goalResult=parseJson(activeGoal.result,{})||{};
    const needCode=normalizeAction(motivation.need);
    const createdAt=activeGoal.createdAt?new Date(activeGoal.createdAt).getTime():NaN;
    const ageHours=Number.isFinite(createdAt)?(new Date(simulationTime).getTime()-createdAt)/3600000:0;
    const currentNeed=(needs||[]).find(need=>normalizeAction(need.code)===needCode);
    const currentValue=Number(currentNeed?.value||0);

    if(activeGoal.status==="BLOCKED"){
      const resource=goalResult.resource||resourceForGoalNeed(needCode);
      // Physical reachability is the source of truth for the action itself.
      // This also lets simulations recover legacy BLOCKED food goals even when
      // the economy subsystem has not created a market row yet.
      const reachable=resource
        ?await isCriticalResourceReachable(simulationId,entityId,resource)
        :false;
      if(resource&&reachable){
        await unblockBlockedGoal({simulationId,entityId,goalId:activeGoal.id,simulationTime});
        activeGoal=await getActiveGoal(simulationId,entityId);
      }else{
        const plan=await getPlanForGoal(simulationId,entityId,activeGoal.id);
        await ensurePersistentGoals({simulationId,entityId,simulationTime});
        return{goal:activeGoal,plan,created:false,blocked:true};
      }
    }

    if(
      activeGoal.goalType==="NEED" &&
      ((GOAL_PRESSURE_CODES.has(needCode)&&currentValue<.22) ||
       (ageHours>MAX_GOAL_AGE_HOURS&&Number(activeGoal.progress||0)<=0))
    ){
      await abandonGoal({
        simulationId,
        entityId,
        goalId:activeGoal.id,
        simulationTime,
        reason:currentValue<.22?"GOAL_OBSOLETE_NEED_SATISFIED":"GOAL_STALE"
      });
      activeGoal=null;
    }else if(activeGoal.goalType!=="NEED"){
      const plan=await getPlanForGoal(simulationId,entityId,activeGoal.id);
      await ensurePersistentGoals({simulationId,entityId,simulationTime});
      return{goal:activeGoal,plan,created:false,persistent:true};
    }else{
      let plan=await getPlanForGoal(simulationId,entityId,activeGoal.id);
      if(!plan&&GOAL_TEMPLATES[needCode]){
        const replanCount=Number(goalResult.replanCount||0);
        const avoidLocationIds=Array.isArray(goalResult.avoidLocationIds)?goalResult.avoidLocationIds:[];
        const avoidTargetEntityIds=Array.isArray(goalResult.avoidTargetEntityIds)?goalResult.avoidTargetEntityIds:[];
        plan=await createPlanForGoal({simulationId,entityId,goalId:activeGoal.id,simulationTime,needCode,pressure:motivation.pressure,priority:activeGoal.priority,replanCount,avoidLocationIds,avoidTargetEntityIds});
      }
      await ensurePersistentGoals({simulationId,entityId,simulationTime});
      return{goal:activeGoal,plan,created:false};
    }
  }

  const topNeed=selectTopNeed(needs);
  if(topNeed){
    const template=GOAL_TEMPLATES[String(topNeed.code).toUpperCase()];
    if(template){
      const goalId=uuid();
      const priority=Math.max(.1,Math.min(1,Number(topNeed.priorityWeight||.5)));
      const mysqlTime=mysqlSimulationDateTime(simulationTime);
      await pool.query(
        `INSERT INTO goals (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,created_simulation_at,motivation,version)
         VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',0,?,CAST(? AS JSON),1)`,
        [goalId,simulationId,entityId,template.title,template.description,template.goalType,priority,mysqlTime,
          JSON.stringify({need:String(topNeed.code).toUpperCase(),pressure:Number(topNeed.value),priorityWeight:Number(topNeed.priorityWeight||1),source:"AUTONOMOUS_NEED"})]
      );
      const plan=await createPlanForGoal({simulationId,entityId,goalId,simulationTime,needCode:String(topNeed.code).toUpperCase(),pressure:topNeed.value,priority});
      await ensurePersistentGoals({simulationId,entityId,simulationTime});
      const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,title,description,goal_type AS goalType,priority,status,progress,motivation,result,created_simulation_at AS createdAt FROM goals WHERE id=UUID_TO_BIN(?) LIMIT 1`,[goalId]);
      return{goal:rows[0]||null,plan,created:true};
    }
  }

  const persistent=await ensurePersistentGoals({simulationId,entityId,simulationTime});
  if(persistent.length){
    const goalId=persistent[0].goalId;
    const [rows]=await pool.query(
      `SELECT BIN_TO_UUID(id) AS id,title,description,goal_type AS goalType,priority,status,progress,motivation,result,created_simulation_at AS createdAt
       FROM goals WHERE id=UUID_TO_BIN(?) LIMIT 1`,
      [goalId]
    );
    const plan=await getPlanForGoal(simulationId,entityId,goalId);
    return{goal:rows[0]||null,plan,created:true,persistent:true};
  }
  return{goal:null,plan:null,created:false};
}

function selectActiveStep(plan){const steps=Array.isArray(plan?.steps)?plan.steps.slice().sort((a,b)=>Number(a.sequence)-Number(b.sequence)):[];return steps.find(step=>step.status==="ACTIVE")||steps.find(step=>step.status==="PENDING")||null;}

const PERSISTENT_STRATEGY_VARIANTS = Object.freeze({
  PERSONAL: {
    SOCIAL_CONNECTION: [["TALKING"],["EXPLORING","TALKING"],["TALKING","HELPING"]],
    CREATIVE_EXPLORATION: [["EXPLORING","READING"],["PLAYING","EXPLORING"],["READING","EXPLORING"]],
    EXPLORATION: [["EXPLORING"],["WALKING","EXPLORING"],["LEARNING","EXPLORING"]]
  },
  LONG_TERM: {
    GROWTH: [["STUDYING","WORKING"],["READING","STUDYING"],["TEACHING","WORKING"]],
    KNOWLEDGE: [["EXPLORING","READING"],["LEARNING","READING"],["EXPLORING","LEARNING"]],
    RELATIONSHIPS: [["TALKING","TALKING"],["EXPLORING","TALKING"],["TALKING","HELPING"]]
  }
});

function buildPersistentStrategyVariants(goalType,goalKey){
  const type=String(goalType||"").toUpperCase();
  const key=String(goalKey||"").toUpperCase();
  return (PERSISTENT_STRATEGY_VARIANTS[type]?.[key]||[["EXPLORING"]]).map(steps=>steps.map(normalizeAction));
}

async function createPersistentPlanForGoal({
  simulationId,entityId,goalId,simulationTime,goalType,goalKey,strategyIndex=0,recoveryCount=0,
  preservedProgress=0,avoidLocationIds=[],avoidTargetEntityIds=[],db=pool
}={}){
  if(!goalId)return null;
  const existing=await getPlanForGoal(simulationId,entityId,goalId,db);
  if(existing)return existing;
  const variants=buildPersistentStrategyVariants(goalType,goalKey);
  const steps=variants[Math.max(0,Number(strategyIndex)||0)%variants.length];
  if(!steps.length)return null;
  const planId=uuid(),mysqlTime=mysqlSimulationDateTime(simulationTime);
  const safeAvoidLocations=[...new Set((avoidLocationIds||[]).filter(Boolean).map(String))].slice(0,8);
  const safeAvoidTargets=[...new Set((avoidTargetEntityIds||[]).filter(Boolean).map(String))].slice(0,8);
  await db.query(
    "INSERT INTO plans (id,simulation_id,entity_id,goal_id,title,status,strategy,created_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)",
    [
      planId,simulationId,entityId,goalId,
      "Persistent strategy "+(Number(recoveryCount)||0),
      JSON.stringify({source:"AUTONOMOUS_PERSISTENT",goalType:String(goalType||"").toUpperCase(),goalKey:String(goalKey||""),recoveryCount:Number(recoveryCount)||0,strategyIndex:Number(strategyIndex)||0,progressDriven:true,preservedGoalProgress:Number(Number(preservedProgress)||0)}),
      mysqlTime
    ]
  );
  const requiredCompletions=String(goalType||"").toUpperCase()==="LONG_TERM"?6:3;
  for(let index=0;index<steps.length;index+=1){
    const actionType=normalizeAction(steps[index]);
    let activityTypeId=null;
    if(actionType){
      const[activityRows]=await db.query("SELECT id FROM activity_types WHERE code=? AND active=1 LIMIT 1",[actionType]);
      activityTypeId=activityRows[0]?.id||null;
    }
    await db.query(
      "INSERT INTO plan_steps (id,plan_id,sequence,title,description,status,activity_type_id,intended_start_simulation_at,deadline_simulation_at,result,version) " +
      "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,'PENDING',?,NULL,NULL,?,1)",
      [
        uuid(),planId,index+1,
        "Progress: "+actionType.toLowerCase().replaceAll("_"," "),
        "Use "+actionType.toLowerCase().replaceAll("_"," ")+" as one strategy for this persistent goal.",
        activityTypeId,
        JSON.stringify({actionType,attempts:0,completions:0,requiredCompletions,progressModel:"CUMULATIVE_ACTIONS",strategyVariant:Number(strategyIndex)||0,avoidLocationIds:safeAvoidLocations,avoidTargetEntityIds:safeAvoidTargets})
      ]
    );
  }
  await db.query("UPDATE plan_steps SET status='ACTIVE',version=version+1 WHERE plan_id=UUID_TO_BIN(?) AND sequence=1 AND status='PENDING'",[planId]);
  return getPlanForGoal(simulationId,entityId,goalId,db);
}

async function handleGoalStagnation({simulationId,entityId,simulationTime,goalState,currentLocationId=null}={}){
  const goal=goalState?.goal,plan=goalState?.plan;
  if(!goal||!plan||String(goal.status||"").toUpperCase()!=="ACTIVE")return null;
  const now=simulationTimestampMs(simulationTime);
  if(!Number.isFinite(now))return null;
  const goalResult=parseJson(goal.result,{})||{};
  const lastProgressMs=simulationTimestampMs(goalResult.lastProgressAt||goal.createdAt);
  const lastRecoveryMs=simulationTimestampMs(goalResult.lastStagnationRecoveryAt);
  const anchor=Math.max(Number.isFinite(lastProgressMs)?lastProgressMs:now,Number.isFinite(lastRecoveryMs)?lastRecoveryMs:0);
  const stagnantHours=Math.max(0,(now-anchor)/3600000);
  if(stagnantHours<GOAL_STAGNATION_REPLAN_HOURS)return null;
  const goalType=String(goal.goalType||"").toUpperCase();
  const persistent=PERSISTENT_GOAL_TYPES.has(goalType);
  const recoveryCount=Math.max(0,Number(goalResult.stagnationReplans)||0);
  const activeStep=selectActiveStep(plan);
  if(!activeStep)return null;
  const motivation=parseJson(goal.motivation,{})||{};
  const goalKey=String(motivation.goalKey||goalResult.goalKey||"").trim().toUpperCase();
  const stepResult=parseJson(activeStep.result,{})||{};
  const avoidLocationIds=new Set(Array.isArray(stepResult.avoidLocationIds)?stepResult.avoidLocationIds:[]);
  const avoidTargetEntityIds=new Set(Array.isArray(stepResult.avoidTargetEntityIds)?stepResult.avoidTargetEntityIds:[]);
  const activeAction=normalizeAction(stepResult.actionType||activeStep.actionType);
  if(currentLocationId&&(activeAction==="DRINKING"||activeAction==="EATING"))avoidLocationIds.add(currentLocationId);

  if(persistent){
    const recovery=await withTransaction(async conn=>{
      const [goalRows]=await conn.query(
        "SELECT status,version,progress FROM goals WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
        [goal.id,simulationId,entityId]
      );
      if(!goalRows.length||String(goalRows[0].status||"").toUpperCase()!=="ACTIVE"||Number(goalRows[0].version)!==Number(goal.version))return null;
      const [planRows]=await conn.query(
        "SELECT status,version FROM plans WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
        [plan.id,simulationId,entityId,goal.id]
      );
      if(!planRows.length||String(planRows[0].status||"").toUpperCase()!=="ACTIVE"||Number(planRows[0].version)!==Number(plan.version))return null;
      for(const step of plan.steps||[]){
        const status=String(step.status||"").toUpperCase();
        if(["PENDING","ACTIVE","BLOCKED"].includes(status))assertTransition("plan_step",status,"CANCELLED");
      }
      assertTransition("plan","ACTIVE","CANCELLED");
      await conn.query("UPDATE plan_steps SET status='CANCELLED',version=version+1 WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')",[plan.id]);
      await conn.query("UPDATE plans SET status='CANCELLED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'",[plan.id]);

      const nextRecoveryCount=recoveryCount+1;
      const variants=buildPersistentStrategyVariants(goalType,goalKey);
      const strategyIndex=(nextRecoveryCount-1)%variants.length;
      const ineffectiveApproaches=Array.isArray(goalResult.ineffectiveApproaches)?goalResult.ineffectiveApproaches.slice(-7):[];
      ineffectiveApproaches.push({
        planId:plan.id,stepId:activeStep.id,actionType:activeAction||null,attemptedAt:simulationTime,
        stagnantHours:Number(stagnantHours.toFixed(2)),recoveryCount:nextRecoveryCount,
        avoidLocationIds:[...avoidLocationIds].slice(0,8),avoidTargetEntityIds:[...avoidTargetEntityIds].slice(0,8)
      });
      const newPlan=await createPersistentPlanForGoal({
        simulationId,entityId,goalId:goal.id,simulationTime,goalType,goalKey,
        strategyIndex,recoveryCount:nextRecoveryCount,
        preservedProgress:Math.max(Number(goalRows[0].progress||0),Number(goal.progress||0)),
        avoidLocationIds:[...avoidLocationIds],avoidTargetEntityIds:[...avoidTargetEntityIds],db:conn
      });
      if(!newPlan)throw Object.assign(new Error("Persistent goal could not be replanned"),{code:"GOAL_PERSISTENT_REPLAN_FAILED"});
      const nextGoalResult={...goalResult,goalKey:goalKey||null,stagnationReplans:nextRecoveryCount,lastStagnationRecoveryAt:simulationTime,lastStagnationAction:activeAction||null,lastStagnationStrategyIndex:strategyIndex,ineffectiveApproaches};
      const [updatedGoal]=await conn.query(
        "UPDATE goals SET progress=GREATEST(progress,?),result=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?",
        [Number(goal.progress||0),JSON.stringify(nextGoalResult),goal.id,simulationId,entityId,Number(goal.version)]
      );
      if(!updatedGoal.affectedRows)throw Object.assign(new Error("Persistent stagnation goal changed during replan"),{code:"GOAL_REPLAN_CONFLICT"});
      return{replanned:true,abandoned:false,recoveryCount:nextRecoveryCount,stagnantHours,newPlanId:newPlan.id,strategyIndex,preservedProgress:Number(goal.progress||0)};
    });
    if(!recovery)return null;
    logger.warn({simulationId,entityId,goalId:goal.id,oldPlanId:plan.id,newPlanId:recovery.newPlanId,simulationTime,stagnantHours:Number(recovery.stagnantHours.toFixed(2)),progress:Number(goal.progress||0),stagnationReplans:recovery.recoveryCount,strategyIndex:recovery.strategyIndex},"persistent goal stagnation triggered strategy change");
    return recovery;
  }

  const needCode=normalizeAction(motivation.need);
  if(!GOAL_TEMPLATES[needCode])return null;
  if(recoveryCount>=MAX_GOAL_STAGNATION_REPLANS){
    const abandoned=await abandonGoal({simulationId,entityId,goalId:goal.id,simulationTime,reason:"GOAL_STAGNATION_REPLAN_LIMIT"});
    return abandoned?{abandoned:true,recoveryCount,stagnantHours}:null;
  }
  const recovery=await withTransaction(async conn=>{
    const [goalRows]=await conn.query("SELECT status,version FROM goals WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",[goal.id,simulationId,entityId]);
    if(!goalRows.length||String(goalRows[0].status||"").toUpperCase()!=="ACTIVE"||Number(goalRows[0].version)!==Number(goal.version))return null;
    const [planRows]=await conn.query("SELECT status,version FROM plans WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND goal_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",[plan.id,simulationId,entityId,goal.id]);
    if(!planRows.length||String(planRows[0].status||"").toUpperCase()!=="ACTIVE"||Number(planRows[0].version)!==Number(plan.version))return null;
    for(const step of plan.steps||[]){const status=String(step.status||"").toUpperCase();if(["PENDING","ACTIVE","BLOCKED"].includes(status))assertTransition("plan_step",status,"CANCELLED");}
    assertTransition("plan","ACTIVE","CANCELLED");
    await conn.query("UPDATE plan_steps SET status='CANCELLED',version=version+1 WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')",[plan.id]);
    await conn.query("UPDATE plans SET status='CANCELLED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'",[plan.id]);
    const nextRecoveryCount=recoveryCount+1;
    const newPlan=await createPlanForGoal({simulationId,entityId,goalId:goal.id,simulationTime,needCode,pressure:Number(motivation.pressure||0),priority:Number(goal.priority||.5),replanCount:Number(goalResult.replanCount||0),avoidLocationIds:[...avoidLocationIds].slice(0,8),avoidTargetEntityIds:[...avoidTargetEntityIds].slice(0,8),db:conn});
    if(!newPlan)throw Object.assign(new Error("Stagnated goal could not be replanned"),{code:"GOAL_REPLAN_FAILED"});
    const nextGoalResult={...goalResult,stagnationReplans:nextRecoveryCount,lastStagnationRecoveryAt:simulationTime,lastStagnationAction:activeAction||null};
    const [updatedGoal]=await conn.query("UPDATE goals SET result=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?",[JSON.stringify(nextGoalResult),goal.id,simulationId,entityId,Number(goal.version)]);
    if(!updatedGoal.affectedRows)throw Object.assign(new Error("Stagnated goal changed during replan"),{code:"GOAL_REPLAN_CONFLICT"});
    return{replanned:true,abandoned:false,recoveryCount:nextRecoveryCount,stagnantHours,newPlanId:newPlan.id};
  });
  if(!recovery)return null;
  logger.warn({simulationId,entityId,goalId:goal.id,oldPlanId:plan.id,newPlanId:recovery.newPlanId,simulationTime,stagnantHours:Number(recovery.stagnantHours.toFixed(2)),progress:Number(goal.progress||0),stagnationReplans:recovery.recoveryCount},"goal stagnation triggered bounded replan");
  return recovery;
}
async function resolveGoalIdFromAction({simulationId,entityId,actionId}){if(!actionId)return null;const[rows]=await pool.query(`SELECT BIN_TO_UUID(source_goal_id) AS goalId FROM actions WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[actionId,simulationId,entityId]);return rows[0]?.goalId||null;}
async function advancePersistentGoalFromAnyAutonomousAction({simulationId,entityId,actionType,outcome,simulationTime,actionResult=null,excludeGoalId=null}={}){
  const actionId=actionResult?.actionId||null;
  if(!actionId)return null;

  const [actionRows]=await pool.query(
    `SELECT source_type AS sourceType
     FROM actions
     WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
     LIMIT 1`,
    [actionId,simulationId,entityId]
  );
  if(String(actionRows[0]?.sourceType||"").toUpperCase()!=="AUTONOMOUS")return null;

  const [rows]=await pool.query(
    `SELECT BIN_TO_UUID(g.id) AS goalId,g.goal_type AS goalType,g.priority,g.created_simulation_at AS createdAt,
            BIN_TO_UUID(p.id) AS planId,
            BIN_TO_UUID(ps.id) AS stepId,ps.sequence,ps.status AS stepStatus,ps.result
     FROM goals g
     JOIN plans p
       ON p.goal_id=g.id
      AND p.simulation_id=g.simulation_id
      AND p.entity_id=g.entity_id
      AND p.status IN ('DRAFT','ACTIVE','PAUSED')
     JOIN plan_steps ps
       ON ps.plan_id=p.id
      AND ps.status='ACTIVE'
     WHERE g.simulation_id=UUID_TO_BIN(?)
       AND g.entity_id=UUID_TO_BIN(?)
       AND g.status IN ('DRAFT','ACTIVE','PAUSED')
       AND g.goal_type IN ('PERSONAL','LONG_TERM')
       AND g.id<>UUID_TO_BIN(?)
     ORDER BY g.priority DESC,g.created_simulation_at ASC,ps.sequence ASC
     LIMIT 10`,
    [simulationId,entityId,excludeGoalId||"00000000-0000-0000-0000-000000000000"]
  );

  const action=normalizeAction(actionType);
  const candidate=rows.find(row=>{
    const stepResult=parseJson(row.result,{})||{};
    return normalizeAction(stepResult.actionType)===action;
  });
  if(!candidate)return null;

  const result=await advancePlanForAction({
    simulationId,
    entityId,
    goalId:candidate.goalId,
    actionType:action,
    outcome,
    simulationTime,
    actionResult
  });
  return{...result,goalId:candidate.goalId};
}

async function advancePlanForAction({simulationId,entityId,goalId,actionType,outcome,simulationTime,actionResult=null}){
  const resolvedGoalId=goalId||await resolveGoalIdFromAction({
    simulationId,
    entityId,
    actionId:actionResult?.actionId
  });
  if(!resolvedGoalId)return{changed:false,completed:false,progress:null,planId:null};

  goalId=resolvedGoalId;
  const plan=await getPlanForGoal(simulationId,entityId,goalId);
  if(!plan)return{changed:false,completed:false,progress:null,planId:null};
  if(plan.status==="BLOCKED")return{changed:false,completed:false,progress:null,planId:plan.id,blocked:true};

  const [goalRows]=await pool.query(
    `SELECT goal_type AS goalType,progress,status,result,motivation,version
     FROM goals
     WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
     LIMIT 1`,
    [goalId,simulationId,entityId]
  );
  if(!goalRows.length)return{changed:false,completed:false,progress:null,planId:plan.id};

  const goal=goalRows[0];
  const goalType=String(goal.goalType||"").toUpperCase();
  const persistent=PERSISTENT_GOAL_TYPES.has(goalType);
  const step=selectActiveStep(plan);
  if(!step)return{changed:false,completed:true,progress:1,planId:plan.id};

  const normalizedAction=normalizeAction(actionType);
  const expectedAction=normalizeAction(parseJson(step.result,{})?.actionType||step.actionType);
  const normalizedOutcome=String(outcome||"").toUpperCase();
  const successful=normalizedOutcome==="SUCCESS";
  const partial=normalizedOutcome==="PARTIAL";
  const failed=normalizedOutcome==="FAILURE";
  let changed=false;

  const motivation=parseJson(goal.motivation,{})||{};
  const goalNeed=normalizeAction(motivation.need);
  const goalTemplate=GOAL_TEMPLATES[goalNeed];
  const terminalGoalAction=normalizeAction(
    goalTemplate?.steps?.[goalTemplate.steps.length-1]?.actionType
  );

  // A NEED goal may be satisfied directly before its planned movement step.
  // For example, an actor can already be at a water source and successfully
  // DRINKING makes the THIRST goal true even though WALKING was still the
  // active plan step. Do not count that as stagnation: complete the goal and
  // cancel the now-obsolete route plan.
  const directNeedCompletion=
    goalType==="NEED" &&
    successful &&
    normalizedAction===terminalGoalAction &&
    expectedAction!==normalizedAction;

  if(directNeedCompletion){
    const goalResult=parseJson(goal.result,{})||{};
    const directCompletionResult={
      ...goalResult,
      completionSource:"NEED_SATISFIED_DIRECTLY",
      satisfiedByAction:normalizedAction,
      satisfiedAt:simulationTime,
      lastProgressAt:simulationTime,
      progressModel:"DIRECT_NEED_SATISFACTION"
    };

    await pool.query(
      `UPDATE plan_steps
       SET status='CANCELLED',
           result=JSON_SET(COALESCE(result,JSON_OBJECT()),
             '$.cancelledReason','GOAL_SATISFIED_DIRECTLY',
             '$.satisfiedByAction',?,
             '$.satisfiedAt',?),
           version=version+1
       WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')`,
      [normalizedAction,simulationTime,plan.id]
    );
    await pool.query(
      `UPDATE plans
       SET status='CANCELLED',version=version+1
       WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')`,
      [plan.id]
    );
    const mysqlTime=mysqlSimulationDateTime(simulationTime);
    const [goalUpdated]=await pool.query(
      `UPDATE goals
       SET progress=1,status='COMPLETED',completed_simulation_at=?,result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')`,
      [
        mysqlTime,
        JSON.stringify(directCompletionResult),
        goalId,
        entityId,
        Number(goal.version)
      ]
    );
    return{
      changed:goalUpdated.affectedRows===1,
      completed:goalUpdated.affectedRows===1,
      progress:1,
      planId:plan.id,
      directNeedCompletion:true
    };
  }

  const resourceBlock=isResourceBlockedFailure(normalizedAction,outcome,actionResult);

  // Resource failures are actionable only for the step that actually requires
  // that resource/action. Incidental EATING/DRINKING must not block unrelated goals.
  //
  // Matching failures intentionally continue through the normal step-failure
  // path, which marks the step FAILED and triggers replanning while keeping
  // the parent goal ACTIVE.
  if(
    resourceBlock &&
    (
      expectedAction!==normalizedAction ||
      !stepRequiresResource(step,resourceBlock.resource)
    )
  ){
    return{changed:false,completed:false,progress:null,planId:plan.id,resourceFailureIgnored:true};
  }

  if(expectedAction===normalizedAction&&successful){
    const previousResult=parseJson(step.result,{})||{};

    if(persistent){
      const requiredCompletions=Math.max(
        2,
        Number(previousResult.requiredCompletions)||(
          goalType==="LONG_TERM"?6:3
        )
      );
      const completions=Math.max(0,Number(previousResult.completions)||0)+1;
      const nextResult={
        ...previousResult,
        actionType:normalizedAction,
        outcome,
        attempts:Math.max(0,Number(previousResult.attempts)||0),
        completions,
        requiredCompletions,
        progressModel:"CUMULATIVE_ACTIONS",
        lastCompletedAt:simulationTime,
        lastActionResult:compactActionResult(actionResult)
      };

      if(completions>=requiredCompletions){
        const[updated]=await pool.query(
          `UPDATE plan_steps
           SET status='COMPLETED',result=?,version=version+1
           WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
          [JSON.stringify({...nextResult,completions:requiredCompletions}),step.id,step.version]
        );
        changed=updated.affectedRows===1;

        if(changed){
          const nextStep=plan.steps
            .filter(candidate=>Number(candidate.sequence)>Number(step.sequence))
            .sort((a,b)=>Number(a.sequence)-Number(b.sequence))[0];
          if(nextStep){
            await pool.query(
              `UPDATE plan_steps
               SET status='ACTIVE',version=version+1
               WHERE id=UUID_TO_BIN(?) AND status='PENDING'`,
              [nextStep.id]
            );
          }
        }
      }else{
        const[updated]=await pool.query(
          `UPDATE plan_steps
           SET status='ACTIVE',result=?,version=version+1
           WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
          [JSON.stringify(nextResult),step.id,step.version]
        );
        changed=updated.affectedRows===1;
      }
    }else{
      const[updated]=await pool.query(
        `UPDATE plan_steps
         SET status='COMPLETED',result=?,version=version+1
         WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
        [JSON.stringify({actionType:normalizedAction,outcome,completedAt:simulationTime,actionResult:compactActionResult(actionResult)}),step.id,step.version]
      );
      changed=updated.affectedRows===1;

      if(changed){
        const nextStep=plan.steps
          .filter(candidate=>Number(candidate.sequence)>Number(step.sequence))
          .sort((a,b)=>Number(a.sequence)-Number(b.sequence))[0];
        if(nextStep){
          await pool.query(
            `UPDATE plan_steps
             SET status='ACTIVE',version=version+1
             WHERE id=UUID_TO_BIN(?) AND status='PENDING'`,
            [nextStep.id]
          );
        }
      }
    }
  }else if(expectedAction===normalizedAction&&(failed||partial)){
    const previousResult=parseJson(step.result,{})||{};
    const attempts=Math.max(0,Number(previousResult.attempts)||0)+1;
    const failedTarget=actionResult?.targetEntityId||actionResult?.resource?.targetEntityId||null;
    const failedLocation=actionResult?.targetLocationId||actionResult?.locationId||actionResult?.resource?.locationId||null;

    if(persistent){
      // Persistent goals are learning trajectories, not one-shot tasks.
      // A failed attempt records experience but must not kill the whole goal.
      const avoidLocationIds=new Set(Array.isArray(previousResult.avoidLocationIds)?previousResult.avoidLocationIds:[]);
      const avoidTargetEntityIds=new Set(Array.isArray(previousResult.avoidTargetEntityIds)?previousResult.avoidTargetEntityIds:[]);
      if(failedLocation)avoidLocationIds.add(failedLocation);
      if(failedTarget)avoidTargetEntityIds.add(failedTarget);

      await pool.query(
        `UPDATE plan_steps
         SET status='ACTIVE',result=?,version=version+1
         WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
        [
          JSON.stringify({
            ...previousResult,
            actionType:normalizedAction,
            outcome,
            attempts,
            lastAttemptAt:simulationTime,
            lastActionResult:compactActionResult(actionResult),
            ...(resourceBlock?{
              blockedReason:"RESOURCE_UNAVAILABLE_REQUIRES_REPLAN",
              resource:resourceBlock.resource,
              resourceReason:resourceBlock.reason
            }:{}),
            avoidLocationIds:[...avoidLocationIds].slice(0,8),
            avoidTargetEntityIds:[...avoidTargetEntityIds].slice(0,8)
          }),
          step.id,
          step.version
        ]
      );
      changed=true;
    }else{
      const failedTarget=actionResult?.targetEntityId||actionResult?.resource?.targetEntityId||null;
      const failedLocation=actionResult?.targetLocationId||actionResult?.locationId||actionResult?.resource?.locationId||null;
      const avoidLocationIds=new Set(Array.isArray(previousResult.avoidLocationIds)?previousResult.avoidLocationIds:[]);
      const avoidTargetEntityIds=new Set(Array.isArray(previousResult.avoidTargetEntityIds)?previousResult.avoidTargetEntityIds:[]);
      if(failedLocation)avoidLocationIds.add(failedLocation);
      if(failedTarget)avoidTargetEntityIds.add(failedTarget);

      if(attempts>=MAX_STEP_ATTEMPTS){
        await pool.query(
          `UPDATE plan_steps
           SET status='FAILED',result=?,version=version+1
           WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
          [
            JSON.stringify({
              ...previousResult,
              actionType:normalizedAction,
              outcome,
              attempts,
              lastAttemptAt:simulationTime,
              lastActionResult:actionResult,
              blockedReason:resourceBlock
                ?"RESOURCE_UNAVAILABLE_REQUIRES_REPLAN"
                :"ACTION_FAILED_REQUIRES_REPLAN",
              ...(resourceBlock?{
                resource:resourceBlock.resource,
                resourceReason:resourceBlock.reason
              }:{}),
              avoidLocationIds:[...avoidLocationIds].slice(0,8),
              avoidTargetEntityIds:[...avoidTargetEntityIds].slice(0,8)
            }),
            step.id,
            step.version
          ]
        );
        changed=true;
      }else{
        await pool.query(
          `UPDATE plan_steps
           SET status='ACTIVE',result=?,version=version+1
           WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','PENDING')`,
          [
            JSON.stringify({
              ...previousResult,
              actionType:normalizedAction,
              outcome,
              attempts,
              lastAttemptAt:simulationTime,
              avoidLocationIds:[...avoidLocationIds].slice(0,8),
              avoidTargetEntityIds:[...avoidTargetEntityIds].slice(0,8)
            }),
            step.id,
            step.version
          ]
        );
        changed=true;
      }
    }
  }

  const refreshedPlan=await getPlanForGoal(simulationId,entityId,goalId);
  if(!refreshedPlan)return{changed,completed:false,progress:null,planId:plan.id};

  const totalSteps=refreshedPlan.steps.length;
  const completedSteps=refreshedPlan.steps.filter(candidate=>candidate.status==="COMPLETED").length;
  const failedSteps=refreshedPlan.steps.filter(candidate=>candidate.status==="FAILED").length;

  let progress=0;
  const strategyProgressBase=Number(refreshedPlan.strategy?.progressBase);
  const strategyProgressUnit=Number(refreshedPlan.strategy?.progressUnit);
  if(Number.isFinite(strategyProgressBase)&&Number.isFinite(strategyProgressUnit)&&strategyProgressUnit>0){
    let contributionUnits=0;
    for(const candidate of refreshedPlan.steps){
      if(candidate.status==="COMPLETED"){
        contributionUnits+=1;
        continue;
      }
      if(persistent){
        const result=parseJson(candidate.result,{})||{};
        const required=Math.max(2,Number(result.requiredCompletions)||(goalType==="LONG_TERM"?6:3));
        const completions=Math.max(0,Number(result.completions)||0);
        contributionUnits+=Math.min(1,completions/required);
      }
    }
    progress=Math.max(0,Math.min(1,strategyProgressBase+contributionUnits*strategyProgressUnit));
  }else if(totalSteps){
    let units=0;
    for(const candidate of refreshedPlan.steps){
      if(candidate.status==="COMPLETED"){
        units+=1;
        continue;
      }
      if(persistent){
        const result=parseJson(candidate.result,{})||{};
        const required=Math.max(2,Number(result.requiredCompletions)||(goalType==="LONG_TERM"?6:3));
        const completions=Math.max(0,Number(result.completions)||0);
        units+=Math.min(1,completions/required);
      }
      break;
    }
    progress=Number((units/totalSteps).toFixed(4));
  }

  const planCompleted=totalSteps>0&&completedSteps===totalSteps;
  if(planCompleted&&refreshedPlan.status!=="COMPLETED"){
    await pool.query(
      `UPDATE plans
       SET status='COMPLETED',version=version+1
       WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED')`,
      [refreshedPlan.id]
    );
  }

  if(failedSteps>0&&refreshedPlan.status!=="CANCELLED"&&!persistent){
    await pool.query(
      `UPDATE plan_steps
       SET status='CANCELLED',version=version+1
       WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')`,
      [refreshedPlan.id]
    );
    await pool.query(
      `UPDATE plans
       SET status='CANCELLED',version=version+1
       WHERE id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED','BLOCKED')`,
      [refreshedPlan.id]
    );
  }

  const goalStatus=String(goal.status||"").toUpperCase();
  const currentGoalVersion=Number(goal.version)||0;
  let goalVersionAfterProgress=currentGoalVersion;

  if(progress<1&&["ACTIVE","DRAFT","PAUSED"].includes(goalStatus)){
    const previousGoalProgress=Number(goal.progress||0);
    const effectiveProgress=persistent?Math.max(previousGoalProgress,progress):progress;
    const progressImproved=effectiveProgress>previousGoalProgress+0.0001;
    const previousGoalResult=parseJson(goal.result,{})||{};
    const nextGoalResult={
      ...previousGoalResult,
      ...(progressImproved?{
        lastProgressAt:simulationTime,
        lastStagnationRecoveryAt:null
      }:{})
    };
    const[goalUpdated]=await pool.query(
      "UPDATE goals SET progress=?,result=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')",
      [effectiveProgress,JSON.stringify(nextGoalResult),goalId,entityId,currentGoalVersion]
    );
    if(goalUpdated.affectedRows)goalVersionAfterProgress=currentGoalVersion+1;
  }

  if(planCompleted){
    const mysqlTime=mysqlSimulationDateTime(simulationTime);
    const previousGoalResult=parseJson(goal.result,{})||{};
    const completionResult={
      ...previousGoalResult,
      completionSource:"PLAN",
      completedAt:simulationTime,
      lastProgressAt:simulationTime,
      progressModel:persistent?"CUMULATIVE_ACTIONS":"STEP_COMPLETION"
    };
    const[completedGoal]=await pool.query(
      `UPDATE goals
       SET progress=1,status='COMPLETED',completed_simulation_at=?,result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')`,
      [
        mysqlTime,
        JSON.stringify(completionResult),
        goalId,
        entityId,
        goalVersionAfterProgress
      ]
    );
    return{changed:true,completed:completedGoal.affectedRows===1,progress:1,planId:refreshedPlan.id};
  }

  if(failedSteps>0&&!persistent){
    const previousGoalResult=parseJson(goal.result,{})||{};
    const replanCount=Number(previousGoalResult.replanCount||0)+1;
    const failedStep=refreshedPlan.steps.find(candidate=>candidate.id===step.id)||step;
    const stepResult=parseJson(failedStep.result,{})||{};
    const avoidLocationIds=Array.isArray(stepResult.avoidLocationIds)?stepResult.avoidLocationIds:[];
    const avoidTargetEntityIds=Array.isArray(stepResult.avoidTargetEntityIds)?stepResult.avoidTargetEntityIds:[];

    if(replanCount>=MAX_PLAN_REPLANS){
      await pool.query(
        `UPDATE plan_steps
         SET status='CANCELLED',version=version+1
         WHERE plan_id=UUID_TO_BIN(?) AND status IN ('PENDING','ACTIVE','BLOCKED')`,
        [refreshedPlan.id]
      );
      await pool.query(
        `UPDATE goals
         SET status='ABANDONED',result=?,version=version+1
         WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED','BLOCKED')`,
        [
          JSON.stringify({
            reason:"PLAN_REPLAN_LIMIT",
            failedStep:failedStep.title,
            actionType:normalizedAction,
            outcome,
            replanCount,
            avoidLocationIds,
            avoidTargetEntityIds
          }),
          goalId,
          goal.version
        ]
      );
      return{changed:true,completed:false,progress,planId:refreshedPlan.id,abandoned:true,replanCount};
    }

    const nextGoalVersion=currentGoalVersion+(progress<1?1:0);
    const currentResult=parseJson(goal.result,{})||{};
    await pool.query(
      `UPDATE goals
       SET result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND version=? AND status IN ('ACTIVE','DRAFT','PAUSED')`,
      [
        JSON.stringify({
          ...currentResult,
          reason:"REPLAN_REQUIRED",
          replanCount,
          avoidLocationIds,
          avoidTargetEntityIds,
          lastFailure:{actionType:normalizedAction,outcome,at:simulationTime}
        }),
        goalId,
        Math.max(currentGoalVersion,nextGoalVersion)
      ]
    );
    return{changed:true,completed:false,progress,planId:refreshedPlan.id,replanRequired:true,replanCount};
  }

  return{changed,completed:false,progress,planId:refreshedPlan.id};
}
module.exports={GOAL_TEMPLATES,MAX_GOAL_AGE_HOURS,GOAL_STAGNATION_REPLAN_HOURS,MAX_GOAL_STAGNATION_REPLANS,PERSONAL_GOAL_INTERVAL_HOURS,LONG_TERM_GOAL_INTERVAL_HOURS,PERSISTENT_GOAL_TYPES,PERSISTENT_STRATEGY_VARIANTS,buildPersistentStrategyVariants,selectTopNeed,selectActiveStep,createPlanForGoal,createPersistentPlanForGoal,ensureGoalPlan,advancePlanForAction,advancePersistentGoalFromAnyAutonomousAction,handleGoalStagnation,abandonGoal,ensurePersistentGoals,unblockBlockedGoal,revalidateBlockedResourceGoals};
