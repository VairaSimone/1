const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { buildDecisionContext, makeDecision } = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");
const { buildSocialContext, deriveSocialIntent } = require("./social-relationship-service");

const lastAutonomyDecisionAt=new Map();

async function findAutonomousActors(simulationId, limit=100){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR' AND e.status NOT IN ('INACTIVE','DEAD') AND NOT EXISTS (SELECT 1 FROM autonomy_policies ap WHERE ap.simulation_id=e.simulation_id AND ap.policy_type='AUTONOMY' AND ap.enabled=0 AND (ap.entity_id=e.id OR ap.entity_id IS NULL)) ORDER BY e.created_simulation_at LIMIT ?`,[simulationId,limit]);
  return rows.map(r=>r.id);
}

async function createGoalIfNeeded(simulationId,entityId,simulationTime,needs){
  const [active]=await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED') LIMIT 1`,[simulationId,entityId]);if(active.length)return active[0].id;
  const goalPressureCodes=new Set(["HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN","CURIOSITY","ACHIEVEMENT","BELONGING"]);
  const candidates=needs.filter(n=>goalPressureCodes.has(n.code)&&Number(n.value)>0.18),top=candidates.slice().sort((a,b)=>(Number(b.value)*Number(b.priorityWeight))-(Number(a.value)*Number(a.priorityWeight)))[0];if(!top)return null;
  const goalId=require("../lib/ids").uuid(),labels={HUNGER:"Find food",THIRST:"Find water",SLEEPINESS:"Get enough sleep",SOCIAL_NEED:"Connect with someone",FUN:"Have fun",CURIOSITY:"Learn something new",ACHIEVEMENT:"Accomplish something",BELONGING:"Strengthen belonging"};
  await pool.query(`INSERT INTO goals (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,created_simulation_at,motivation,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',0,?,CAST(? AS JSON),1)`,[goalId,simulationId,entityId,labels[top.code]||`Address ${top.code}`,`Autonomously generated from need ${top.code}`,"NEED",Number(top.priorityWeight),simulationTime,JSON.stringify({need:top.code,pressure:Number(top.value),priorityWeight:Number(top.priorityWeight)})]);
  return goalId;
}
function serializeReason(reason){if(reason===null||reason===undefined)return null;if(typeof reason==='string')return JSON.stringify({text:reason});return JSON.stringify(reason);}
function shouldAskGemini(entity,context){if(!entity||entity.entityType!=="PERSON")return false;const candidates=context.candidates||[];if(!candidates.length)return true;const top=Number(candidates[0].score||0),second=Number(candidates[1]?.score||0),gap=top-second;if(top<0.70)return true;if(gap<0.12)return true;const activeGoal=(context.goals||[]).find(g=>Number(g.priority||0)>=0.8&&Number(g.progress||0)<1);return Boolean(activeGoal&&second>0&&top<1.05);}
function canUseGeminiDecision(entityId,simulationTime){const now=new Date(simulationTime).getTime();if(!Number.isFinite(now))return false;const previous=lastAutonomyDecisionAt.get(entityId);if(previous===undefined){lastAutonomyDecisionAt.set(entityId,now);return true;}const configured=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES),requested=Number.isFinite(configured)?configured:30,intervalMinutes=Math.min(60,Math.max(30,requested));if(now-previous<intervalMinutes*60000)return false;lastAutonomyDecisionAt.set(entityId,now);return true;}

function chooseSocialTarget(socialContext){
  const candidates=Array.isArray(socialContext?.candidates)?socialContext.candidates:[];if(!candidates.length)return null;
  const ranked=candidates.slice().sort((a,b)=>{
    const aPartner=socialContext.partner?.partnerId===a.id?1:0,bPartner=socialContext.partner?.partnerId===b.id?1:0;
    const aScore=Number(a.score||0)+aPartner*0.35+Number(a.romanticScore||0)*0.35;
    const bScore=Number(b.score||0)+bPartner*0.35+Number(b.romanticScore||0)*0.35;
    return bScore-aScore;
  });
  return ranked[0]?.id||null;
}

async function actForEntity({simulationId,entityId,simulationTime,gemini}){
  const entity=await getEntity(simulationId,entityId);if(!entity)return null;
  const context=await buildDecisionContext(simulationId,entityId);
  const socialContext=entity.entityType==="PERSON"?await buildSocialContext(simulationId,entityId):{partner:null,candidates:[]};
  context.social={partner:socialContext.partner,candidates:socialContext.candidates.map(c=>({id:c.id,name:c.name,relationshipType:c.relationshipType,compatibility:Number(c.compatibility.toFixed(3)),romanticScore:Number(c.romanticScore.toFixed(3)),familiarity:Number(c.relationship?.familiarity||0),closeness:Number(c.relationship?.closeness||0),affection:Number(c.relationship?.affection||0),trust:Number(c.relationship?.trust||0)}))};
  const goalId=await createGoalIfNeeded(simulationId,entityId,simulationTime,context.needs),memories=await recallContext(simulationId,entityId,6);let aiChoice=null;
  if(gemini&&gemini.client&&shouldAskGemini(entity,context)&&canUseGeminiDecision(entity.id,simulationTime)){
    aiChoice=await gemini.chooseDecision({entity:{id:entity.id,name:entity.displayName},needs:context.needs,traits:context.traits,goals:context.goals,memories,allowedActionTypes:context.allowedActionTypes,candidates:context.candidates,location:context.location,social:context.social});
  }
  const decision=await makeDecision({simulationId,entityId,simulationTime,context,aiChoice});
  if(decision.actionType==="TALKING"){
    const target=aiChoice?.targetEntityId && socialContext.candidates.some(c=>c.id===aiChoice.targetEntityId) ? aiChoice.targetEntityId : chooseSocialTarget(socialContext);
    if(target)decision.targetEntityId=target;
  }
  decision.relationshipIntent=deriveSocialIntent({actionType:decision.actionType,targetId:decision.targetEntityId,partner:socialContext.partner,candidates:socialContext.candidates});
  await pool.query(`UPDATE decisions SET context=? WHERE id=UUID_TO_BIN(?)`,[JSON.stringify({...context,aiChoice:aiChoice||null,relationshipDecision:{intent:decision.relationshipIntent,targetEntityId:decision.targetEntityId||null}}),decision.decisionId]);
  const intentionId=require("../lib/ids").uuid();
  await pool.query(`INSERT INTO intentions (id,simulation_id,entity_id,goal_id,action_type,target_entity_id,scheduled_simulation_at,priority,status,reason,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'ACTIVE',?,?,1)`,[intentionId,simulationId,entityId,goalId,decision.actionType,decision.targetEntityId||null,simulationTime,Number(context.candidates.find(x=>x.action===decision.actionType)?.score||0),serializeReason(decision.reason),simulationTime]);
  decision.intentionId=intentionId;decision.goalId=goalId;return decision;
}

const GOAL_ACTIONS={HUNGER:new Set(["EATING"]),THIRST:new Set(["DRINKING"]),SLEEPINESS:new Set(["SLEEPING"]),ENERGY:new Set(["SLEEPING","RESTING"]),SOCIAL_NEED:new Set(["TALKING"]),BELONGING:new Set(["TALKING"]),FUN:new Set(["PLAYING","WATCHING"]),CURIOSITY:new Set(["STUDYING","READING","EXPLORING"]),ACHIEVEMENT:new Set(["STUDYING","READING","WORKING"])};
function goalActionSatisfiesNeed(needCode,actionType){return GOAL_ACTIONS[needCode]?.has(String(actionType||"").toUpperCase())||false;}
async function completeGoalForAction(goalId,actionType,simulationTime){if(!goalId)return false;const [rows]=await pool.query(`SELECT motivation FROM goals WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED') LIMIT 1`,[goalId]);if(!rows.length)return false;let motivation=rows[0].motivation;if(Buffer.isBuffer(motivation))motivation=motivation.toString();if(typeof motivation==='string'){try{motivation=JSON.parse(motivation);}catch{motivation=null;}}const needCode=String(motivation?.need||"").toUpperCase();if(!goalActionSatisfiesNeed(needCode,actionType))return false;const [updated]=await pool.query(`UPDATE goals SET progress=1,status='COMPLETED',completed_simulation_at=?,result=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED')`,[simulationTime,JSON.stringify({completedByAction:actionType,need:needCode}),goalId]);return Boolean(updated.affectedRows);}

module.exports={findAutonomousActors,actForEntity,completeGoalForAction,shouldAskGemini,canUseGeminiDecision,goalActionSatisfiesNeed,chooseSocialTarget};
