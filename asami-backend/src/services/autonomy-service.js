const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { buildDecisionContext, makeDecision } = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");

const lastAutonomyDecisionAt=new Map();

async function findAutonomousActors(simulationId, limit=100){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS id
    FROM entities e
    JOIN entity_types et ON et.id=e.entity_type_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR'
      AND e.status NOT IN ('INACTIVE','DEAD')
      AND NOT EXISTS (
        SELECT 1 FROM autonomy_policies ap
        WHERE ap.simulation_id=e.simulation_id
          AND ap.policy_type='AUTONOMY'
          AND ap.enabled=0
          AND (ap.entity_id=e.id OR ap.entity_id IS NULL)
      )
    ORDER BY e.created_simulation_at LIMIT ?
  `,[simulationId,limit]);
  return rows.map(r=>r.id);
}

async function createGoalIfNeeded(simulationId,entityId,simulationTime,needs){
  const [active]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      AND status IN ('DRAFT','ACTIVE','PAUSED') LIMIT 1
  `,[simulationId,entityId]);
  if(active.length)return active[0].id;

  const goalPressureCodes=new Set([
    "HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN",
    "CURIOSITY","ACHIEVEMENT","BELONGING"
  ]);
  const candidates=needs.filter(n => goalPressureCodes.has(n.code) && Number(n.value)>0.18);
  const top=candidates.slice().sort((a,b)=>(Number(b.value)*Number(b.priorityWeight))-(Number(a.value)*Number(a.priorityWeight)))[0];
  if(!top)return null;

  const goalId=require("../lib/ids").uuid();
  const labels={HUNGER:"Find food",THIRST:"Find water",SLEEPINESS:"Get enough sleep",
    SOCIAL_NEED:"Connect with someone",FUN:"Have fun",CURIOSITY:"Learn something new",
    ACHIEVEMENT:"Accomplish something",BELONGING:"Strengthen belonging"};
  await pool.query(`
    INSERT INTO goals
      (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,created_simulation_at,motivation,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',0,?,CAST(? AS JSON),1)
  `,[goalId,simulationId,entityId,labels[top.code]||`Address ${top.code}`,
     `Autonomously generated from need ${top.code}`,"NEED",Number(top.priorityWeight),simulationTime,
     JSON.stringify({need:top.code,pressure:Number(top.value),priorityWeight:Number(top.priorityWeight)})]);
  return goalId;
}

function serializeReason(reason) {
  if (reason === null || reason === undefined) return null;
  if (typeof reason === "string") return JSON.stringify({ text: reason });
  return JSON.stringify(reason);
}

function shouldAskGemini(entity, context) {
  if (!entity || entity.entityType !== "PERSON") return false;
  const candidates = context.candidates || [];
  if (!candidates.length) return true;

  const top = Number(candidates[0].score || 0);
  const second = Number(candidates[1]?.score || 0);
  const gap = top - second;

  if (top < 0.70) return true;
  if (gap < 0.12) return true;

  const activeGoal = (context.goals || []).find(g => Number(g.priority || 0) >= 0.8 && Number(g.progress || 0) < 1);
  if (activeGoal && second > 0 && top < 1.05) return true;

  return false;
}

function canUseGeminiDecision(entityId,simulationTime){
  const now=new Date(simulationTime).getTime();
  if(!Number.isFinite(now))return false;
  const previous=lastAutonomyDecisionAt.get(entityId);
  if(previous===undefined){lastAutonomyDecisionAt.set(entityId,now);return true;}
  const configured=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES);
  const requested=Number.isFinite(configured) ? configured : 30;
  // Existing .env files may still contain the old 360-minute value. Keep a
  // predictable upper bound so Gemini is genuinely available to the simulation.
  const intervalMinutes=Math.min(60,Math.max(30,requested));
  const interval=intervalMinutes*60000;
  if(now-previous<interval)return false;
  lastAutonomyDecisionAt.set(entityId,now);
  return true;
}

async function actForEntity({simulationId,entityId,simulationTime,gemini}){
  const entity=await getEntity(simulationId,entityId);
  if(!entity)return null;
  const context=await buildDecisionContext(simulationId,entityId);
  const goalId=await createGoalIfNeeded(simulationId,entityId,simulationTime,context.needs);
  const memories=await recallContext(simulationId,entityId,6);
  let aiChoice=null;

  if(
    gemini &&
    gemini.client &&
    shouldAskGemini(entity,context) &&
    canUseGeminiDecision(entity.id,simulationTime)
  ){
    aiChoice=await gemini.chooseDecision({
      entity:{id:entity.id,name:entity.displayName},
      needs:context.needs,traits:context.traits,goals:context.goals,
      memories,allowedActionTypes:context.allowedActionTypes,candidates:context.candidates
    });
  }

  const decision=await makeDecision({simulationId,entityId,simulationTime,context,aiChoice});
  const target=await selectTalkTarget(simulationId,entityId,decision.actionType);
  if(target) decision.targetEntityId=target;
  const intentionId=require("../lib/ids").uuid();
  await pool.query(`
    INSERT INTO intentions
      (id,simulation_id,entity_id,goal_id,action_type,target_entity_id,scheduled_simulation_at,priority,status,reason,created_simulation_at,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'ACTIVE',?,?,1)
  `,[intentionId,simulationId,entityId,goalId,decision.actionType,decision.targetEntityId||null,
     simulationTime,Number(context.candidates.find(x=>x.action===decision.actionType)?.score||0),
     serializeReason(decision.reason),simulationTime]);
  decision.intentionId=intentionId;
  decision.goalId=goalId;
  return decision;
}

const GOAL_ACTIONS = {
  HUNGER: new Set(["EATING"]),
  THIRST: new Set(["DRINKING"]),
  SLEEPINESS: new Set(["SLEEPING"]),
  ENERGY: new Set(["SLEEPING","RESTING"]),
  SOCIAL_NEED: new Set(["TALKING"]),
  BELONGING: new Set(["TALKING"]),
  FUN: new Set(["PLAYING","WATCHING"]),
  CURIOSITY: new Set(["STUDYING","READING","EXPLORING"]),
  ACHIEVEMENT: new Set(["STUDYING","READING","WORKING"])
};

function goalActionSatisfiesNeed(needCode, actionType){
  return GOAL_ACTIONS[needCode]?.has(String(actionType || "").toUpperCase()) || false;
}

async function completeGoalForAction(goalId,actionType,simulationTime){
  if(!goalId)return false;
  const [rows]=await pool.query(`
    SELECT motivation FROM goals
    WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED')
    LIMIT 1
  `,[goalId]);
  if(!rows.length)return false;
  let motivation=rows[0].motivation;
  if(Buffer.isBuffer(motivation))motivation=motivation.toString();
  if(typeof motivation === "string"){
    try{motivation=JSON.parse(motivation);}catch{motivation=null;}
  }
  const needCode=String(motivation?.need||"").toUpperCase();
  if(!goalActionSatisfiesNeed(needCode,actionType))return false;

  const [updated]=await pool.query(`
    UPDATE goals SET progress=1,status='COMPLETED',completed_simulation_at=?,
      result=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED')
  `,[simulationTime,JSON.stringify({completedByAction:actionType,need:needCode}),goalId]);
  return Boolean(updated.affectedRows);
}

async function selectTalkTarget(simulationId,entityId,actionType){
  if(actionType!=="TALKING")return null;
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id FROM entities
    WHERE simulation_id=UUID_TO_BIN(?) AND id<>UUID_TO_BIN(?) AND status NOT IN ('INACTIVE','DEAD')
    ORDER BY RAND() LIMIT 1
  `,[simulationId,entityId]);
  return rows[0]?.id||null;
}

module.exports={findAutonomousActors,actForEntity,completeGoalForAction,shouldAskGemini,canUseGeminiDecision,goalActionSatisfiesNeed};
