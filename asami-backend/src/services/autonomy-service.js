const { pool } = require("../db/pool");
const { env } = require("../config/env");
const decisionService = require("./decision-service");
const { getEntity } = require("../repositories/entity-repo");
const { recallContext } = require("./memory-service");
const { buildSocialContext, deriveSocialIntent } = require("./social-relationship-service");
const actionService = require("./action-service");
const { ensureGoalPlan, advancePlanForAction, selectActiveStep } = require("./planning-service");

const lastAutonomyDecisionAt=new Map();
const EXPLORATION_LOCATION_INTEREST={HOME:{},PARK:{FUN:.45,SOCIAL_NEED:.25,CURIOSITY:.30},CAFE:{SOCIAL_NEED:.55,BELONGING:.30,FUN:.20,CURIOSITY:.15},SHOP:{HUNGER:.25,THIRST:.25,CURIOSITY:.10},LIBRARY:{CURIOSITY:.70,ACHIEVEMENT:.55},SCHOOL:{ACHIEVEMENT:.60,CURIOSITY:.40},COMMUNITY:{SOCIAL_NEED:.50,BELONGING:.55,FUN:.25},GYM:{FUN:.45,ACHIEVEMENT:.20},CLINIC:{SAFETY:.60,COMFORT:.20},NATURE:{CURIOSITY:.80,FUN:.35},WORKSHOP:{ACHIEVEMENT:.55,CURIOSITY:.45}};
const RESOURCE_NEED_CODES={water:"THIRST",food:"HUNGER"};
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
async function findAutonomousActors(simulationId,limit=100){const[rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS id FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.category='ACTOR' AND e.status NOT IN ('INACTIVE','DEAD') AND NOT EXISTS(SELECT 1 FROM autonomy_policies ap WHERE ap.simulation_id=e.simulation_id AND ap.policy_type='AUTONOMY' AND ap.enabled=0 AND(ap.entity_id=e.id OR ap.entity_id IS NULL)) ORDER BY e.created_simulation_at LIMIT ?`,[simulationId,limit]);return rows.map(row=>row.id);}
function serializeReason(reason){if(reason===null||reason===undefined)return null;if(typeof reason==='string')return JSON.stringify({text:reason});return JSON.stringify(reason);}
function getGeminiTrigger(entity,context,memories=[]){if(!entity||entity.entityType!=="PERSON")return null;const candidates=context.candidates||[],top=Number(candidates[0]?.score||0),second=Number(candidates[1]?.score||0),recentOutcomes=context.recentOutcomes||[],recentFailure=recentOutcomes.slice(0,4).find(item=>["FAILURE","PARTIAL"].includes(String(item.outcome||"").toUpperCase()));if(recentFailure)return{type:"FAILURE_REFLECTION",reason:"recent action failure or partial outcome",priority:"HIGH",action:recentFailure.actionType,outcome:recentFailure.outcome};const failureMemory=memories.find(memory=>{const metadata=parseJson(memory.metadata,null);return metadata?.outcome==="FAILURE"||metadata?.kind==="resource_failure"||metadata?.kind==="action_interruption";});if(failureMemory)return{type:"FAILURE_REFLECTION",reason:"recent failure/interruption memory requires reflection",priority:"HIGH",memoryId:failureMemory.id||null};if(!candidates.length)return{type:"NO_CANDIDATE",reason:"deterministic engine has no viable candidate",priority:"HIGH"};if(top-second<.12)return{type:"AMBIGUITY",reason:"decision is ambiguous",priority:"HIGH",margin:top-second};const activeGoal=(context.goals||[]).find(goal=>Number(goal.priority||0)>=.8&&Number(goal.progress||0)<1);if(activeGoal&&context.activePlanStep&&(Number(context.activePlanStep.sequence)>1||context.activePlanStep.status==="ACTIVE"))return{type:"PLAN_DELIBERATION",reason:"active multi-step goal benefits from strategic planning",priority:"HIGH",goalId:activeGoal.id,planStepId:context.activePlanStep.id};const mentalState=context.cognitiveProfile?.mentalState||{};if(Number(mentalState.rumination||0)>=.65||Number(mentalState.certainty||1)<=.3)return{type:"UNCERTAINTY",reason:"high rumination or low certainty warrants reflection",priority:"HIGH"};const now=new Date(context.simulationTime||Date.now()).getTime(),previous=lastAutonomyDecisionAt.get(entity.id),configured=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES),periodicInterval=Math.max(60,Number.isFinite(configured)?configured:60);if(previous===undefined||Number.isFinite(now)&&now-previous>=periodicInterval*60000)return{type:"PERIODIC_DELIBERATION",reason:"periodic strategic review of goals, needs, conflicts and alternatives",priority:"MEDIUM"};return null;}
function shouldAskGemini(entity,context,memories=[]){return Boolean(getGeminiTrigger(entity,context,memories));}
function canUseGeminiDecision(entityId,simulationTime,{highValue=false,periodic=false}={}){const now=new Date(simulationTime).getTime();if(!Number.isFinite(now))return false;const previous=lastAutonomyDecisionAt.get(entityId);if(previous===undefined)return true;const configured=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES),normalInterval=Math.max(60,Number.isFinite(configured)?configured:60),intervalMinutes=highValue?Math.min(30,normalInterval):periodic?Math.min(60,normalInterval):normalInterval;return now-previous>=intervalMinutes*60000;}
function markGeminiDecisionUsed(entityId,simulationTime){const now=new Date(simulationTime).getTime();if(Number.isFinite(now))lastAutonomyDecisionAt.set(entityId,now);}
async function loadWorldLocations(simulationId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData,e.attributes FROM locations l JOIN entities e ON e.id=l.entity_id WHERE l.simulation_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId,simulationId]);return rows.map(row=>{const attributes=parseJson(row.attributes,{});return{locationId:row.locationId,locationType:row.locationType,latitude:Number(row.latitude),longitude:Number(row.longitude),data:parseJson(row.addressData,{}),resources:attributes.resources&&typeof attributes.resources==='object'?attributes.resources:{}};});}
async function loadVisitedLocations(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId,MAX(entered_simulation_at) AS lastVisitedAt FROM entity_location_history WHERE entity_id=UUID_TO_BIN(?) GROUP BY location_id`,[entityId]);return new Map(rows.map(row=>[row.locationId,row.lastVisitedAt]));}
function locationInterestScore(location,needs){const weights=EXPLORATION_LOCATION_INTEREST[location.locationType]||{};return Object.entries(weights).reduce((sum,[needCode,weight])=>sum+clamp(needs.find(item=>item.code===needCode)?.value||0)*weight,0);}
function explorationNoveltyScore(lastVisitedAt,simulationTime){if(!lastVisitedAt)return 1;const elapsed=(new Date(simulationTime).getTime()-new Date(lastVisitedAt).getTime())/3600000;if(!Number.isFinite(elapsed))return .5;if(elapsed>=72)return .95;if(elapsed>=24)return .75;if(elapsed>=8)return .5;if(elapsed>=2)return .3;return .1;}
function routeTravelMinutes(route){if(!route||!Number.isFinite(Number(route.distanceMeters)))return Infinity;return Number(route.distanceMeters)/1000/4.8*60;}
async function chooseExplorationDestination(simulationId,entityId,originId,needs,simulationTime){if(!originId)return null;const[locations,visited]=await Promise.all([loadWorldLocations(simulationId),loadVisitedLocations(simulationId,entityId)]),origin=locations.find(location=>location.locationId===originId);if(!origin)return null;const candidates=[];for(const location of locations){if(location.locationId===originId)continue;const route=graphRoute(locations,originId,location.locationId);if(!route)continue;const travelMinutes=routeTravelMinutes(route);if(!Number.isFinite(travelMinutes))continue;const novelty=explorationNoveltyScore(visited.get(location.locationId),simulationTime),interest=locationInterestScore(location,needs);let resourceOpportunity=0;for(const[resource,needCode]of Object.entries(RESOURCE_NEED_CODES)){const amount=Number(location.resources?.[resource]||0),pressure=Number(needs.find(item=>item.code===needCode)?.value||0);if(amount>=1)resourceOpportunity+=Math.min(.35,pressure*.35);}const distancePenalty=Math.min(.60,travelMinutes/60*.60),score=novelty*1.35+interest*1.15+resourceOpportunity-distancePenalty+Math.random()*.05;candidates.push({locationId:location.locationId,locationType:location.locationType,travelMinutes,distanceMeters:route.distanceMeters,score,novelty,interest,resourceOpportunity});}candidates.sort((a,b)=>b.score-a.score);return candidates[0]||null;}
async function getEntityLocation(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);return rows[0]?.locationId||null;}
async function chooseRemoteSocialTarget(simulationId,entityId,originId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(other.id) AS id,other.display_name AS name,BIN_TO_UUID(targetLoc.location_id) AS locationId,BIN_TO_UUID(r.id) AS relationshipId,COALESCE(r.familiarity_score,0) AS familiarity,COALESCE(r.closeness_score,0) AS closeness,COALESCE(r.affection_score,0) AS affection,COALESCE(r.trust_score,0) AS trust,COALESCE(r.attraction_score,0) AS attraction FROM entities other JOIN persons p ON p.entity_id=other.id JOIN entity_locations_current targetLoc ON targetLoc.entity_id=other.id AND targetLoc.simulation_id=UUID_TO_BIN(?) LEFT JOIN relationships r ON r.simulation_id=UUID_TO_BIN(?) AND r.status='ACTIVE' AND((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=other.id)OR(r.source_entity_id=other.id AND r.target_entity_id=UUID_TO_BIN(?))) WHERE other.simulation_id=UUID_TO_BIN(?) AND other.status='ACTIVE' AND other.id<>UUID_TO_BIN(?) ORDER BY other.display_name LIMIT 50`,[simulationId,simulationId,entityId,entityId,simulationId,entityId]);if(!rows.length)return null;const locations=await loadWorldLocations(simulationId),candidates=[];for(const row of rows){if(!row.locationId||row.locationId===originId)continue;const route=graphRoute(locations,originId,row.locationId);if(!route)continue;const travelMinutes=routeTravelMinutes(route);if(!Number.isFinite(travelMinutes))continue;const relationshipScore=Number(row.familiarity)*.9+Number(row.closeness)*1.1+Number(row.affection)*1.2+Number(row.trust)+Number(row.attraction)*.8,noveltyBonus=row.relationshipId?0:.30,distancePenalty=Math.min(.70,travelMinutes/60*.70);candidates.push({entityId:row.id,name:row.name,locationId:row.locationId,travelMinutes,distanceMeters:route.distanceMeters,score:relationshipScore+noveltyBonus-distancePenalty,relationshipId:row.relationshipId});}candidates.sort((a,b)=>b.score-a.score||a.travelMinutes-b.travelMinutes);return candidates[0]||null;}
function chooseSocialTarget(socialContext,simulationId,entityId,originId){const candidates=Array.isArray(socialContext?.candidates)?socialContext.candidates:[];if(candidates.length){const ranked=candidates.slice().sort((a,b)=>{const aPartner=socialContext.partner?.partnerId===a.id?1:0,bPartner=socialContext.partner?.partnerId===b.id?1:0,aScore=Number(a.score||0)+aPartner*.35+Number(a.romanticScore||0)*.35,bScore=Number(b.score||0)+bPartner*.35+Number(b.romanticScore||0)*.35;return bScore-aScore;});const target=ranked[0];return{entityId:target.id,name:target.name,locationId:originId,remote:false,score:Number(target.score||0)};}return chooseRemoteSocialTarget(simulationId,entityId,originId);}
function sanitizeGeminiChoice(aiChoice,context,{socialContext,currentLocationId,worldLocations=[]}={}){if(!aiChoice)return null;const allowed=new Set((context.allowedActionTypes||[]).map(value=>String(value).toUpperCase())),selectedAction=String(aiChoice.selectedActionType||"").toUpperCase();if(!allowed.has(selectedAction))return null;const knownEntityIds=new Set([...(socialContext?.candidates||[]),...(context?.social?.candidates||[])].map(candidate=>candidate.id).filter(Boolean));const targetEntityId=aiChoice.targetEntityId&&knownEntityIds.has(aiChoice.targetEntityId)?aiChoice.targetEntityId:null;let targetLocationId=null;if(aiChoice.targetLocationId){const location=worldLocations.find(item=>item.locationId===aiChoice.targetLocationId);const route=currentLocationId&&location?actionService.shortestRoute(worldLocations,currentLocationId,aiChoice.targetLocationId):null;if(location&&route)targetLocationId=aiChoice.targetLocationId;}const strategy=aiChoice.strategy&&typeof aiChoice.strategy==='object'?aiChoice.strategy:null,proposal=aiChoice.planProposal&&typeof aiChoice.planProposal==='object'?{...aiChoice.planProposal,steps:(aiChoice.planProposal.steps||[]).filter(step=>!step.actionType||allowed.has(String(step.actionType).toUpperCase())).map(step=>({...step,actionType:step.actionType?String(step.actionType).toUpperCase():undefined})).slice(0,8)}:null;return{...aiChoice,selectedActionType:selectedAction,targetEntityId,targetLocationId,strategy,planProposal:proposal};}
async function actForEntity({simulationId,entityId,simulationTime,gemini,tickId=null}){const entity=await getEntity(simulationId,entityId);if(!entity)return null;let context=await decisionService.buildDecisionContext(simulationId,entityId,simulationTime);context.simulationTime=simulationTime;const goalState=await ensureGoalPlan({simulationId,entityId,simulationTime,needs:context.needs});if(goalState.created||(goalState.goal&&!context.goals.some(goal=>goal.id===goalState.goal.id)))context=await decisionService.buildDecisionContext(simulationId,entityId,simulationTime);context.simulationTime=simulationTime;const socialContext=entity.entityType==="PERSON"?await buildSocialContext(simulationId,entityId):{partner:null,candidates:[]};context.social={partner:socialContext.partner,candidates:socialContext.candidates.map(candidate=>({id:candidate.id,name:candidate.name,relationshipType:candidate.relationshipType,compatibility:Number(candidate.compatibility.toFixed(3)),romanticScore:Number(candidate.romanticScore.toFixed(3)),familiarity:Number(candidate.relationship?.familiarity||0),closeness:Number(candidate.relationship?.closeness||0),affection:Number(candidate.relationship?.affection||0),trust:Number(candidate.relationship?.trust||0)}))};const currentLocationId=context.location?.locationId||await getEntityLocation(simulationId,entityId);let socialTarget=null;if(entity.entityType==="PERSON"&&currentLocationId){socialTarget=await chooseSocialTarget(socialContext,simulationId,entityId,currentLocationId);if(socialTarget)context.social.travelTarget={entityId:socialTarget.entityId,name:socialTarget.name,locationId:socialTarget.locationId,remote:Boolean(socialTarget.remote),travelMinutes:Number(socialTarget.travelMinutes||0)};}const explorationDestination=entity.entityType==="PERSON"&&currentLocationId?await chooseExplorationDestination(simulationId,entityId,currentLocationId,context.needs,simulationTime):null;if(explorationDestination)context.explorationDestination=explorationDestination;const plan=goalState.goal?goalState.plan||(await ensureGoalPlan({simulationId,entityId,simulationTime,needs:context.needs})).plan:null,activePlanStep=selectActiveStep(plan);if(activePlanStep)context.activePlanStep=activePlanStep;const memories=await recallContext(simulationId,entityId,8,{simulationTime,goalIds:(context.goals||[]).map(goal=>goal.id).filter(Boolean),locationId:context.location?.locationId||null,locationType:context.location?.locationType||null,candidateActionTypes:(context.candidates||[]).map(candidate=>candidate.action).filter(Boolean)}),geminiTrigger=getGeminiTrigger(entity,context,memories);context.geminiTrigger=geminiTrigger;let aiChoice=null;
let geminiDecision={status:"NOT_CONSULTED",source:"DETERMINISTIC",reason:"NO_GEMINI_TRIGGER",attempted:false,retryAfterMs:0};
if(geminiTrigger){
  if(!gemini?.client){
    geminiDecision={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"GEMINI_UNAVAILABLE",attempted:false,retryAfterMs:0};
  }else if(!canUseGeminiDecision(entity.id,simulationTime,{highValue:geminiTrigger.priority==="HIGH",periodic:geminiTrigger.type==="PERIODIC_DELIBERATION"})){
    geminiDecision={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"LOCAL_INTERVAL",attempted:false,retryAfterMs:0};
  }else{
    const worldLocations=await loadWorldLocations(simulationId);
    const geminiContext=buildGeminiDecisionContext({entity,context,memories});
    const generated=await gemini.chooseDecision(geminiContext);
    const requestStatus=gemini.lastRequestStatus&&typeof gemini.lastRequestStatus==="object"?{...gemini.lastRequestStatus}:{status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"UNKNOWN",attempted:true,retryAfterMs:0};
    if(requestStatus.attempted)markGeminiDecisionUsed(entity.id,simulationTime);
    aiChoice=sanitizeGeminiChoice(generated,context,{socialContext,currentLocationId,worldLocations});
    geminiDecision=aiChoice
      ? {...requestStatus,status:"SUCCESS",source:"GEMINI",reason:"GEMINI_DECISION_ACCEPTED"}
      : {...requestStatus,status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:generated?"INVALID_GEMINI_OUTPUT":requestStatus.reason||"GEMINI_FALLBACK"};
    if(aiChoice?.planProposal&&goalState.goal)aiChoice.planProposal.goalId=goalState.goal.id;
  }
}
context.geminiDecision=geminiDecision;
const decision=await decisionService.makeDecision({simulationId,entityId,simulationTime,triggerType:geminiTrigger?.type||null,triggerEventId:null,context,aiChoice});const sourceType=aiChoice?"AI_ASSISTED":"AUTONOMOUS";const intentionId=await ensureIntention({simulationId,entityId,simulationTime,decision,sourceType,goalState,aiChoice,geminiDecision});const started=await require("./action-service").startAction({simulationId,entityId,decisionId:decision.decisionId,intentionId,actionType:decision.actionType,simulationTime,targetEntityId:decision.targetEntityId,targetLocationId:decision.targetLocationId,relationshipIntent:deriveSocialIntent({actionType:decision.actionType,targetId:decision.targetEntityId,partner:socialContext.partner,candidates:socialContext.candidates}),tickId});return{decision,started,intentionId,goalState,aiChoice};}
async function ensureIntention({simulationId,entityId,simulationTime,decision,sourceType,goalState,aiChoice,geminiDecision}){const intentionId=require("../lib/ids").uuid(),decisionSource=decision?.decisionSource||sourceType||"DETERMINISTIC",reason=serializeReason({source:decisionSource,status:geminiDecision?.status||"NOT_CONSULTED",geminiReason:geminiDecision?.reason||null,decision:aiChoice?.strategy||decision.reason||"autonomous decision"}),goalId=goalState.goal?.id||null,planId=goalState.plan?.id||null,mysqlTime=mysqlSimulationDateTime(simulationTime);await pool.query(`INSERT INTO intentions(id,simulation_id,entity_id,goal_id,plan_id,action_type,target_entity_id,target_location_id,scheduled_simulation_at,priority,status,reason,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,'ACTIVE',?,?,1)`,[intentionId,simulationId,entityId,goalId,planId,decision.actionType,decision.targetEntityId,decision.targetLocationId,goalState.goal?.priority||.5,reason,mysqlTime]);return intentionId;}
async function completeGoalForAction(goalId,actionType,simulationTime,outcome,actionResult={}){if(!goalId)return null;let simulationId=actionResult?.simulationId||null,entityId=actionResult?.entityId||null;if(!simulationId||!entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(simulation_id) AS simulationId,BIN_TO_UUID(entity_id) AS entityId FROM goals WHERE id=UUID_TO_BIN(?) LIMIT 1`,[goalId]);simulationId=simulationId||rows[0]?.simulationId||null;entityId=entityId||rows[0]?.entityId||null;}if(!simulationId||!entityId)return null;return advancePlanForAction({simulationId,entityId,goalId,actionType,outcome,simulationTime,actionResult});}
module.exports={findAutonomousActors,shouldAskGemini,getGeminiTrigger,actForEntity,completeGoalForAction,canUseGeminiDecision,markGeminiDecisionUsed,sanitizeGeminiChoice,chooseExplorationDestination,goalActionSatisfiesNeed,buildGeminiDecisionContext};
