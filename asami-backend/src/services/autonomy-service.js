const { pool } = require("../db/pool");
const { buildDecisionContext, makeDecision } = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");

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
  const top=needs.slice().sort((a,b)=>(Number(b.value)*Number(b.priorityWeight))-(Number(a.value)*Number(a.priorityWeight)))[0];
  if(!top)return null;
  const goalId=require("../lib/ids").uuid();
  const labels={HUNGER:"Find food",THIRST:"Find water",SLEEPINESS:"Get enough sleep",ENERGY:"Recover energy",
    SOCIAL_NEED:"Connect with someone",FUN:"Have fun",CURIOSITY:"Learn something new",ACHIEVEMENT:"Accomplish something",
    BELONGING:"Strengthen belonging",COMFORT:"Seek comfort",SAFETY:"Stay safe"};
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

async function actForEntity({simulationId,entityId,simulationTime,gemini}){
  const entity=await getEntity(simulationId,entityId);
  if(!entity)return null;
  const context=await buildDecisionContext(simulationId,entityId);
  const goalId=await createGoalIfNeeded(simulationId,entityId,simulationTime,context.needs);
  const memories=await recallContext(simulationId,entityId,6);
  let aiChoice=null;
  if(gemini && gemini.client && context.candidates[0]?.score < 0.8){
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
serializeReason(decision.reason),simulationTime]);  decision.intentionId=intentionId;
  decision.goalId=goalId;
  return decision;
}

async function completeGoalForAction(goalId,actionType,simulationTime){
  if(!goalId)return;
  const goalAction={
    EATING:["HUNGER"],DRINKING:["THIRST"],SLEEPING:["SLEEPINESS","ENERGY"],
    RESTING:["ENERGY","COMFORT"],TALKING:["SOCIAL_NEED","BELONGING"],
    PLAYING:["FUN"],STUDYING:["ACHIEVEMENT","CURIOSITY"],READING:["CURIOSITY","ACHIEVEMENT"],
    EXPLORING:["CURIOSITY"],WORKING:["ACHIEVEMENT"],WALKING:["FUN","CURIOSITY"],WATCHING:["FUN"]
  };
  if(!(goalAction[actionType]||[]).length)return;
  await pool.query(`
    UPDATE goals SET progress=1,status='COMPLETED',completed_simulation_at=?,
      result=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED')
  `,[simulationTime,JSON.stringify({completedByAction:actionType}),goalId]);
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

module.exports={findAutonomousActors,actForEntity,completeGoalForAction};
