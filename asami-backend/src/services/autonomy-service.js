const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { buildDecisionContext, makeDecision } = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");
const { buildSocialContext, deriveSocialIntent } = require("./social-relationship-service");
const { shortestRoute } = require("./action-service");

const lastAutonomyDecisionAt=new Map();

const EXPLORATION_LOCATION_INTEREST={
  HOME:{},
  PARK:{FUN:0.45,SOCIAL_NEED:0.25,CURIOSITY:0.30},
  CAFE:{SOCIAL_NEED:0.55,BELONGING:0.30,FUN:0.20,CURIOSITY:0.15},
  SHOP:{HUNGER:0.25,THIRST:0.25,CURIOSITY:0.10},
  LIBRARY:{CURIOSITY:0.70,ACHIEVEMENT:0.55},
  SCHOOL:{ACHIEVEMENT:0.60,CURIOSITY:0.40},
  COMMUNITY:{SOCIAL_NEED:0.50,BELONGING:0.55,FUN:0.25},
  GYM:{FUN:0.45,ACHIEVEMENT:0.20},
  CLINIC:{SAFETY:0.60,COMFORT:0.20},
  NATURE:{CURIOSITY:0.80,FUN:0.35},
  WORKSHOP:{ACHIEVEMENT:0.55,CURIOSITY:0.45}
};

const RESOURCE_NEED_CODES={water:"THIRST",food:"HUNGER"};

function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==="object")return value;try{return JSON.parse(value);}catch{return fallback;}}
function clamp(value,min=0,max=1){const n=Number(value);if(!Number.isFinite(n))return min;return Math.max(min,Math.min(max,n));}

async function findAutonomousActors(simulationId,limit=100){
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

async function loadWorldLocations(simulationId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData,e.attributes FROM locations l JOIN entities e ON e.id=l.entity_id WHERE l.simulation_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId,simulationId]);
  return rows.map(row=>{const attributes=parseJson(row.attributes,{});return {locationId:row.locationId,locationType:row.locationType,latitude:Number(row.latitude),longitude:Number(row.longitude),data:parseJson(row.addressData,{}),resources:attributes.resources&&typeof attributes.resources==="object"?attributes.resources:{}};});
}

async function loadVisitedLocations(simulationId,entityId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId,MAX(entered_simulation_at) AS lastVisitedAt FROM entity_location_history WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) GROUP BY location_id`,[simulationId,entityId]);
  return new Map(rows.map(row=>[row.locationId,row.lastVisitedAt]));
}

function locationInterestScore(location,needs){
  const weights=EXPLORATION_LOCATION_INTEREST[location.locationType]||{};
  return Object.entries(weights).reduce((sum,[needCode,weight])=>{const need=needs.find(item=>item.code===needCode);return sum+clamp(need?.value||0)*weight;},0);
}

function explorationNoveltyScore(lastVisitedAt,simulationTime){
  if(!lastVisitedAt)return 1;
  const elapsed=(new Date(simulationTime).getTime()-new Date(lastVisitedAt).getTime())/3600000;
  if(!Number.isFinite(elapsed))return 0.5;
  if(elapsed>=72)return 0.95;
  if(elapsed>=24)return 0.75;
  if(elapsed>=8)return 0.50;
  if(elapsed>=2)return 0.30;
  return 0.10;
}

function routeTravelMinutes(route){if(!route||!Number.isFinite(Number(route.distanceMeters)))return Infinity;return Number(route.distanceMeters)/1000/4.8*60;}

async function chooseExplorationDestination(simulationId,entityId,originId,needs,simulationTime){
  if(!originId)return null;
  const [locations,visited]=await Promise.all([loadWorldLocations(simulationId),loadVisitedLocations(simulationId,entityId)]);
  const origin=locations.find(location=>location.locationId===originId);if(!origin)return null;
  const candidates=[];
  for(const location of locations){
    if(location.locationId===originId)continue;
    const route=shortestRoute(locations,originId,location.locationId);if(!route)continue;
    const travelMinutes=routeTravelMinutes(route);if(!Number.isFinite(travelMinutes))continue;
    const novelty=explorationNoveltyScore(visited.get(location.locationId),simulationTime);
    const interest=locationInterestScore(location,needs);
    let resourceOpportunity=0;
    for(const [resource,needCode] of Object.entries(RESOURCE_NEED_CODES)){
      const amount=Number(location.resources?.[resource]||0);
      const pressure=Number(needs.find(item=>item.code===needCode)?.value||0);
      if(amount>=1)resourceOpportunity+=Math.min(0.35,pressure*0.35);
    }
    const distancePenalty=Math.min(0.60,(travelMinutes/60)*0.60);
    const score=novelty*1.35+interest*1.15+resourceOpportunity-distancePenalty+Math.random()*0.05;
    candidates.push({locationId:location.locationId,locationType:location.locationType,travelMinutes,distanceMeters:route.distanceMeters,score,novelty,interest,resourceOpportunity});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

async function getEntityLocation(simulationId,entityId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);
  return rows[0]?.locationId||null;
}

async function chooseRemoteSocialTarget(simulationId,entityId,originId){
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(other.id) AS id,other.display_name AS name,BIN_TO_UUID(targetLoc.location_id) AS locationId,BIN_TO_UUID(r.id) AS relationshipId,COALESCE(r.familiarity_score,0) AS familiarity,COALESCE(r.closeness_score,0) AS closeness,COALESCE(r.affection_score,0) AS affection,COALESCE(r.trust_score,0) AS trust,COALESCE(r.attraction_score,0) AS attraction FROM entities other JOIN persons p ON p.entity_id=other.id JOIN entity_locations_current targetLoc ON targetLoc.entity_id=other.id AND targetLoc.simulation_id=UUID_TO_BIN(?) LEFT JOIN relationships r ON r.simulation_id=UUID_TO_BIN(?) AND r.status='ACTIVE' AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=other.id) OR (r.source_entity_id=other.id AND r.target_entity_id=UUID_TO_BIN(?))) WHERE other.simulation_id=UUID_TO_BIN(?) AND other.status='ACTIVE' AND other.id<>UUID_TO_BIN(?) ORDER BY other.display_name LIMIT 50`,[simulationId,simulationId,entityId,entityId,simulationId,entityId]);
  if(!rows.length)return null;
  const locations=await loadWorldLocations(simulationId);const candidates=[];
  for(const row of rows){
    if(!row.locationId||row.locationId===originId)continue;
    const route=shortestRoute(locations,originId,row.locationId);if(!route)continue;
    const travelMinutes=routeTravelMinutes(route);if(!Number.isFinite(travelMinutes))continue;
    const hasRelationship=Boolean(row.relationshipId);
    const relationshipScore=Number(row.familiarity)*0.9+Number(row.closeness)*1.1+Number(row.affection)*1.2+Number(row.trust)+Number(row.attraction)*0.8;
    const noveltyBonus=hasRelationship?0:0.30;
    const distancePenalty=Math.min(0.70,(travelMinutes/60)*0.70);
    const score=relationshipScore+noveltyBonus-distancePenalty;
    candidates.push({entityId:row.id,name:row.name,locationId:row.locationId,travelMinutes,distanceMeters:route.distanceMeters,score,relationshipId:row.relationshipId});
  }
  candidates.sort((a,b)=>b.score-a.score||a.travelMinutes-b.travelMinutes);return candidates[0]||null;
}

async function chooseSocialTarget(socialContext,simulationId,entityId,originId){
  const candidates=Array.isArray(socialContext?.candidates)?socialContext.candidates:[];
  if(candidates.length){
    const ranked=candidates.slice().sort((a,b)=>{const aPartner=socialContext.partner?.partnerId===a.id?1:0,bPartner=socialContext.partner?.partnerId===b.id?1:0;const aScore=Number(a.score||0)+aPartner*0.35+Number(a.romanticScore||0)*0.35;const bScore=Number(b.score||0)+bPartner*0.35+Number(b.romanticScore||0)*0.35;return bScore-aScore;});
    const target=ranked[0];return {entityId:target.id,name:target.name,locationId:originId,remote:false,score:Number(target.score||0)};
  }
  return chooseRemoteSocialTarget(simulationId,entityId,originId);
}

async function actForEntity({simulationId,entityId,simulationTime,gemini}){
  const entity=await getEntity(simulationId,entityId);if(!entity)return null;
  const context=await buildDecisionContext(simulationId,entityId,simulationTime);
  const socialContext=entity.entityType==="PERSON"?await buildSocialContext(simulationId,entityId):{partner:null,candidates:[]};
  context.social={partner:socialContext.partner,candidates:socialContext.candidates.map(c=>({id:c.id,name:c.name,relationshipType:c.relationshipType,compatibility:Number(c.compatibility.toFixed(3)),romanticScore:Number(c.romanticScore.toFixed(3)),familiarity:Number(c.relationship?.familiarity||0),closeness:Number(c.relationship?.closeness||0),affection:Number(c.relationship?.affection||0),trust:Number(c.relationship?.trust||0)}))};

  const currentLocationId=context.location?.locationId||await getEntityLocation(simulationId,entityId);let socialTarget=null;
  if(entity.entityType==="PERSON"&&currentLocationId){
    socialTarget=await chooseSocialTarget(socialContext,simulationId,entityId,currentLocationId);
    if(socialTarget)context.social.travelTarget={entityId:socialTarget.entityId,name:socialTarget.name,locationId:socialTarget.locationId,remote:Boolean(socialTarget.remote),travelMinutes:Number(socialTarget.travelMinutes||0)};
  }

  const explorationDestination=entity.entityType==="PERSON"&&currentLocationId?await chooseExplorationDestination(simulationId,entityId,currentLocationId,context.needs,simulationTime):null;
  if(explorationDestination)context.explorationDestination=explorationDestination;

  const goalId=await createGoalIfNeeded(simulationId,entityId,simulationTime,context.needs),memories=await recallContext(simulationId,entityId,6);let aiChoice=null;
  if(gemini&&gemini.client&&shouldAskGemini(entity,context)&&canUseGeminiDecision(entity.id,simulationTime)){
    aiChoice=await gemini.chooseDecision({entity:{id:entity.id,name:entity.displayName},needs:context.needs,traits:context.traits,goals:context.goals,memories,allowedActionTypes:context.allowedActionTypes,candidates:context.candidates,location:context.location,social:context.social,explorationDestination});
  }

  const decision=await makeDecision({simulationId,entityId,simulationTime,context,aiChoice});

  if(decision.actionType==="EXPLORING"&&explorationDestination){decision.targetLocationId=explorationDestination.locationId;decision.explorationDestination=explorationDestination;}

  if(decision.actionType==="TALKING"){
    const aiTarget=aiChoice?.targetEntityId;const localAiTarget=socialContext.candidates.some(candidate=>candidate.id===aiTarget);
    socialTarget=localAiTarget?await chooseSocialTarget(socialContext,simulationId,entityId,currentLocationId):socialTarget;
    if(socialTarget){
      decision.targetEntityId=socialTarget.entityId;
      if(socialTarget.locationId&&socialTarget.locationId!==currentLocationId){
        decision.actionType="WALKING";
        decision.targetLocationId=socialTarget.locationId;
        decision.socialTravel={targetEntityId:socialTarget.entityId,targetName:socialTarget.name,destinationLocationId:socialTarget.locationId,expectedTravelMinutes:Number(socialTarget.travelMinutes||0)};
        decision.relationshipIntent="NONE";
      }
    }
  }

  if(decision.actionType==="TALKING")decision.relationshipIntent=deriveSocialIntent({actionType:decision.actionType,targetId:decision.targetEntityId,partner:socialContext.partner,candidates:socialContext.candidates});

  await pool.query(`UPDATE decisions SET context=? WHERE id=UUID_TO_BIN(?)`,[JSON.stringify({...context,aiChoice:aiChoice||null,chosenAction:decision.actionType,relationshipDecision:{intent:decision.relationshipIntent||"NONE",targetEntityId:decision.targetEntityId||null},targetLocationId:decision.targetLocationId||null}),decision.decisionId]);

  const intentionId=require("../lib/ids").uuid();
  await pool.query(`INSERT INTO intentions (id,simulation_id,entity_id,goal_id,action_type,target_entity_id,scheduled_simulation_at,priority,status,reason,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'ACTIVE',?,?,1)`,[intentionId,simulationId,entityId,goalId,decision.actionType,decision.targetEntityId||null,simulationTime,Number(context.candidates.find(x=>x.action===decision.actionType)?.score||0),serializeReason(decision.reason),simulationTime]);

  if(decision.targetLocationId||decision.socialTravel||decision.explorationDestination){
    await pool.query(`UPDATE decision_options SET option_code=?,description=?,action_definition=?,evaluation=?,expected_outcome=? WHERE id=(SELECT selected_option_id FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1)`,[decision.actionType,`Autonomously selected ${decision.actionType}`,JSON.stringify({actionType:decision.actionType,targetEntityId:decision.targetEntityId||null,targetLocationId:decision.targetLocationId||null}),JSON.stringify({score:Number(context.candidates.find(x=>x.action===decision.actionType)?.score||0),targetLocationId:decision.targetLocationId||null}),JSON.stringify({actionType:decision.actionType,targetLocationId:decision.targetLocationId||null}),decision.decisionId]);
  }

  decision.intentionId=intentionId;decision.goalId=goalId;return decision;
}

const GOAL_ACTIONS={HUNGER:new Set(["EATING"]),THIRST:new Set(["DRINKING"]),SLEEPINESS:new Set(["SLEEPING"]),ENERGY:new Set(["SLEEPING","RESTING"]),SOCIAL_NEED:new Set(["TALKING"]),BELONGING:new Set(["TALKING"]),FUN:new Set(["PLAYING","WATCHING"]),CURIOSITY:new Set(["STUDYING","READING","EXPLORING"]),ACHIEVEMENT:new Set(["STUDYING","READING","WORKING"])};
function goalActionSatisfiesNeed(needCode,actionType){return GOAL_ACTIONS[needCode]?.has(String(actionType||"").toUpperCase())||false;}
async function completeGoalForAction(goalId,actionType,simulationTime){if(!goalId)return false;const [rows]=await pool.query(`SELECT motivation FROM goals WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED') LIMIT 1`,[goalId]);if(!rows.length)return false;let motivation=rows[0].motivation;if(Buffer.isBuffer(motivation))motivation=motivation.toString();if(typeof motivation==='string'){try{motivation=JSON.parse(motivation);}catch{motivation=null;}}const needCode=String(motivation?.need||"").toUpperCase();if(!goalActionSatisfiesNeed(needCode,actionType))return false;const [updated]=await pool.query(`UPDATE goals SET progress=1,status='COMPLETED',completed_simulation_at=?,result=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status IN ('ACTIVE','DRAFT','PAUSED')`,[simulationTime,JSON.stringify({completedByAction:actionType,need:needCode}),goalId]);return Boolean(updated.affectedRows);}

module.exports={findAutonomousActors,actForEntity,completeGoalForAction,shouldAskGemini,canUseGeminiDecision,goalActionSatisfiesNeed,chooseSocialTarget,chooseExplorationDestination};
