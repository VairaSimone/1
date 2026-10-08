const { pool } = require("../db/pool");
const geminiBudget = require("./gemini-budget-service");
const logger = require("../lib/logger");
const { env } = require("../config/env");
const decisionService = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");
const { buildSocialContext, buildSocialContexts, buildRemoteSocialContexts, deriveSocialIntent } = require("./social-relationship-service");
const actionService = require("./action-service");
const { ensureGoalPlan, advancePlanForAction, advancePersistentGoalFromAnyAutonomousAction, selectActiveStep, handleGoalStagnation, MAX_GOAL_AGE_HOURS } = require("./planning-service");
const { refreshMentalStateFromSimulation } = require("./personality-service");
const observability = require("./simulation-observability");
const { finalizeDecisionCognitiveArtifacts } = require("./decision-cognitive-finalization-service");
const { readNeeds } = require("./state-service");

const lastAutonomyDecisionAt=new Map();
const lastHighValueGeminiDecisionAt=new Map();
const lastPeriodicGeminiDecisionAt=new Map();
const lastGeminiTriggerKeyByEntity=new Map();
const EXPLORATION_LOCATION_INTEREST={HOME:{},PARK:{FUN:.45,SOCIAL_NEED:.25,CURIOSITY:.30},CAFE:{SOCIAL_NEED:.55,BELONGING:.30,FUN:.20,CURIOSITY:.15},SHOP:{HUNGER:.25,THIRST:.25,CURIOSITY:.10},LIBRARY:{CURIOSITY:.70,ACHIEVEMENT:.55},SCHOOL:{ACHIEVEMENT:.60,CURIOSITY:.40},COMMUNITY:{SOCIAL_NEED:.50,BELONGING:.55,FUN:.25},GYM:{FUN:.45,ACHIEVEMENT:.20},CLINIC:{SAFETY:.60,COMFORT:.20},NATURE:{CURIOSITY:.80,FUN:.35},WORKSHOP:{ACHIEVEMENT:.55,CURIOSITY:.45}};
const RESOURCE_NEED_CODES={water:"THIRST",food:"HUNGER"};
const GOAL_PRESSURE_CODES=new Set(["HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN","CURIOSITY","ACHIEVEMENT","BELONGING"]);
function goalNeedsValidation(goal,plan,needs=[],simulationTime){
  if(!goal||!plan)return true;
  const motivation=parseJson(goal.motivation,{})||{};
  const needCode=String(motivation.need||"").toUpperCase();
  const currentNeed=(needs||[]).find(need=>String(need.code||"").toUpperCase()===needCode);
  const currentValue=Number(currentNeed?.value);
  if(GOAL_PRESSURE_CODES.has(needCode)&&Number.isFinite(currentValue)&&currentValue<.22)return true;
  const createdAt=new Date(goal.createdAt||0).getTime();
  const now=new Date(simulationTime||0).getTime();
  const progress=Number(goal.progress||0);
  return Number.isFinite(createdAt)&&Number.isFinite(now)&&
    (now-createdAt)/3600000>MAX_GOAL_AGE_HOURS&&progress<=0;
}
function normalizeAction(value){
  return String(value||"").trim().toUpperCase().replace(/[^A-Z0-9]+/g,"_");
}
function parseJson(value,fallback={}){if(value===null||value===undefined)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return fallback;}}
function clamp(value,min=0,max=1){const n=Number(value);if(!Number.isFinite(n))return min;return Math.max(min,Math.min(max,n));}
function mysqlSimulationDateTime(value){const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.getTime()))throw Object.assign(new Error("Invalid simulation time"),{code:"INVALID_SIMULATION_TIME"});const pad=n=>String(n).padStart(2,"0"),ms=String(date.getUTCMilliseconds()).padStart(3,"0");return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;}
function resolveConnection(locations,value){if(value===null||value===undefined)return null;const key=String(value),upper=key.toUpperCase();return locations.find(location=>String(location.locationId)===key)||locations.find(location=>String(location.data?.worldCode||'').toUpperCase()===upper)||null;}
function graphRoute(locations,originId,targetId){if(!originId||!targetId)return null;return actionService.shortestRoute(locations,originId,targetId);}
function buildGeminiDecisionContext({entity,context,memories=[]}={}){
  const compact = decisionService.compactDecisionContext({
    ...context,
    candidates: Array.isArray(context?.candidates)
      ? context.candidates.slice().sort((a,b)=>Number(b?.score||0)-Number(a?.score||0)).slice(0,5)
      : [],
    goals: Array.isArray(context?.goals) ? context.goals.slice(0,3) : [],
    recentActions: Array.isArray(context?.recentActions) ? context.recentActions.slice(0,8) : [],
    recoveryBlocks: Array.isArray(context?.recoveryBlocks) ? context.recoveryBlocks.slice(0,4) : []
  });

  const profile=context?.cognitiveProfile||{};
  const compactMemory=(memory)=>({
    id:memory?.id||null,
    type:memory?.memoryType||null,
    simulationAt:memory?.simulationAt||memory?.createdSimulationAt||null,
    importance:Number.isFinite(Number(memory?.importance))?Number(Number(memory.importance).toFixed(3)):null,
    strength:Number.isFinite(Number(memory?.strength))?Number(Number(memory.strength).toFixed(3)):null,
    content:String(memory?.content||"").slice(0,500),
    metadata:memory?.metadata&&typeof memory.metadata==="object"?{
      kind:memory.metadata.kind||null,
      actionType:memory.metadata.actionType||memory.metadata.decision?.actionType||null,
      outcome:memory.metadata.outcome||null,
      failureReason:memory.metadata.failureReason||null,
      locationId:memory.metadata.locationId||memory.metadata.location?.id||null,
      goalId:memory.metadata.goalId||memory.metadata.decision?.goalId||null,
      resource:typeof memory.metadata.resource==="string"
        ? memory.metadata.resource
        : memory.metadata.resource?.resource||null
    }:null
  });

  const recentFailures=[
    ...(Array.isArray(context?.recentInterruptions)?context.recentInterruptions.slice(0,4).map(row=>({
      type:"INTERRUPTION",
      actionType:row.actionType||null,
      at:row.at||null,
      interruption:row.result?.interruption||null,
      failureReason:row.result?.failureReason||"ACTION_INTERRUPTED"
    })):[]),
    ...memories
      .filter(memory=>{
        const meta=memory?.metadata&&typeof memory.metadata==="object"?memory.metadata:{};
        return meta.kind==="resource_failure"||meta.kind==="action_interruption"||meta.outcome==="FAILURE"||meta.outcome==="PARTIAL";
      })
      .slice(0,4)
      .map(memory=>({
        type:"MEMORY",
        actionType:memory?.metadata?.actionType||memory?.metadata?.decision?.actionType||null,
        at:memory?.simulationAt||null,
        failureReason:memory?.metadata?.failureReason||null,
        resource:memory?.metadata?.resource?.resource||memory?.metadata?.resource||null,
        memoryId:memory?.id||null
      }))
  ].slice(0,6);

  const socialCandidates=Array.isArray(context?.social?.candidates)
    ? context.social.candidates.slice(0,4).map(candidate=>({
        id:candidate.id||null,
        name:candidate.name||null,
        relationshipType:candidate.relationshipType||null,
        compatibility:Number(candidate.compatibility||0),
        familiarity:Number(candidate.familiarity||0),
        closeness:Number(candidate.closeness||0),
        affection:Number(candidate.affection||0),
        trust:Number(candidate.trust||0),
        conflict:Number(candidate.conflict||0),
        irritation:Number(candidate.irritation||0),
        romanticScore:Number(candidate.romanticScore||0)
      }))
    : [];

  const preferences=Array.isArray(profile.preferences)?profile.preferences.slice(0,8).map(item=>({
    targetType:item.targetType||null,
    targetEntityId:item.targetEntityId||null,
    preferenceValue:Number(item.preferenceValue||0),
    strength:Number(item.strength||0),
    confidence:Number(item.confidence||0)
  })):[];

  const beliefs=Array.isArray(profile.beliefs)?profile.beliefs.slice(0,6).map(item=>({
    predicate:item.predicate||null,
    subjectEntityId:item.subjectEntityId||null,
    objectValue:item.objectValue??null,
    confidence:Number(item.confidence||0),
    importance:Number(item.importance||0)
  })):[];

  const knowledge=Array.isArray(profile.knowledge)?profile.knowledge.slice(0,6).map(item=>({
    knowledgeType:item.knowledgeType||null,
    predicate:item.predicate||null,
    content:String(item.content||"").slice(0,300),
    confidence:Number(item.confidence||0),
    importance:Number(item.importance||0)
  })):[];

  const habits=Array.isArray(profile.habits)?profile.habits.slice(0,4).map(item=>({
    name:item.name||null,
    strength:Number(item.strength||0),
    triggerDefinition:item.triggerDefinition||null,
    actionDefinition:item.actionDefinition||null
  })):[];

  const mentalState=profile.mentalState&&typeof profile.mentalState==="object"?{
    currentFocus:profile.mentalState.currentFocus||null,
    currentConcern:profile.mentalState.currentConcern||null,
    recentThought:String(profile.mentalState.recentThought||"").slice(0,300)||null,
    mentalLoad:Number(profile.mentalState.mentalLoad||0),
    rumination:Number(profile.mentalState.rumination||0),
    certainty:Number(profile.mentalState.certainty||0),
    updatedSimulationAt:profile.mentalState.updatedSimulationAt||null
  }:null;

  return {
    schemaVersion:"gemini-decision-v1",
    simulationTime:context?.simulationTime||null,
    entity:{id:entity?.id||null,name:entity?.displayName||entity?.name||null},
    needs:compact.needs,
    traits:compact.traits.slice(0,12),
    mentalState,
    goals:compact.goals.slice(0,3),
    activePlanStep:compact.activePlanStep||null,
    recentActions:compact.recentActions.slice(0,8),
    recentFailures,
    memories:memories.slice(0,6).map(compactMemory),
    location:compact.location,
    resourceContext:compact.resourceContext,
    candidates:compact.candidates.slice(0,5),
    social:{partner:context?.social?.partner||null,candidates:socialCandidates},
    explorationDestination:compact.explorationDestination||null,
    recoveryBlocks:compact.recoveryBlocks.slice(0,4),
    proactivity:compact.proactivity,
    needPriority:compact.needPriority,
    trigger:compact.geminiTrigger,
    preferences,
    beliefs,
    knowledge,
    habits
  };
}

function goalActionSatisfiesNeed(goalNeed,actionType){const mapping={HUNGER:"EATING",THIRST:"DRINKING",SLEEPINESS:"SLEEPING",SOCIAL_NEED:"TALKING",BELONGING:"TALKING",FUN:"PLAYING",CURIOSITY:"EXPLORING",ACHIEVEMENT:"WORKING"};return mapping[String(goalNeed||"").trim().toUpperCase()]===String(actionType||"").trim().toUpperCase();}
async function prepareTickAutonomyContext({simulationId,entityIds=[],simulationTime}){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))],contexts=new Map(),entities=new Map();if(!ids.length)return{entities,contexts};
  const placeholders=ids.map(()=> 'UUID_TO_BIN(?)').join(',');
  const [entityRows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id,e.display_name AS displayName,et.code AS entityType,e.status,e.description,e.attributes,e.version FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND e.id IN (${placeholders})`,[simulationId,...ids]);
  for(const row of entityRows)entities.set(row.id,row);
  const worldLocations=await loadWorldLocations(simulationId);
  const decisionContexts=await decisionService.buildDecisionContexts(simulationId,ids,simulationTime,{worldLocations});
  const socialContexts=await buildSocialContexts(simulationId,ids,{worldLocations,simulationTime});
  const visitedByEntity=await loadVisitedLocationsBatch(simulationId,ids);
  const recentLocationsByEntity=await loadRecentLocationIdsBatch(simulationId,ids);
  const recallBase=new Map();for(const id of ids){const base=decisionContexts.get(id);if(!base)continue;recallBase.set(id,{simulationTime,goalIds:(base.goals||[]).map(goal=>goal.id).filter(Boolean),locationId:base.location?.locationId||null,locationType:base.location?.locationType||null,candidateActionTypes:(base.candidates||[]).map(candidate=>candidate.action).filter(Boolean)});}
  const memoriesByEntity=await require('./memory-service').recallContexts(simulationId,ids,8,recallBase);
  for(const id of ids){
    const base=decisionContexts.get(id);if(!base)continue;
    const entity=entities.get(id);if(!entity)continue;
    base.isAsami=normalize(entity.displayName)==="ASAMI";
    base.candidates=decisionService.applySleepLocationPreference(
      base.candidates,
      {
        worldLocations,
        currentLocationId:base.location?.locationId||null,
        context:{...base,isAsami:base.isAsami}
      }
    );
    const socialContext=socialContexts.get(id)||{partner:null,candidates:[],traits:[]};
    base.social={partner:socialContext.partner,candidates:(socialContext.candidates||[]).map(candidate=>({id:candidate.id,name:candidate.name,relationshipType:candidate.relationshipType,compatibility:Number(Number(candidate.compatibility||0).toFixed(3)),romanticScore:Number(Number(candidate.romanticScore||0).toFixed(3)),familiarity:Number(candidate.relationship?.familiarity||0),closeness:Number(candidate.relationship?.closeness||0),affection:Number(candidate.relationship?.affection||0),trust:Number(candidate.relationship?.trust||0),conflict:Number(candidate.relationship?.conflict||0),irritation:Number(candidate.relationship?.irritation||0)}))};
    const currentLocationId=base.location?.locationId||null,visited=visitedByEntity.get(id)||new Map(),recentLocations=recentLocationsByEntity.get(id)||{};
    base.previousLocationId=recentLocations.previousLocationId||null;
    if(entity.entityType==='PERSON'&&currentLocationId){const target=await chooseSocialTarget(socialContext,simulationId,id,currentLocationId);if(target)base.social.travelTarget={entityId:target.entityId,name:target.name,locationId:target.locationId,remote:Boolean(target.remote),travelMinutes:Number(target.travelMinutes||0)};const destination=await chooseExplorationDestination(simulationId,id,currentLocationId,base.needs,simulationTime,worldLocations,visited,recentLocations.previousLocationId);if(destination)base.explorationDestination=destination;}
    const goal=base.goals?.[0]||null,plan=(base.cognitiveProfile?.plans||[]).find(item=>String(item.goalId||'')===String(goal?.id||''));const activePlanStep=selectActiveStep(plan);if(activePlanStep)base.activePlanStep=activePlanStep;
    contexts.set(id,{...base,memories:memoriesByEntity.get(id)||[]});
  }
  return{entities,contexts,socialContexts,worldLocations,preparedAt:simulationTime};
}
async function findAutonomousActors(simulationId,limit=100){const safeLimit=Math.max(1,Number(limit)||100);const[rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR' AND e.status NOT IN ('INACTIVE','DEAD') AND NOT EXISTS(SELECT 1 FROM autonomy_policies ap WHERE ap.simulation_id=e.simulation_id AND ap.policy_type='AUTONOMY' AND ap.enabled=0 AND(ap.entity_id=e.id OR ap.entity_id IS NULL)) ORDER BY CASE WHEN EXISTS(SELECT 1 FROM actions a WHERE a.simulation_id=e.simulation_id AND a.entity_id=e.id AND a.status='ACTIVE') THEN 0 ELSE 1 END,e.created_simulation_at,e.id LIMIT ?`,[simulationId,safeLimit]);return rows.map(row=>row.id);}
function serializeReason(reason){if(reason===null||reason===undefined)return null;if(typeof reason==='string')return JSON.stringify({text:reason});return JSON.stringify(reason);}
function getGeminiTrigger(entity,context,memories=[]){
  if(!entity||entity.entityType!=="PERSON")return null;

  const candidates=Array.isArray(context.candidates)?context.candidates:[];
  const top=Number(candidates[0]?.score||0);
  const second=Number(candidates[1]?.score||0);

  const interruptions=Array.isArray(context.recentInterruptions)?context.recentInterruptions:[];
  // buildDecisionContexts already selects only action rows with status=INTERRUPTED.
  // Do not require optional fields inside result to recognize the interruption.
  const recentInterruption=interruptions[0]||null;
  if(recentInterruption){
    return{
      type:"FAILURE_REFLECTION",
      reason:"recent action interruption/failure requires reflection",
      priority:"HIGH",
      action:recentInterruption.actionType||null,
      outcome:recentInterruption.result?.outcome||"INTERRUPTED",
      key:"FAILURE_REFLECTION:"+(recentInterruption.id||recentInterruption.at||recentInterruption.actionType||"RECENT")
    };
  }

  const failureMemory=memories.find(memory=>{
    const metadata=parseJson(memory.metadata,null);
    return metadata?.outcome==="FAILURE" ||
      metadata?.outcome==="PARTIAL" ||
      metadata?.kind==="resource_failure" ||
      metadata?.kind==="action_interruption";
  });
  if(failureMemory){
    return{
      type:"FAILURE_REFLECTION",
      reason:"recent failure/interruption memory requires reflection",
      priority:"HIGH",
      memoryId:failureMemory.id||null,
      key:"FAILURE_MEMORY:"+(failureMemory.id||failureMemory.simulationAt||"RECENT")
    };
  }

  const conflictCandidate=(context.social?.candidates||[]).find(candidate =>
    Number(candidate.conflict||0)>=.65 ||
    Number(candidate.irritation||0)>=.65
  );

  const recentSocialTargets=Array.isArray(context.recentSocialTargets)
    ?context.recentSocialTargets
    :[];
  const recentSocialTarget=recentSocialTargets[0]||null;
  const newRelationshipCandidate=(context.social?.candidates||[]).find(candidate =>
    String(candidate.id||"")===String(recentSocialTarget||"") &&
    String(candidate.relationshipType||"").toUpperCase()==="ACQUAINTANCE" &&
    Number(candidate.familiarity||0)<=.18
  );
  if(newRelationshipCandidate){
    return{
      type:"NEW_RELATIONSHIP",
      reason:"a new social bond is forming and merits deliberation",
      priority:"HIGH",
      targetEntityId:newRelationshipCandidate.id||null,
      key:"NEW_RELATIONSHIP:"+(newRelationshipCandidate.id||"UNKNOWN")
    };
  }
  if(conflictCandidate){
    return{
      type:"SOCIAL_CONFLICT",
      reason:"relationship conflict or irritation is high enough to require deliberation",
      priority:"HIGH",
      targetEntityId:conflictCandidate.id||null,
      key:"SOCIAL_CONFLICT:"+
        (conflictCandidate.id||"UNKNOWN")+":"+
        Number(conflictCandidate.conflict||0).toFixed(2)+":"+
        Number(conflictCandidate.irritation||0).toFixed(2)
    };
  }

  if(!candidates.length){
    return{
      type:"NO_CANDIDATE",
      reason:"deterministic engine has no viable candidate",
      priority:"HIGH",
      key:"NO_CANDIDATE"
    };
  }

  if(candidates.length>1&&top-second<.12){
    return{
      type:"AMBIGUITY",
      reason:"decision is ambiguous",
      priority:"HIGH",
      margin:top-second,
      key:"AMBIGUITY:"+
        normalizeAction(candidates[0]?.action)+":"+
        normalizeAction(candidates[1]?.action)+":"+
        Number(top-second).toFixed(3)
    };
  }

  const activeGoal=(context.goals||[]).find(goal =>
    Number(goal.priority||0)>=.8 &&
    Number(goal.progress||0)<1
  );
  if(activeGoal&&context.activePlanStep&&
    (Number(context.activePlanStep.sequence)>1||context.activePlanStep.status==="ACTIVE")){
    return{
      type:"PLAN_DELIBERATION",
      reason:"active multi-step goal benefits from strategic planning",
      priority:"HIGH",
      goalId:activeGoal.id,
      planStepId:context.activePlanStep.id,
      key:"PLAN:"+activeGoal.id+":"+
        (context.activePlanStep.id||context.activePlanStep.sequence||"ACTIVE")
    };
  }

  const mentalState=context.cognitiveProfile?.mentalState||{};
  if(Number(mentalState.rumination||0)>=.65||Number(mentalState.certainty||1)<=.3){
    return{
      type:"UNCERTAINTY",
      reason:"high rumination or low certainty warrants reflection",
      priority:"HIGH",
      key:"UNCERTAINTY:"+
        Number(mentalState.rumination||0).toFixed(2)+":"+
        Number(mentalState.certainty||0).toFixed(2)
    };
  }

  const now=new Date(context.simulationTime||Date.now()).getTime();
  const periodicKey=Number.isFinite(now)
    ?new Date(now).toISOString().slice(0,10)
    :"UNKNOWN_DAY";
  return{
    type:"PERIODIC_DELIBERATION",
    reason:"periodic strategic review of goals, needs, conflicts and alternatives",
    priority:"MEDIUM",
    key:"PERIODIC:"+periodicKey
  };
}

function shouldAskGemini(entity,context,memories=[]){return Boolean(getGeminiTrigger(entity,context,memories));}
function canUseGeminiDecision(entityId,simulationTime,{highValue=false,periodic=false,triggerKey=null}={}){
  if(geminiBudget.providerBlockRemainingMs()>0)return false;
  const now=new Date(simulationTime).getTime();
  if(!Number.isFinite(now))return false;

  if(triggerKey&&lastGeminiTriggerKeyByEntity.get(entityId)===triggerKey)return false;

  const configured=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES);
  const normalInterval=Math.max(60,Number.isFinite(configured)?configured:1440);
  const highValueInterval=Math.max(
    30,
    Number.isFinite(Number(env.GEMINI_AUTONOMY_HIGH_VALUE_MIN_INTERVAL_MINUTES))
      ?Number(env.GEMINI_AUTONOMY_HIGH_VALUE_MIN_INTERVAL_MINUTES)
      :120
  );

  const clock=highValue
    ?lastHighValueGeminiDecisionAt.get(entityId)
    :lastPeriodicGeminiDecisionAt.get(entityId);
  const intervalMinutes=highValue?highValueInterval:normalInterval;
  if(clock===undefined)return true;
  return now-clock>=intervalMinutes*60000;
}
function markGeminiDecisionUsed(entityId,simulationTime,{highValue=false,triggerKey=null}={}){
  const now=new Date(simulationTime).getTime();
  if(!Number.isFinite(now))return;
  lastAutonomyDecisionAt.set(entityId,now);
  if(highValue)lastHighValueGeminiDecisionAt.set(entityId,now);
  else lastPeriodicGeminiDecisionAt.set(entityId,now);
  if(triggerKey)lastGeminiTriggerKeyByEntity.set(entityId,triggerKey);
}
async function loadWorldLocations(simulationId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData,e.attributes FROM locations l JOIN entities e ON e.id=l.entity_id WHERE l.simulation_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId,simulationId]);return rows.map(row=>{const attributes=parseJson(row.attributes,{});return{locationId:row.locationId,locationType:row.locationType,latitude:Number(row.latitude),longitude:Number(row.longitude),data:parseJson(row.addressData,{}),resources:attributes.resources&&typeof attributes.resources==='object'?attributes.resources:{}};});}
async function loadVisitedLocations(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId,MAX(entered_simulation_at) AS lastVisitedAt FROM entity_location_history WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) GROUP BY location_id`,[simulationId,entityId]);return new Map(rows.map(row=>[row.locationId,row.lastVisitedAt]));}
function locationInterestScore(location,needs){const weights=EXPLORATION_LOCATION_INTEREST[location.locationType]||{};return Object.entries(weights).reduce((sum,[needCode,weight])=>sum+clamp(needs.find(item=>item.code===needCode)?.value||0)*weight,0);}
function explorationNoveltyScore(lastVisitedAt,simulationTime){
  if(!lastVisitedAt)return 1;
  const elapsed=(new Date(simulationTime).getTime()-new Date(lastVisitedAt).getTime())/3600000;
  if(!Number.isFinite(elapsed))return .15;
  if(elapsed<=.5)return 0;
  if(elapsed<2)return .02;
  if(elapsed<6)return .08;
  if(elapsed<12)return .25;
  if(elapsed<24)return .50;
  if(elapsed<48)return .75;
  if(elapsed<72)return .88;
  return .98;
}
function routeTravelMinutes(route){if(!route||!Number.isFinite(Number(route.distanceMeters)))return Infinity;return Number(route.distanceMeters)/1000/4.8*60;}
async function loadVisitedLocationsBatch(simulationId,entityIds=[]){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))],result=new Map();if(!ids.length)return result;
  const placeholders=ids.map(()=> 'UUID_TO_BIN(?)').join(',');
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(entity_id) AS entityId,BIN_TO_UUID(location_id) AS locationId,MAX(entered_simulation_at) AS lastVisitedAt FROM entity_location_history WHERE entity_id IN (${placeholders}) GROUP BY entity_id,location_id`,ids);
  for(const row of rows){if(!result.has(row.entityId))result.set(row.entityId,new Map());result.get(row.entityId).set(row.locationId,row.lastVisitedAt);}
  return result;
}
async function loadRecentLocationIdsBatch(simulationId,entityIds=[]){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))],result=new Map();if(!ids.length)return result;
  const placeholders=ids.map(()=> 'UUID_TO_BIN(?)').join(',');
  const [rows]=await pool.query(`SELECT entityId,locationId,rn FROM (SELECT BIN_TO_UUID(entity_id) AS entityId,BIN_TO_UUID(location_id) AS locationId,ROW_NUMBER() OVER(PARTITION BY entity_id ORDER BY entered_simulation_at DESC) AS rn FROM entity_location_history WHERE simulation_id=UUID_TO_BIN(?) AND entity_id IN (${placeholders})) ranked WHERE rn<=2 ORDER BY entityId,rn`,[simulationId,...ids]);
  for(const id of ids)result.set(id,{lastLocationId:null,previousLocationId:null});
  for(const row of rows){const entry=result.get(row.entityId);if(!entry)continue;if(Number(row.rn)===1)entry.lastLocationId=row.locationId;if(Number(row.rn)===2)entry.previousLocationId=row.locationId;}
  return result;
}

async function chooseExplorationDestination(simulationId,entityId,originId,needs,simulationTime,providedLocations=null,providedVisited=null,previousLocationId=null){
  if(!originId)return null;
  const locations=providedLocations||await loadWorldLocations(simulationId),visited=providedVisited||await loadVisitedLocations(simulationId,entityId),origin=locations.find(location=>location.locationId===originId);
  if(!origin)return null;
  const candidates=[];
  for(const location of locations){
    if(location.locationId===originId)continue;
    const route=graphRoute(locations,originId,location.locationId);if(!route)continue;
    const travelMinutes=routeTravelMinutes(route);if(!Number.isFinite(travelMinutes))continue;
    const lastVisitedAt=visited.get(location.locationId),novelty=explorationNoveltyScore(lastVisitedAt,simulationTime),interest=locationInterestScore(location,needs),elapsedSinceVisit=lastVisitedAt?(new Date(simulationTime).getTime()-new Date(lastVisitedAt).getTime())/3600000:Infinity;
    const immediateReturn=String(location.locationId)===String(previousLocationId||'');
    const recentVisitPenalty=immediateReturn?.95:elapsedSinceVisit<=1?.80:elapsedSinceVisit<3?.55:elapsedSinceVisit<8?.30:elapsedSinceVisit<16?.12:0;
    let resourceOpportunity=0;for(const[resource,needCode]of Object.entries(RESOURCE_NEED_CODES)){const amount=Number(location.resources?.[resource]||0),pressure=Number(needs.find(item=>item.code===needCode)?.value||0);if(amount>=1)resourceOpportunity+=Math.min(.35,pressure*.35);}
    const distancePenalty=Math.min(.60,travelMinutes/60*.60),score=novelty*1.55+interest*1.15+resourceOpportunity-distancePenalty-recentVisitPenalty+Math.random()*.05;
    candidates.push({locationId:location.locationId,locationType:location.locationType,travelMinutes,distanceMeters:route.distanceMeters,score,novelty,interest,resourceOpportunity});
  }
  candidates.sort((a,b)=>b.score-a.score);return candidates[0]||null;
}
async function getEntityLocation(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);return rows[0]?.locationId||null;}
function socialTargetIsValid(candidate){
  return Boolean(candidate && candidate.id && candidate.sociallyValid !== false);
}
function chooseSocialTarget(socialContext,simulationId,entityId,originId){
  const candidates=(Array.isArray(socialContext?.candidates)?socialContext.candidates:[]).filter(socialTargetIsValid);
  if(candidates.length){
    const ranked=candidates.slice().sort((a,b)=>{
      const aPartner=socialContext.partner?.partnerId===a.id?1:0,bPartner=socialContext.partner?.partnerId===b.id?1:0;
      const aScore=Number(a.score||0)+aPartner*.35+Number(a.romanticScore||0)*.35,bScore=Number(b.score||0)+bPartner*.35+Number(b.romanticScore||0)*.35;
      return bScore-aScore;
    });
    const target=ranked[0];
    return{entityId:target.id,name:target.name,locationId:originId,remote:false,score:Number(target.score||0)};
  }
  const remoteCandidates=(Array.isArray(socialContext?.remoteCandidates)?socialContext.remoteCandidates:[]).filter(socialTargetIsValid);
  if(remoteCandidates.length){
    const target=remoteCandidates[0];
    return{entityId:target.id,name:target.name,locationId:target.locationId,remote:true,score:Number(target.score||0),travelMinutes:Number(target.travelMinutes||0),distanceMeters:Number(target.distanceMeters||0)};
  }
  return null;
}
function sanitizeGeminiChoice(aiChoice,context,{socialContext,currentLocationId,worldLocations=[]}={}){if(!aiChoice)return null;const allowed=new Set((context.allowedActionTypes||[]).map(value=>String(value).toUpperCase())),selectedAction=String(aiChoice.selectedActionType||"").toUpperCase();if(!allowed.has(selectedAction))return null;const knownEntityIds=new Set([...(socialContext?.candidates||[]),...(context?.social?.candidates||[])].map(candidate=>candidate.id).filter(Boolean));const targetEntityId=aiChoice.targetEntityId&&knownEntityIds.has(aiChoice.targetEntityId)?aiChoice.targetEntityId:null;let targetLocationId=null;if(aiChoice.targetLocationId){const location=worldLocations.find(item=>item.locationId===aiChoice.targetLocationId);const route=currentLocationId&&location?actionService.shortestRoute(worldLocations,currentLocationId,aiChoice.targetLocationId):null;if(location&&route)targetLocationId=aiChoice.targetLocationId;}const strategy=aiChoice.strategy&&typeof aiChoice.strategy==='object'?aiChoice.strategy:null,proposal=aiChoice.planProposal&&typeof aiChoice.planProposal==='object'?{...aiChoice.planProposal,steps:(aiChoice.planProposal.steps||[]).filter(step=>!step.actionType||allowed.has(String(step.actionType).toUpperCase())).map(step=>({...step,actionType:step.actionType?String(step.actionType).toUpperCase():undefined})).slice(0,8)}:null;return{...aiChoice,selectedActionType:selectedAction,targetEntityId,targetLocationId,strategy,planProposal:proposal};}
async function markDecisionPipelineFailed({simulationId,entityId,decisionId,intentionId=null,simulationTime,phase,error}={}){
  if(!decisionId)return false;

  const failure={
    actionType:null,
    failureReason:"DECISION_PIPELINE_INCOMPLETE",
    phase:phase||"UNKNOWN",
    errorCode:String(error?.code||"UNKNOWN"),
    error:String(error?.message||"Decision pipeline failed"),
    simulationTime
  };

  if(intentionId){
    await pool.query(
      `UPDATE intentions
       SET status='CANCELLED',version=version+1
       WHERE id=UUID_TO_BIN(?)
         AND simulation_id=UUID_TO_BIN(?)
         AND entity_id=UUID_TO_BIN(?)
         AND decision_id=UUID_TO_BIN(?)
         AND status='ACTIVE'`,
      [intentionId,simulationId,entityId,decisionId]
    );
  }

  const [updated]=await pool.query(
    `UPDATE decisions
     SET status='FAILED',
         actual_outcome=?
     WHERE id=UUID_TO_BIN(?)
       AND simulation_id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND status IN ('CREATED','EVALUATED')`,
    [
      JSON.stringify(failure),
      decisionId,
      simulationId,
      entityId
    ]
  );

  if(updated.affectedRows){
    logger.warn({
      simulationId,
      entityId,
      decisionId,
      intentionId,
      simulationTime,
      phase:phase||"UNKNOWN",
      errorCode:String(error?.code||"UNKNOWN")
    },"autonomy decision failed because the intention/action pipeline was incomplete");
  }

  try {
    await finalizeDecisionCognitiveArtifacts({
      simulationId,
      decisionId,
      entityId,
      simulationTime,
      outcome:"FAILURE",
      actionType:null
    });
  } catch (cognitiveFinalizeError) {
    logger.warnThrottled(
      `decision:cognitive-pipeline-failure:${decisionId}`,
      60000,
      {
        simulationId,
        decisionId,
        entityId,
        simulationTime,
        error:String(cognitiveFinalizeError?.message||cognitiveFinalizeError)
      },
      "decision cognitive finalization deferred to reconciliation"
    );
  }

  return Boolean(updated.affectedRows);
}

async function actForEntity({simulationId,entityId,simulationTime,gemini,tickId=null,batchContext=null,needsOverride=null}){const entity=batchContext?.entities?.get(entityId)||await getEntity(simulationId,entityId);if(!entity)return null;let context=batchContext?.contexts?.get(entityId)||await decisionService.buildDecisionContext(simulationId,entityId,simulationTime);context={...context,simulationTime,isAsami:normalize(entity.displayName)==="ASAMI"};
  if(batchContext?.contexts?.has(entityId)){
    const latestNeeds=Array.isArray(needsOverride)&&needsOverride.length?needsOverride:context.needs;
    if(Array.isArray(latestNeeds)&&latestNeeds.length){
      const recoveryBlocks=decisionService.activeRecoveryBlocks(context.recentInterruptions||[],latestNeeds);
      context={...context,needs:latestNeeds,recoveryBlocks,candidates:decisionService.rebuildDecisionCandidates({...context,recoveryBlocks},entityId,latestNeeds),needPriority:decisionService.needPriorityState?decisionService.needPriorityState(latestNeeds):context.needPriority};
    }
  }
  const knownGoal=context.goals?.find(goal=>String(goal?.goalType||"").toUpperCase()==="NEED")||context.goals?.[0]||null;
  const knownPlan=(context.cognitiveProfile?.plans||[]).find(item=>String(item.goalId||"")===String(knownGoal?.id||""))||null;
  let goalState=goalNeedsValidation(knownGoal,knownPlan,context.needs,simulationTime)
    ?await ensureGoalPlan({simulationId,entityId,simulationTime,needs:context.needs})
    :{goal:knownGoal,plan:knownPlan,created:false,blocked:false};
  if(goalState.created&&goalState.goal){
    const goals=[goalState.goal,...(context.goals||[]).filter(goal=>String(goal.id)!==String(goalState.goal.id))];
    const plans=goalState.plan
      ?[goalState.plan,...(context.cognitiveProfile?.plans||[]).filter(plan=>String(plan.id)!==String(goalState.plan.id))]
      :(context.cognitiveProfile?.plans||[]);
    context={
      ...context,
      goals,
      cognitiveProfile:{...context.cognitiveProfile,plans},
      simulationTime
    };
  }else{
    context.simulationTime=simulationTime;
  }
  const currentLocationId=context.location?.locationId||await getEntityLocation(simulationId,entityId);
  let socialContext=batchContext?.socialContexts?.get(entityId)||null;
  if(!socialContext&&entity.entityType==="PERSON"){
    const fallbackWorldLocations=await loadWorldLocations(simulationId);
    const fallbackRemote=await buildRemoteSocialContexts(simulationId,[entityId],{worldLocations:fallbackWorldLocations,simulationTime});
    socialContext=fallbackRemote.get(entityId)||null;
  }
  socialContext=socialContext||{partner:null,candidates:[],remoteCandidates:[],traits:[]};
  const validLocalCandidates=(socialContext.candidates||[]).filter(socialTargetIsValid);
  const validRemoteCandidates=(socialContext.remoteCandidates||[]).filter(socialTargetIsValid);
  context.social={partner:socialContext.partner,candidates:validLocalCandidates.map(candidate=>({id:candidate.id,name:candidate.name,relationshipType:candidate.relationshipType,compatibility:Number(candidate.compatibility.toFixed(3)),romanticScore:Number(candidate.romanticScore.toFixed(3)),familiarity:Number(candidate.relationship?.familiarity||0),closeness:Number(candidate.relationship?.closeness||0),affection:Number(candidate.relationship?.affection||0),trust:Number(candidate.relationship?.trust||0),sociallyValid:true}))};
  const socialPressure=Math.max(
    Number(context.needs.find(n=>String(n.code||"").toUpperCase()==="SOCIAL_NEED")?.value||0),
    Number(context.needs.find(n=>String(n.code||"").toUpperCase()==="BELONGING")?.value||0)
  );
  if(!validLocalCandidates.length&&!validRemoteCandidates.length&&socialPressure>=.55){
    observability.increment(simulationId,"social_starvation_total");
  }
  const worldLocationsCache=batchContext?.worldLocations||((entity.entityType==="PERSON"&&currentLocationId)?await loadWorldLocations(simulationId):null);
  let socialTarget=null;if(entity.entityType==="PERSON"&&currentLocationId){socialTarget=chooseSocialTarget({ ...socialContext, candidates:validLocalCandidates, remoteCandidates:validRemoteCandidates },simulationId,entityId,currentLocationId);if(socialTarget)context.social.travelTarget={entityId:socialTarget.entityId,name:socialTarget.name,locationId:socialTarget.locationId,remote:Boolean(socialTarget.remote),travelMinutes:Number(socialTarget.travelMinutes||0)};}
  const explorationDestination=entity.entityType==="PERSON"&&currentLocationId?(batchContext?.contexts?.has(entityId)?context.explorationDestination:await chooseExplorationDestination(simulationId,entityId,currentLocationId,context.needs,simulationTime,worldLocationsCache)):null;if(explorationDestination)context.explorationDestination=explorationDestination;const plan=goalState.goal?goalState.plan||(await ensureGoalPlan({simulationId,entityId,simulationTime,needs:context.needs})).plan:null;
  let activePlanStep=selectActiveStep(plan);
  if(activePlanStep)context.activePlanStep=activePlanStep;

  const stagnationRecovery=goalState.goal&&goalState.plan
    ?await handleGoalStagnation({
      simulationId,
      entityId,
      simulationTime,
      goalState,
      currentLocationId
    })
    :null;

  if(stagnationRecovery?.replanned||stagnationRecovery?.abandoned){
    goalState=await ensureGoalPlan({simulationId,entityId,simulationTime,needs:context.needs});
    const refreshedGoals=goalState.goal
      ?[goalState.goal,...(context.goals||[]).filter(goal=>String(goal.id)!==String(goalState.goal.id))]
      :(context.goals||[]);
    const refreshedPlans=goalState.plan
      ?[goalState.plan,...(context.cognitiveProfile?.plans||[]).filter(planItem=>String(planItem.id)!==String(goalState.plan.id))]
      :(context.cognitiveProfile?.plans||[]);
    activePlanStep=selectActiveStep(goalState.plan);
    context={
      ...context,
      goals:refreshedGoals,
      cognitiveProfile:{...context.cognitiveProfile,plans:refreshedPlans},
      activePlanStep:activePlanStep||null,
      simulationTime
    };
  }

  const memories=batchContext?.contexts?.has(entityId)?(context.memories||[]):await recallContext(simulationId,entityId,8,{simulationTime,goalIds:(context.goals||[]).map(goal=>goal.id).filter(Boolean),locationId:context.location?.locationId||null,locationType:context.location?.locationType||null,candidateActionTypes:(context.candidates||[]).map(candidate=>candidate.action).filter(Boolean)});
  const localBudgetBlocked=geminiBudget.isLocallyBlocked("AUTONOMY");
  const geminiTrigger=getGeminiTrigger(entity,context,memories);

  if(geminiTrigger&&geminiTrigger.key===lastGeminiTriggerKeyByEntity.get(entity.id)){
    context.geminiTrigger=null;
  }else{
    context.geminiTrigger=geminiTrigger;
  }

  let aiChoice=null;
  let geminiDecision={
    status:"NOT_CONSULTED",
    source:"DETERMINISTIC",
    reason:localBudgetBlocked?"LOCAL_BUDGET_COOLDOWN":"NO_GEMINI_TRIGGER",
    attempted:false,
    retryAfterMs:0
  };

  const effectiveGeminiTrigger=context.geminiTrigger;
  if(effectiveGeminiTrigger){
    if(!gemini?.client){
      geminiDecision={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"GEMINI_UNAVAILABLE",attempted:false,retryAfterMs:0};
    }else if(!canUseGeminiDecision(
      entity.id,
      simulationTime,
      {
        highValue:effectiveGeminiTrigger.priority==="HIGH",
        periodic:effectiveGeminiTrigger.type==="PERIODIC_DELIBERATION",
        triggerKey:effectiveGeminiTrigger.key||null
      }
    )){
      geminiDecision={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"LOCAL_INTERVAL",attempted:false,retryAfterMs:0};
    }else{
      const worldLocations=worldLocationsCache||await loadWorldLocations(simulationId);
      const geminiContext=buildGeminiDecisionContext({entity,context,memories});
      const generated=await gemini.chooseDecision(geminiContext,{simulationId,entityId,simulationTime});
      const requestStatus=gemini.lastRequestStatus&&typeof gemini.lastRequestStatus==="object"
        ?{...gemini.lastRequestStatus}
        :{status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"UNKNOWN",attempted:true,retryAfterMs:0};

      if(requestStatus.attempted){
        markGeminiDecisionUsed(entity.id,simulationTime,{highValue:effectiveGeminiTrigger.priority==="HIGH",triggerKey:aiChoice?effectiveGeminiTrigger.key||null:null});
      }

      aiChoice=sanitizeGeminiChoice(generated,context,{socialContext,currentLocationId,worldLocations});
      geminiDecision=aiChoice
        ?{...requestStatus,status:"SUCCESS",source:"GEMINI",reason:"GEMINI_DECISION_ACCEPTED"}
        :{...requestStatus,status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:generated?"INVALID_GEMINI_OUTPUT":requestStatus.reason||"GEMINI_FALLBACK"};

      if(aiChoice?.planProposal&&goalState.goal)aiChoice.planProposal.goalId=goalState.goal.id;
    }
  }
context.geminiDecision=geminiDecision;
const decision=await decisionService.makeDecision({simulationId,entityId,simulationTime,triggerType:geminiTrigger?.type||null,triggerEventId:null,context,aiChoice});
  try{
    const reason=String(geminiDecision.reason||"");
    const telemetryOutcome=aiChoice
      ?"AI_DECISION"
      :(!effectiveGeminiTrigger||reason==="NO_GEMINI_TRIGGER"||reason==="LOCAL_INTERVAL"||reason==="LOCAL_BUDGET_COOLDOWN"
        ?"DETERMINISTIC_DECISION"
        :(!geminiDecision.attempted||["GEMINI_DISABLED","ALL_GEMINI_MODELS_BLOCKED","DAILY_BUDGET","MONTHLY_BUDGET"].includes(reason)
          ?"AI_UNAVAILABLE"
          :"AI_FALLBACK"));
    await geminiBudget.recordDecisionOutcome({
      simulationId,
      entityId,
      decisionId:decision.decisionId,
      kind:"AUTONOMY",
      outcome:telemetryOutcome,
      reason,
      model:geminiDecision.model||null,
      simulationTime
    });
  }catch(telemetryError){
    logger.warn({
      simulationId,
      entityId,
      decisionId:decision.decisionId,
      error:String(telemetryError?.message||telemetryError)
    },"Gemini decision telemetry write failed");
  }
  const sourceType=aiChoice?"AI_ASSISTED":"AUTONOMOUS";
  let intentionId=null;
  let started=null;
  try{
    intentionId=await ensureIntention({
      simulationId,entityId,simulationTime,decision,sourceType,goalState,aiChoice,geminiDecision
    });
    started=await require("./action-service").startAction({
      simulationId,
      entityId,
      decisionId:decision.decisionId,
      intentionId,
      goalId:goalState.goal?.id||null,
      planId:goalState.plan?.id||null,
      planStepId:activePlanStep?.id||null,
      actionType:decision.actionType,
      simulationTime,
      targetEntityId:decision.targetEntityId,
      targetLocationId:decision.targetLocationId,
      movementAvoidLocationId:context.previousLocationId||null,
      relationshipIntent:deriveSocialIntent({
        actionType:decision.actionType,
        targetId:decision.targetEntityId,
        partner:socialContext.partner,
        candidates:socialContext.candidates
      }),
      tickId
    });
  }catch(err){
    try{
      await markDecisionPipelineFailed({
        simulationId,
        entityId,
        decisionId:decision.decisionId,
        intentionId,
        simulationTime,
        phase:intentionId?"ACTION_START":"INTENTION_CREATE",
        error:err
      });
    }catch(compensationError){
      logger.error({
        simulationId,
        entityId,
        decisionId:decision.decisionId,
        intentionId,
        simulationTime,
        event:"DECISION_PIPELINE_COMPENSATION_FAILED",
        errorCode:String(compensationError?.code||"UNKNOWN"),
        error:String(compensationError?.message||compensationError)
      },"failed to compensate an incomplete decision pipeline");
    }
    throw err;
  }
  if(goalState.goal){
    const stagnation=observability.recordGoalProgress(simulationId,entityId,simulationTime,{
      goalId:goalState.goal.id,
      progress:Number(goalState.goal.progress||0),
      status:goalState.goal.status,
      actionType:decision.actionType
    });
    if(stagnation){
      observability.increment(simulationId,"goal_stagnation_alerts_total");
      logger.warnThrottled(
        `autonomy:goal-stagnation:${simulationId}`,
        3600000,
        {...stagnation,event:"GOAL_STAGNATION"},
        "goal shows behavioral stagnation"
      );
    }
  }
  return{decision,started,intentionId,goalState,aiChoice};
}
async function ensureIntention({simulationId,entityId,simulationTime,decision,sourceType,goalState,aiChoice,geminiDecision}){const intentionId=require("../lib/ids").uuid(),decisionSource=decision?.decisionSource||sourceType||"DETERMINISTIC",reason=serializeReason({source:decisionSource,status:geminiDecision?.status||"NOT_CONSULTED",geminiReason:geminiDecision?.reason||null,decision:aiChoice?.strategy||decision.reason||"autonomous decision"}),goalId=goalState.goal?.id||null,planId=goalState.plan?.id||null,mysqlTime=mysqlSimulationDateTime(simulationTime);await pool.query(`INSERT INTO intentions(id,simulation_id,entity_id,goal_id,plan_id,decision_id,action_type,target_entity_id,target_location_id,scheduled_simulation_at,priority,status,reason,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,'ACTIVE',?,?,1)`,[intentionId,simulationId,entityId,goalId,planId,decision.decisionId,decision.actionType,decision.targetEntityId,decision.targetLocationId,goalState.goal?.priority||.5,reason,mysqlTime]);return intentionId;}
async function completeGoalForAction(goalId,actionType,simulationTime,outcome,actionResult={}) {
  let resolvedGoalId=goalId||null;
  let simulationId=actionResult?.simulationId||null;
  let entityId=actionResult?.entityId||null;
  const actionId=actionResult?.actionId||null;

  // The action is the source of truth for goal linkage. Older actions may not
  // have goalId in JSON metadata even though actions.source_goal_id is set.
  if (actionId && (!resolvedGoalId || !simulationId || !entityId)) {
    const [rows]=await pool.query(
      `SELECT BIN_TO_UUID(source_goal_id) AS goalId,
              BIN_TO_UUID(simulation_id) AS simulationId,
              BIN_TO_UUID(entity_id) AS entityId
       FROM actions
       WHERE id=UUID_TO_BIN(?)
       LIMIT 1`,
      [actionId]
    );
    resolvedGoalId=resolvedGoalId||rows[0]?.goalId||null;
    simulationId=simulationId||rows[0]?.simulationId||null;
    entityId=entityId||rows[0]?.entityId||null;
  }

  if (!resolvedGoalId) return null;

  if (!simulationId || !entityId) {
    const [rows]=await pool.query(
      `SELECT BIN_TO_UUID(simulation_id) AS simulationId,BIN_TO_UUID(entity_id) AS entityId FROM goals WHERE id=UUID_TO_BIN(?) LIMIT 1`,
      [resolvedGoalId]
    );
    simulationId=simulationId||rows[0]?.simulationId||null;
    entityId=entityId||rows[0]?.entityId||null;
  }

  if (!simulationId || !entityId) return null;

  try{
    observability.recordGoalActionOutcome(simulationId,entityId,simulationTime,{
      goalId:resolvedGoalId,
      actionId,
      actionType,
      outcome,
      durationMinutes:Number(actionResult?.durationMinutes||0)
    });
  }catch(observabilityError){
    logger.warn({
      simulationId,
      entityId,
      goalId:resolvedGoalId,
      actionId,
      error:String(observabilityError?.message||observabilityError)
    },"goal action observability update failed");
  }

  const primary=await advancePlanForAction({
    simulationId,
    entityId,
    goalId:resolvedGoalId,
    actionType,
    outcome,
    simulationTime,
    actionResult
  });

  const persistent=await advancePersistentGoalFromAnyAutonomousAction({
    simulationId,
    entityId,
    actionType,
    outcome,
    simulationTime,
    actionResult,
    excludeGoalId:resolvedGoalId
  });

  return{
    ...(primary||{}),
    persistentProgress:persistent||null
  };
}
module.exports={findAutonomousActors,prepareTickAutonomyContext,shouldAskGemini,getGeminiTrigger,actForEntity,completeGoalForAction,canUseGeminiDecision,markGeminiDecisionUsed,sanitizeGeminiChoice,chooseExplorationDestination,explorationNoveltyScore,goalActionSatisfiesNeed,buildGeminiDecisionContext};
