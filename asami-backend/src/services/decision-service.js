const {pool}=require("../db/pool");
const {uuid}=require("../lib/ids");
const {ACTIONS,scoreAction,RESOURCE_REQUIREMENTS,needPriorityState,CRITICAL_NEED_ACTIONS}=require("./decision-rules");
const {getCognitiveProfile,cognitiveDecisionModifier}=require("./personality-service");
const {cognitiveExperienceModifier}=require("./experience-learning-service");
const RESOURCE_SEARCH_TTL_MINUTES=180,RESOURCE_TRAVEL_BONUS=.85,WALKING_SPEED_KMH=4.8,ROAD_FACTOR=1.18,MAX_EXPERIENCE_SCORE_EFFECT=.65,MAX_RECENT_ACTIONS=12,MAX_RECENT_INTERRUPTION_HOURS=12,MAX_RECENT_SOCIAL_INTERACTIONS=12,STOCHASTIC_TOP_K=4,BASE_TEMPERATURE=.24;
const LOCATION_ACTION_BIAS={HOME:{SLEEPING:.50,RESTING:.30,EATING:.18,DRINKING:.12},CAFE:{TALKING:.45,DRINKING:.35,EATING:.20,PLAYING:.08,READING:.05},SHOP:{EATING:.36,DRINKING:.42,EXPLORING:.05,WALKING:.05},LIBRARY:{READING:.45,STUDYING:.50,WORKING:.05,TALKING:-.08},SCHOOL:{STUDYING:.48,READING:.30,TALKING:.06,PLAYING:.03},PARK:{WALKING:.32,PLAYING:.35,TALKING:.25,EXPLORING:.28},SQUARE:{TALKING:.35,WALKING:.20,PLAYING:.18,EXPLORING:.08},COMMUNITY:{TALKING:.35,WORKING:.22,STUDYING:.18,PLAYING:.12},GYM:{PLAYING:.48,WALKING:.20,RESTING:.10},CLINIC:{RESTING:.20,WALKING:.05},NATURE:{EXPLORING:.42,WALKING:.36,PLAYING:.18},WORKSHOP:{WORKING:.46,STUDYING:.14,EXPLORING:.10}};
function normalizeAction(v){return String(v||"").trim().toUpperCase();}
function parseJson(v,f={}){if(v===null||v===undefined)return f;if(typeof v==="object")return v;try{return JSON.parse(v);}catch{return f;}}
function haversineMeters(a,b){const lat1=Number(a?.latitude),lon1=Number(a?.longitude),lat2=Number(b?.latitude),lon2=Number(b?.longitude);if(![lat1,lon1,lat2,lon2].every(Number.isFinite))return Infinity;const r=Math.PI/180,R=6371000,dLat=(lat2-lat1)*r,dLon=(lon2-lon1)*r,h=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h));}
function shortestRoute(locations,originId,targetId){if(!originId||!targetId)return null;const byId=new Map(locations.map(l=>[l.locationId,l])),byCode=new Map(locations.filter(l=>l.data?.worldCode).map(l=>[String(l.data.worldCode).toUpperCase(),l]));if(!byId.has(originId)||!byId.has(targetId))return null;if(originId===targetId)return{path:[originId],distanceMeters:0};const distances=new Map(),previous=new Map(),unvisited=new Set(locations.map(l=>l.locationId));for(const id of unvisited)distances.set(id,Infinity);distances.set(originId,0);while(unvisited.size){let currentId=null,currentDistance=Infinity;for(const id of unvisited){const d=distances.get(id);if(d<currentDistance){currentDistance=d;currentId=id;}}if(currentId===null||currentDistance===Infinity)break;unvisited.delete(currentId);if(currentId===targetId)break;const current=byId.get(currentId);for(const code of Array.isArray(current?.data?.connections)?current.data.connections:[]){const next=byId.get(code)||byCode.get(String(code).toUpperCase());if(!next||!unvisited.has(next.locationId))continue;const raw=haversineMeters(current,next),edge=Number.isFinite(raw)?Math.max(5,raw*ROAD_FACTOR):5,candidate=currentDistance+edge;if(candidate<distances.get(next.locationId)){distances.set(next.locationId,candidate);previous.set(next.locationId,currentId);}}}if(!Number.isFinite(distances.get(targetId)))return null;const path=[];let cursor=targetId;while(cursor){path.unshift(cursor);if(cursor===originId)break;cursor=previous.get(cursor);}return path[0]===originId?{path,distanceMeters:distances.get(targetId)}:null;}
function travelMinutes(d){if(!Number.isFinite(Number(d)))return null;return Number(d)/1000/WALKING_SPEED_KMH*60;}
function findNearestResourceLocation(locations,originId,resource,excluded=[]){let best=null;const set=new Set(excluded||[]);for(const location of locations){if(set.has(location.locationId))continue;if(Number(location.resources?.[resource]??0)<1)continue;const route=shortestRoute(locations,originId,location.locationId);if(!route)continue;const minutes=travelMinutes(route.distanceMeters);if(minutes===null)continue;if(!best||minutes<best.travelMinutes)best={locationId:location.locationId,locationType:location.locationType,distanceMeters:route.distanceMeters,travelMinutes:minutes};}return best;}
function resourceTargetAction(r){return r==="water"||r==="food"?"WALKING":null;}
function applyResourceRoutingBias(candidates,resourceContext,needs){const next=candidates.map(c=>({...c})),indexByAction=new Map(next.map((c,i)=>[normalizeAction(c.action),i]));for(const[action,requirement]of Object.entries(RESOURCE_REQUIREMENTS)){const status=resourceContext.actions?.[action];if(!status||status.localAvailable>=requirement.amount)continue;const nearest=status.nearestLocation,walkingIndex=indexByAction.get(resourceTargetAction(requirement.resource));if(!nearest||walkingIndex===undefined)continue;const pressureCode=action==="DRINKING"?"THIRST":"HUNGER",pressure=Number(needs.find(n=>n.code===pressureCode)?.value||0),urgency=Math.min(1.4,RESOURCE_TRAVEL_BONUS+pressure*.6),travelPenalty=Math.min(.45,Number(nearest.travelMinutes||0)/60*.45);next[walkingIndex].score=Number(next[walkingIndex].score||0)+urgency-travelPenalty;next[walkingIndex].targetLocationId=nearest.locationId;next[walkingIndex].resourceIntent={resource:requirement.resource,reason:"RESOURCE_UNAVAILABLE_LOCALLY",expectedTravelMinutes:nearest.travelMinutes,destinationLocationId:nearest.locationId};}return next.sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function applyPlanBias(candidates,plans){if(!Array.isArray(candidates)||!Array.isArray(plans))return candidates;const actions=new Set();for(const plan of plans){const step=(plan.steps||[]).find(s=>s.status==="ACTIVE"||s.status==="PENDING"),action=normalizeAction(step?.actionType||step?.result?.actionType);if(action)actions.add(action);}if(!actions.size)return candidates;return candidates.map(c=>actions.has(normalizeAction(c.action))?{...c,score:Number(c.score||0)+.65}:c).sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function actionFrequencyPenalty(action,recentActions){const recent=recentActions.map(normalizeAction),target=normalizeAction(action),count=recent.filter(x=>x===target).length;let penalty=Math.min(.72,count*.22);if(recent[0]===target)penalty+=.72;if(recent[1]===target)penalty+=.36;if(recent[2]===target)penalty+=.24;if(recent.length>=3&&recent[0]===target&&recent[2]===target)penalty+=.55;if(recent.length>=4&&recent[0]===target&&recent[3]===target)penalty+=.35;return Math.min(1.85,penalty);}
function applyRecentActionPenalty(candidates,recentActions=[]){if(!Array.isArray(candidates)||!recentActions.length)return candidates;return candidates.map(c=>({...c,score:Math.max(0,Number(c.score||0)-actionFrequencyPenalty(c.action,recentActions))})).sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function recoveryBlockForInterruption(interruption){
  const reason=parseJson(interruption?.result,{});
  const interruptionData=reason?.interruption||{};
  const code=normalizeAction(interruptionData.code);
  const interruptedAction=normalizeAction(interruption?.actionType);
  if(!code) return null;
  const blocks={
    THIRST:["SLEEPING"],
    HUNGER:["SLEEPING"],
    ENERGY:["WORKING","STUDYING","PLAYING","EXPLORING","WALKING"],
    SAFETY:["WORKING","STUDYING","PLAYING","EXPLORING","WALKING"]
  }[code]||[];
  if(!blocks.length) return null;
  const releaseBelow={THIRST:.55,HUNGER:.55,ENERGY:.35,SAFETY:.35}[code] ?? .5;
  return {
    code,
    interruptedAction,
    blockedActions:[...new Set(blocks.concat(interruptedAction==="SLEEPING"&&!blocks.includes("SLEEPING")?["SLEEPING"]:[]))],
    releaseBelow
  };
}
function activeRecoveryBlocks(interruptions=[],needs=[]){
  const values=new Map((needs||[]).map(need=>[normalizeAction(need.code),Number(need.value)]));
  return (interruptions||[]).map(row=>{
    const block=recoveryBlockForInterruption(row);
    if(!block) return null;
    const value=values.get(block.code);
    if(!Number.isFinite(value)||value<=block.releaseBelow) return null;
    return {...block,needValue:value,at:row.at||null,actionId:row.id||null};
  }).filter(Boolean);
}
function applyRecoveryBlocks(candidates,recoveryBlocks=[],protectedActions=[]){
  if(!Array.isArray(candidates)||!recoveryBlocks.length)return candidates;
  const protectedSet=new Set((protectedActions||[]).map(normalizeAction).filter(Boolean));
  const blocked=new Map();
  for(const block of recoveryBlocks)for(const action of block.blockedActions)blocked.set(normalizeAction(action),block);
  return candidates.map(candidate=>{
    const action=normalizeAction(candidate.action),block=blocked.get(action);
    if(!block)return candidate;
    if(protectedSet.has(action))return {...candidate,recoveryBlocked:false,recoveryBlock:null};
    return {
      ...candidate,
      score:0,
      recoveryBlocked:true,
      recoveryBlock:{code:block.code,needValue:block.needValue,releaseBelow:block.releaseBelow,interruptedAction:block.interruptedAction}
    };
  });
}
function stableHash(input){let h=2166136261;for(const ch of String(input||"")){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}h+=h<<13;h^=h>>>7;h+=h<<3;h^=h>>>17;h+=h<<5;return h>>>0;}
function individualityBias(entityId,actionType){const v=stableHash(`${entityId}:${normalizeAction(actionType)}`)/0xffffffff;return(v-.5)*.42;}
function applyIndividualityBias(candidates,entityId){return candidates.map(c=>({...c,score:Number(c.score||0)+individualityBias(entityId,c.action)}));}
function applyLocationBias(candidates,location){const bias=LOCATION_ACTION_BIAS[normalizeAction(location?.locationType)];if(!bias)return candidates;return candidates.map(c=>({...c,score:Math.max(-1,Number(c.score||0)+Number(bias[normalizeAction(c.action)]||0))})).sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function criticalNeedState(needs=[]){let highest=null;for(const code of Object.keys(CRITICAL_NEED_ACTIONS)){const need=needs.find(n=>normalizeAction(n.code)===code);if(!need)continue;const value=Number(need.value);if(!Number.isFinite(value))continue;const policy=CRITICAL_NEED_ACTIONS[code];if((policy.direction==="HIGH"&&value<policy.threshold)||(policy.direction==="LOW"&&value>policy.threshold))continue;const weight=Math.max(.1,Number(need.priorityWeight||1)),urgency=policy.direction==="HIGH"?Math.min(1.5,1+(value-policy.threshold)/Math.max(.01,1-policy.threshold)):Math.min(1.5,1+(policy.threshold-value)/Math.max(.01,policy.threshold)),candidate={code,value,threshold:policy.threshold,action:policy.action,weight,urgency:urgency*weight};if(!highest||candidate.urgency>highest.urgency)highest=candidate;}return highest;}
function criticalNeedAction(needs=[]){return criticalNeedState(needs)?.action||null;}
function applyPlanCommitment(candidates,{needs=[],activePlanStep=null}={}){if(!Array.isArray(candidates)||!activePlanStep)return candidates;const action=normalizeAction(activePlanStep.result?.actionType||activePlanStep.actionType);if(!action)return candidates;const critical=criticalNeedAction(needs);if(critical&&critical!==action){const walking=candidates.find(c=>normalizeAction(c.action)==="WALKING");const servesResource=action==="WALKING"&&walking?.resourceIntent?.resource===(critical==="DRINKING"?"water":critical==="EATING"?"food":null);if(!servesResource)return candidates;}const target=candidates.find(c=>normalizeAction(c.action)===action);if(!target)return candidates;return candidates.map(c=>normalizeAction(c.action)===action?{...c,score:Number(c.score||0)+1.25,planCommitted:true}:{...c,score:Number(c.score||0)-.65}).sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function applyExplorationCommitment(candidates,{needs=[],explorationDestination=null,activePlanStep=null}={}){if(!Array.isArray(candidates)||!explorationDestination||activePlanStep)return candidates;const curiosity=Number(needs.find(n=>normalizeAction(n.code)==="CURIOSITY")?.value||0),novelty=Number(explorationDestination.novelty||0);if(curiosity<.55||novelty<.7||criticalNeedState(needs))return candidates;const target=candidates.find(c=>normalizeAction(c.action)==="EXPLORING");if(!target)return candidates;target.targetLocationId=explorationDestination.locationId;target.explorationIntent={reason:"NOVELTY_OPPORTUNITY",novelty,interest:Number(explorationDestination.interest||0),expectedTravelMinutes:Number(explorationDestination.travelMinutes||0)};const maxOther=candidates.filter(c=>normalizeAction(c.action)!=="EXPLORING").reduce((m,c)=>Math.max(m,Number(c.score||0)),-Infinity);target.score=Math.max(Number(target.score||0),maxOther+.3);return candidates.sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
function socialPairBias(entityId,targetId){const v=stableHash(`social:${entityId}:${targetId}`)/0xffffffff;return(v-.5)*.16;}
function chooseSocialTargetCandidate(context,entityId){
  const candidates=Array.isArray(context?.social?.candidates)?context.social.candidates:[];
  if(!candidates.length)return null;
  return candidates.map(candidate=>{
    const familiarity=Number(candidate.familiarity||0),closeness=Number(candidate.closeness||0),affection=Number(candidate.affection||0),trust=Number(candidate.trust||0),compatibility=Number(candidate.compatibility||.5),romantic=Number(candidate.romanticScore||0);
    const relationshipValue=familiarity*.70+closeness*.85+affection*.95+trust*.80+compatibility*.75+romantic*.18;
    const novelty=(1-Math.min(1,familiarity))*.28;
    const pairBias=socialPairBias(entityId,candidate.id);
    const recentCount=Number(context?.recentSocialTargetCounts?.[candidate.id]||0);
    const recentPenalty=Math.min(.80,recentCount*.14+(context?.recentSocialTargets?.[0]===candidate.id ? .35 : 0));
    const returnScore=relationshipValue+novelty+pairBias-recentPenalty;
    return{...candidate,selectionScore:returnScore,recentInteractionCount:recentCount};
  }).sort((a,b)=>Number(b.selectionScore||0)-Number(a.selectionScore||0))[0]||null;
}
function applySocialFeasibility(candidates,context,entityId){
  if(!Array.isArray(candidates))return candidates;
  const socialTarget=chooseSocialTargetCandidate(context,entityId);
  return candidates.map(candidate=>{
    if(normalizeAction(candidate.action)!=="TALKING")return candidate;
    if(!socialTarget)return{...candidate,score:0,targetEntityId:null,socialUnavailable:true,socialFallbackReason:"NO_REACHABLE_PERSON"};
    return{...candidate,score:Number(candidate.score||0)+.24,targetEntityId:socialTarget.id,targetName:socialTarget.name,socialTarget:true,socialSelectionScore:socialTarget.selectionScore};
  }).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}
function applySocialIsolationFallback(candidates,context){
  if(!Array.isArray(candidates))return candidates;
  const socialPressure=Math.max(
    Number((context?.needs||[]).find(n=>normalizeAction(n.code)==="SOCIAL_NEED")?.value||0),
    Number((context?.needs||[]).find(n=>normalizeAction(n.code)==="BELONGING")?.value||0)
  );
  if((context?.social?.candidates||[]).length||socialPressure<.55)return candidates;
  return candidates.map(candidate=>{
    const action=normalizeAction(candidate.action);
    if(action==="PLAYING")return{...candidate,score:Number(candidate.score||0)+.28,socialFallback:true,socialFallbackReason:"NO_REACHABLE_PERSON"};
    if(action==="EXPLORING")return{...candidate,score:Number(candidate.score||0)+.12,socialFallback:true,socialFallbackReason:"NO_REACHABLE_PERSON"};
    return candidate;
  }).sort((a,b)=>Number(b.score||0)-Number(a.score||0));
}
function deriveProactivity({needs=[],goals=[],social=null,explorationDestination=null,activePlanStep=null}){const pressures=Object.fromEntries(needs.map(n=>[normalizeAction(n.code),Number(n.value||0)])),signals=[],topPressure=Object.entries(pressures).filter(([code])=>!['ENERGY','SAFETY'].includes(code)).sort((a,b)=>b[1]-a[1])[0];if(topPressure&&topPressure[1]>=.55)signals.push({type:"NEED",code:topPressure[0],intensity:topPressure[1]});const activeGoal=goals.find(g=>Number(g.progress||0)<1);if(activeGoal)signals.push({type:"GOAL",goalId:activeGoal.id,priority:Number(activeGoal.priority||0)});if(explorationDestination&&!criticalNeedState(needs))signals.push({type:"EXPLORATION",locationId:explorationDestination.locationId,novelty:Number(explorationDestination.novelty||0),score:Number(explorationDestination.score||0)});const socialCandidates=Array.isArray(social?.candidates)?social.candidates:[];if(socialCandidates.length&&!criticalNeedState(needs)&&Math.max(pressures.SOCIAL_NEED||0,pressures.BELONGING||0)>=.35)signals.push({type:"SOCIAL",targetEntityId:socialCandidates[0].id,candidateCount:socialCandidates.length});if(activePlanStep)signals.push({type:"PLAN",stepId:activePlanStep.id,actionType:normalizeAction(activePlanStep.result?.actionType||activePlanStep.actionType)});const critical=criticalNeedState(needs);return{mode:signals.length?"PROACTIVE":"AUTONOMOUS",priority:critical?"CRITICAL":signals.some(s=>s.type==="NEED")?"HIGH":signals.length?"MEDIUM":"LOW",signals,autonomous:Boolean(signals.length||critical),trigger:signals.length||critical?"INTERNAL_STATE":null};}
function applyProactiveOpportunityBias(candidates,proactivity){if(!proactivity?.autonomous||!Array.isArray(candidates))return candidates;const signals=new Set((proactivity.signals||[]).map(s=>s.type));return candidates.map(c=>{let bonus=0,a=normalizeAction(c.action);if(signals.has("EXPLORATION")&&a==="EXPLORING")bonus+=.22;if(signals.has("SOCIAL")&&a==="TALKING")bonus+=.20;if(signals.has("PLAN")&&(proactivity.signals||[]).some(s=>s.type==="PLAN"&&normalizeAction(s.actionType)===a))bonus+=.24;if(signals.has("GOAL")&&["WALKING","EXPLORING","TALKING","STUDYING","READING","WORKING","PLAYING","EATING","DRINKING","SLEEPING"].includes(a))bonus+=.04;return bonus?{...c,score:Number(c.score||0)+bonus}:c;}).sort((a,b)=>Number(b.score||0)-Number(a.score||0));}
async function loadResourceContext(simulationId,entityId,location,simulationTime,excludedLocationIds=[]){
  const[rows]=await pool.query(\`SELECT BIN_TO_UUID(e.id) AS locationId,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData,e.attributes FROM locations l JOIN entities e ON e.id=l.entity_id WHERE l.simulation_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'\`,[simulationId,simulationId]);
  const locations=rows.map(row=>{
    const attributes=parseJson(row.attributes,{});
    return{
      locationId:row.locationId,
      locationType:row.locationType,
      latitude:Number(row.latitude),
      longitude:Number(row.longitude),
      data:parseJson(row.addressData),
      resources:attributes.resources&&typeof attributes.resources==='object'?attributes.resources:{},
      resourceEmergencies:attributes.resourceEmergencies&&typeof attributes.resourceEmergencies==='object'?attributes.resourceEmergencies:{}
    };
  });
  const current=locations.find(x=>x.locationId===location?.locationId),nearestResources={};
  for(const resource of ["water","food"]){
    nearestResources[resource]=findNearestResourceLocation(locations,location?.locationId,resource,excludedLocationIds);
  }

  const now=new Date(simulationTime).getTime(),emergencyResources=[];
  if(Number.isFinite(now)){
    for(const item of locations){
      for(const[resource,emergency] of Object.entries(item.resourceEmergencies||{})){
        const activeUntil=new Date(emergency?.activeUntil||0).getTime();
        const triggeredAt=new Date(emergency?.triggeredAt||0).getTime();
        if(emergency?.active!==true||!Number.isFinite(triggeredAt)||!Number.isFinite(activeUntil))continue;
        if(now<triggeredAt||now>activeUntil)continue;
        emergencyResources.push({
          resource:String(resource).toLowerCase(),
          locationId:item.locationId,
          reason:emergency.reason||null,
          triggeredAt:emergency.triggeredAt||null,
          activeUntil:emergency.activeUntil||null,
          reserve:Number(emergency.reserve)||null
        });
      }
    }
  }

  const resourceEmergencyByResource=new Map(
    emergencyResources.map(item=>[item.resource,item])
  );

  const[knowledgeRows]=await pool.query(\`SELECT BIN_TO_UUID(ki.object_entity_id) AS locationId,ki.content,ek.learned_simulation_at AS learnedAt FROM entity_knowledge ek JOIN knowledge_items ki ON ki.id=ek.knowledge_item_id WHERE ek.simulation_id=UUID_TO_BIN(?) AND ek.entity_id=UUID_TO_BIN(?) AND ek.status='ACTIVE' AND ki.knowledge_type='WORLD_EXPERIENCE' AND ki.predicate='RESOURCE_UNAVAILABLE' ORDER BY ek.learned_simulation_at DESC LIMIT 48\`,[simulationId,entityId]);
  const blockedResources={};
  for(const row of knowledgeRows){
    const learnedAt=new Date(row.learnedAt).getTime();
    if(!Number.isFinite(learnedAt)||!Number.isFinite(now)||now-learnedAt>RESOURCE_SEARCH_TTL_MINUTES*60000)continue;
    const payload=parseJson(row.content,null);
    if(payload?.resource&&row.locationId===location?.locationId)blockedResources[String(payload.resource).toLowerCase()]=true;
  }

  const actions={};
  for(const[action,requirement]of Object.entries(RESOURCE_REQUIREMENTS)){
    const localAvailable=Number(current?.resources?.[requirement.resource]??0);
    actions[action]={
      resource:requirement.resource,
      required:requirement.amount,
      localAvailable,
      locallyAvailable:localAvailable>=requirement.amount,
      recentlyBlocked:Boolean(blockedResources[requirement.resource]),
      nearestLocation:nearestResources[requirement.resource]||null,
      emergency:resourceEmergencyByResource.get(requirement.resource)||null
    };
  }

  return{
    currentLocationId:current?.locationId||location?.locationId||null,
    currentResources:current?.resources||{},
    localResources:current?.resources||{},
    blockedResources,
    nearestResources,
    emergencyResources,
    resourceEmergency:resourceEmergencyByResource.get("water")||resourceEmergencyByResource.get("food")||null,
    actions
  };
}
async function buildDecisionContext(simulationId,entityId,simulationTime=null){let effectiveSimulationTime=simulationTime;if(!effectiveSimulationTime){const[rows]=await pool.query(`SELECT current_simulation_at AS currentSimulationAt FROM simulations WHERE id=UUID_TO_BIN(?) LIMIT 1`,[simulationId]);effectiveSimulationTime=rows[0]?.currentSimulationAt||new Date();}const[[needs],[traits],[goals],[location],[recentActions],[recentInterruptions],[recentSocialInteractions]]=await Promise.all([pool.query(`SELECT nd.code,enc.value,nd.priority_weight AS priorityWeight FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1`,[entityId]),pool.query(`SELECT td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,[entityId]),pool.query(`SELECT BIN_TO_UUID(id) AS id,title,goal_type AS goalType,priority,progress,motivation,status,created_simulation_at AS createdAt FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED') ORDER BY priority DESC,created_simulation_at ASC LIMIT 10`,[simulationId,entityId]),pool.query(`SELECT BIN_TO_UUID(elc.location_id) AS locationId,l.location_type AS locationType,l.address_data AS addressData FROM entity_locations_current elc JOIN locations l ON l.entity_id=elc.location_id AND l.simulation_id=elc.simulation_id WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]),pool.query(`SELECT action_type AS actionType FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='COMPLETED' ORDER BY started_simulation_at DESC LIMIT ?`,[simulationId,entityId,MAX_RECENT_ACTIONS]),pool.query(`SELECT BIN_TO_UUID(id) AS id,action_type AS actionType,result,completed_simulation_at AS at FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='INTERRUPTED' AND completed_simulation_at IS NOT NULL AND completed_simulation_at>=DATE_SUB(?,INTERVAL ? HOUR) AND completed_simulation_at<=? ORDER BY completed_simulation_at DESC LIMIT 8`,[simulationId,entityId,effectiveSimulationTime,MAX_RECENT_INTERRUPTION_HOURS,effectiveSimulationTime]),pool.query(`SELECT JSON_UNQUOTE(JSON_EXTRACT(result,'$.targetEntityId')) AS targetEntityId FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND action_type='TALKING' AND status='COMPLETED' AND JSON_EXTRACT(result,'$.targetEntityId') IS NOT NULL ORDER BY completed_simulation_at DESC LIMIT ?`,[simulationId,entityId,MAX_RECENT_SOCIAL_INTERACTIONS])]);const currentLocation=location[0]||null,recoveryBlocks=activeRecoveryBlocks(recentInterruptions,needs),recentSocialTargets=recentSocialInteractions.map(row=>row.targetEntityId).filter(Boolean),recentSocialTargetCounts=recentSocialTargets.reduce((counts,id)=>{counts[id]=(counts[id]||0)+1;return counts;},{}),cognitiveProfile=await getCognitiveProfile(simulationId,entityId),excludedLocationIds=[];for(const plan of cognitiveProfile.plans||[])for(const id of plan.strategy?.avoidLocationIds||[])if(id&&!excludedLocationIds.includes(id))excludedLocationIds.push(id);const resourceExclusions=criticalResourceNeedState(needs)?[]:excludedLocationIds;const resourceContext=await loadResourceContext(simulationId,entityId,currentLocation,effectiveSimulationTime,resourceExclusions);let candidates=ACTIONS.map(action=>({action,score:scoreAction(action,needs,traits,resourceContext)}));candidates=candidates.map(c=>({...c,score:Number(c.score||0)+cognitiveDecisionModifier(cognitiveProfile,c.action)+Math.max(-MAX_EXPERIENCE_SCORE_EFFECT,Math.min(MAX_EXPERIENCE_SCORE_EFFECT,cognitiveExperienceModifier(cognitiveProfile,c.action,{locationType:currentLocation?.locationType,locationId:currentLocation?.locationId})))}));candidates=applyIndividualityBias(candidates,entityId);candidates=applyPlanBias(candidates,cognitiveProfile.plans);candidates=applyRecentActionPenalty(candidates,recentActions.map(r=>r.actionType));candidates=applyLocationBias(candidates,currentLocation);candidates=applyResourceRoutingBias(candidates,resourceContext,needs);candidates=applyRecoveryBlocks(candidates,recoveryBlocks,criticalProtectedActions(needs,resourceContext));const needPriority=needPriorityState(needs);return{needs,traits,goals,location:currentLocation,recentActions:recentActions.map(r=>r.actionType),recentInterruptions:recentInterruptions.map(row=>({...row,result:parseJson(row.result,{})})),recentSocialTargets,recentSocialTargetCounts,recoveryBlocks,resourceContext,cognitiveProfile,needPriority,allowedActionTypes:ACTIONS,candidates};}
function chooseStochasticCandidate(candidates,{temperature=BASE_TEMPERATURE,random=Math.random}={}){const usable=candidates.filter(c=>Number(c.score||0)>0).slice(0,STOCHASTIC_TOP_K);if(!usable.length)return candidates[0]||{action:"RESTING",score:0};if(usable.length===1)return usable[0];const top=Number(usable[0].score||0),second=Number(usable[1].score||0);if(top-second>=.85)return usable[0];const t=Math.max(.12,Math.min(.48,Number(temperature||BASE_TEMPERATURE))),weights=usable.map(c=>Math.exp((Number(c.score||0)-top)/t)),total=weights.reduce((s,v)=>s+v,0);if(!Number.isFinite(total)||total<=0)return usable[0];let cursor=random()*total;for(let i=0;i<usable.length;i++){cursor-=weights[i];if(cursor<=0)return usable[i];}return usable[usable.length-1];}
function resolvePlanCommitment(context){const step=context?.activePlanStep;if(!step)return null;const action=normalizeAction(step.result?.actionType||step.actionType);if(!action)return null;const critical=criticalNeedAction(context?.needs||[]);if(critical&&critical!==action)return null;const candidate=(context?.candidates||[]).find(c=>normalizeAction(c.action)===action&&!c.recoveryBlocked);return candidate?{action,candidate,reason:"ACTIVE_PLAN_COMMITMENT"}:null;}
function compactDecisionContext(context = {}) {
  const compactNumber = (value, fallback = null) => {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(4)) : fallback;
  };
  const compactString = (value, maxLength = 240) => {
    if (value === null || value === undefined) return null;
    const string = String(value);
    return string.length > maxLength ? string.slice(0, maxLength) : string;
  };
  const compactCandidate = (candidate, rank) => {
    const resourceIntent = candidate?.resourceIntent;
    return {
      rank,
      action: normalizeAction(candidate?.action),
      score: compactNumber(candidate?.score, 0),
      targetEntityId: candidate?.targetEntityId || null,
      targetLocationId: candidate?.targetLocationId || null,
      planCommitted: Boolean(candidate?.planCommitted),
      habitCommitted: Boolean(candidate?.habitCommitted),
      socialTarget: Boolean(candidate?.socialTarget),
      socialUnavailable: Boolean(candidate?.socialUnavailable),
      world2: Boolean(candidate?.world2),
      resourceIntent: resourceIntent ? {
        resource: resourceIntent.resource || null,
        reason: resourceIntent.reason || null,
        expectedTravelMinutes: compactNumber(resourceIntent.expectedTravelMinutes),
        destinationLocationId: resourceIntent.destinationLocationId || null
      } : null
    };
  };

  const candidates = Array.isArray(context.candidates)
    ? context.candidates
        .slice()
        .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
        .slice(0, 4)
        .map((candidate, index) => compactCandidate(candidate, index + 1))
    : [];

  const proactivity = context.proactivity || {};
  const signals = Array.isArray(proactivity.signals)
    ? proactivity.signals.slice(0, 5).map(signal => ({
        type: signal?.type || null,
        code: signal?.code || null,
        goalId: signal?.goalId || null,
        stepId: signal?.stepId || null,
        actionType: normalizeAction(signal?.actionType) || null,
        targetEntityId: signal?.targetEntityId || null,
        locationId: signal?.locationId || null,
        candidateCount: compactNumber(signal?.candidateCount),
        novelty: compactNumber(signal?.novelty),
        priority: compactNumber(signal?.priority)
      }))
    : [];

  const development = context.development || context.capabilityGate || {};
  const developmentSnapshot = development && typeof development === "object" ? {
    stage: development.stage || development.code || null,
    ageDays: compactNumber(development.ageDays),
    languageLevel: compactNumber(development.languageLevel),
    socialAutonomy: compactNumber(development.socialAutonomy),
    memoryCapacity: Number.isFinite(Number(development.memoryCapacity)) ? Number(development.memoryCapacity) : null,
    decisionHorizon: Number.isFinite(Number(development.decisionHorizon)) ? Number(development.decisionHorizon) : null,
    actionDurationScale: compactNumber(development.actionDurationScale)
  } : null;

  const activePlanStep = context.activePlanStep;
  const exploration = context.explorationDestination;
  const resourceContext = context.resourceContext || {};
  const resourceActions = resourceContext.actions && typeof resourceContext.actions === "object"
    ? Object.fromEntries(Object.entries(resourceContext.actions).map(([action, status]) => [
        action,
        {
          resource: status?.resource || null,
          required: compactNumber(status?.required),
          localAvailable: compactNumber(status?.localAvailable),
          locallyAvailable: Boolean(status?.locallyAvailable),
          recentlyBlocked: Boolean(status?.recentlyBlocked),
          nearestLocationId: status?.nearestLocation?.locationId || null,
          nearestTravelMinutes: compactNumber(status?.nearestLocation?.travelMinutes)
        }
      ]))
    : {};

  const geminiDecision = context.geminiDecision;
  const geminiSnapshot = geminiDecision && typeof geminiDecision === "object" ? {
    status: geminiDecision.status || null,
    source: geminiDecision.source || null,
    reason: compactString(geminiDecision.reason, 120),
    attempted: Boolean(geminiDecision.attempted),
    retryAfterMs: Number.isFinite(Number(geminiDecision.retryAfterMs)) ? Number(geminiDecision.retryAfterMs) : 0
  } : null;

  const aiChoice = context.aiChoice;
  const aiSnapshot = aiChoice && typeof aiChoice === "object" ? {
    selectedActionType: normalizeAction(aiChoice.selectedActionType) || null,
    targetEntityId: aiChoice.targetEntityId || null,
    targetLocationId: aiChoice.targetLocationId || null,
    confidence: compactNumber(aiChoice.confidence),
    strategy: compactString(aiChoice.strategy, 180),
    reason: compactString(aiChoice.reason, 300),
    planProposal: aiChoice.planProposal ? {
      title: compactString(aiChoice.planProposal.title, 180),
      intent: compactString(aiChoice.planProposal.intent, 240),
      steps: Array.isArray(aiChoice.planProposal.steps)
        ? aiChoice.planProposal.steps.slice(0, 8).map(step => ({
            actionType: normalizeAction(step?.actionType || step?.result?.actionType) || null,
            durationMinutes: compactNumber(step?.durationMinutes)
          }))
        : []
    } : null
  } : null;

  return {
    schemaVersion: 2,
    criticalNeed: normalizeAction(context.criticalNeed) || null,
    criticalAction: normalizeAction(context.criticalAction) || null,
    criticalResourceRecovery: context.criticalResourceRecovery ? {
      code: normalizeAction(context.criticalResourceRecovery.code) || null,
      resource: context.criticalResourceRecovery.resource || null,
      mode: context.criticalResourceRecovery.mode || null,
      targetLocationId: context.criticalResourceRecovery.targetLocationId || null
    } : null,
    selectionMode: context.selectionMode || null,
    chosenAction: normalizeAction(context.chosenAction || context.selectedActionType) || null,
    individuality: compactNumber(context.individuality),
    needPriority: context.needPriority || null,
    needs: Array.isArray(context.needs)
      ? context.needs.map(need => ({
          code: normalizeAction(need?.code) || null,
          value: compactNumber(need?.value, 0),
          priorityWeight: compactNumber(need?.priorityWeight, 1)
        }))
      : [],
    traits: Array.isArray(context.traits)
      ? context.traits.map(trait => ({
          code: normalizeAction(trait?.code) || null,
          value: compactNumber(trait?.value, 0)
        }))
      : [],
    goals: Array.isArray(context.goals)
      ? context.goals.slice(0, 5).map(goal => ({
          id: goal?.id || null,
          goalType: goal?.goalType || null,
          priority: compactNumber(goal?.priority, 0),
          progress: compactNumber(goal?.progress, 0),
          motivation: (()=>{const parsed=parseJson(goal?.motivation,{});const value=Number(parsed?.pressure);return Number.isFinite(value)?Number(value.toFixed(4)):compactNumber(goal?.motivation)})()
        }))
      : [],
    location: context.location ? {
      locationId: context.location.locationId || null,
      locationType: context.location.locationType || null
    } : null,
    recentActions: Array.isArray(context.recentActions) ? context.recentActions.slice(0, 12).map(normalizeAction) : [],
    recentSocialTargets: Array.isArray(context.recentSocialTargets) ? context.recentSocialTargets.slice(0, MAX_RECENT_SOCIAL_INTERACTIONS) : [],
    recentSocialTargetCounts: context.recentSocialTargetCounts || {},
    recoveryBlocks: Array.isArray(context.recoveryBlocks) ? context.recoveryBlocks.slice(0, 6).map(block => ({
      actionId: block.actionId || null,
      code: block.code || null,
      interruptedAction: block.interruptedAction || null,
      needValue: compactNumber(block.needValue),
      releaseBelow: compactNumber(block.releaseBelow),
      blockedActions: Array.isArray(block.blockedActions) ? block.blockedActions.slice(0, 8).map(normalizeAction) : []
    })) : [],
    allowedActionTypes: Array.isArray(context.allowedActionTypes) ? context.allowedActionTypes.slice(0, 64).map(normalizeAction) : [],
    candidateCount: Array.isArray(context.candidates) ? context.candidates.length : 0,
    candidates,
    activePlanStep: activePlanStep ? {
      id: activePlanStep.id || null,
      status: activePlanStep.status || null,
      actionType: normalizeAction(activePlanStep.actionType || activePlanStep.result?.actionType) || null
    } : null,
    explorationDestination: exploration ? {
      locationId: exploration.locationId || null,
      novelty: compactNumber(exploration.novelty),
      interest: compactNumber(exploration.interest),
      score: compactNumber(exploration.score),
      travelMinutes: compactNumber(exploration.travelMinutes)
    } : null,
    resourceContext: {
      currentResources: resourceContext.currentResources || resourceContext.localResources || {},
      blockedResources: resourceContext.blockedResources || {},
      actions: resourceActions
    },
    memoryPolicy: context.memoryPolicy ? {
      biases: context.memoryPolicy.biases || {}
    } : null,
    behavioralDriver: context.behavioralDriver || null,
    proactivity: {
      mode: proactivity.mode || null,
      driver: proactivity.driver || null,
      isProactive: Boolean(proactivity.isProactive),
      proactiveScore: compactNumber(proactivity.proactiveScore),
      priority: proactivity.priority || null,
      trigger: proactivity.trigger || null,
      previousAction: normalizeAction(proactivity.previousAction) || null,
      autonomous: Boolean(proactivity.autonomous),
      signals
    },
    development: developmentSnapshot,
    capabilityGate: context.capabilityGate ? {
      stage: context.capabilityGate.stage || null,
      allowedActionTypes: Array.isArray(context.capabilityGate.allowedActionTypes) ? context.capabilityGate.allowedActionTypes.slice(0, 64).map(normalizeAction) : [],
      decisionHorizon: Number.isFinite(Number(context.capabilityGate.decisionHorizon)) ? Number(context.capabilityGate.decisionHorizon) : null
    } : null,
    geminiTrigger: context.geminiTrigger ? {
      type: context.geminiTrigger.type || null,
      reason: compactString(context.geminiTrigger.reason, 240)
    } : null,
    geminiDecision: geminiSnapshot,
    aiChoice: aiSnapshot
  };
}


function criticalResourceNeedState(needs = []) {
  let highest = null;
  for (const code of ["THIRST", "HUNGER"]) {
    const need = needs.find(item => normalizeAction(item?.code) === code);
    if (!need) continue;
    const value = Number(need.value);
    const policy = CRITICAL_NEED_ACTIONS[code];
    if (!policy || !Number.isFinite(value) || value < policy.threshold) continue;
    const weight = Math.max(0.1, Number(need.priorityWeight || 1));
    const urgency = Math.min(
      1.5,
      1 + (value - policy.threshold) / Math.max(0.01, 1 - policy.threshold)
    ) * weight;
    const candidate = {
      code,
      value,
      threshold: policy.threshold,
      action: policy.action,
      resource: policy.resource,
      urgency
    };
    if (
      !highest ||
      candidate.urgency > highest.urgency ||
      (candidate.urgency === highest.urgency && candidate.value > highest.value)
    ) {
      highest = candidate;
    }
  }
  return highest;
}

function resolveCriticalResourceRecovery(context = {}) {
  const critical = criticalResourceNeedState(context.needs || []);
  if (!critical) return null;

  const candidates = Array.isArray(context.candidates) ? context.candidates : [];
  const resourceContext = context.resourceContext || {};
  const directAction = normalizeAction(critical.action);
  const resource = critical.resource;
  const localResources = resourceContext.localResources || {};
  const resourceActionContext = resourceContext.actions?.[directAction] || {};
  const localAvailable =
    Number(localResources[resource] ?? resourceActionContext.localAvailable ?? 0) >= 1;

  const directCandidate = candidates.find(
    candidate => normalizeAction(candidate.action) === directAction
  );

  if (localAvailable) {
    const emergency =
      resourceActionContext.emergency ||
      resourceContext.emergencyResources?.find?.(item =>
        item.resource === resource &&
        String(item.locationId || "") === String(resourceContext.currentLocationId || "")
      ) ||
      null;
    return {
      critical,
      mode: emergency ? "RESOURCE_EMERGENCY" : "DIRECT",
      candidate:
        directCandidate
          ? { ...directCandidate, recoveryBlocked: false, recoveryBlock: null, criticalRecovery: true, resourceEmergency: emergency }
          : {
              action: directAction,
              score: 0,
              criticalRecovery: true,
              resourceEmergency: emergency
            },
      selectedAction: directAction,
      emergency
    };
  }

  // Critical resource recovery outranks recovery blocks created by another
  // physiological state (for example ENERGY/SAFETY blocking WALKING).
  const walkingCandidate = candidates.find(
    candidate => normalizeAction(candidate.action) === "WALKING"
  );
  const nearest =
    resourceContext.nearestResources?.[resource] ||
    resourceActionContext.nearestLocation ||
    null;

  if (nearest?.locationId) {
    const emergency = resourceContext.emergencyResources?.find?.(item =>
      item.resource === resource &&
      String(item.locationId || "") === String(nearest.locationId || "")
    ) || null;
    const candidate = walkingCandidate
      ? { ...walkingCandidate, recoveryBlocked: false, recoveryBlock: null, criticalRecovery: true }
      : {
          action: "WALKING",
          score: 0,
          criticalRecovery: true
        };
    candidate.targetLocationId = nearest.locationId;
    candidate.resourceIntent = {
      ...(candidate.resourceIntent || {}),
      resource,
      reason: "CRITICAL_NEED_RESOURCE_RECOVERY",
      destinationLocationId: nearest.locationId,
      expectedTravelMinutes: Number.isFinite(Number(nearest.travelMinutes))
        ? Number(nearest.travelMinutes)
        : null
    };
    candidate.criticalRecovery = true;
    return {
      critical,
      mode: emergency ? "RESOURCE_EMERGENCY" : "ROUTING",
      candidate,
      selectedAction: "WALKING",
      emergency
    };
  }

  throw Object.assign(
    new Error(
      "Critical " + critical.code +
      " cannot be satisfied: no reachable " + resource +
      " resource is available"
    ),
    {
      code: "CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE",
      needCode: critical.code,
      resource,
      requiredAction: "WALKING"
    }
  );
}


function criticalProtectedActions(needs=[],resourceContext={}){
  const protectedActions=new Set();
  const critical=criticalNeedState(needs);
  if(critical?.action)protectedActions.add(normalizeAction(critical.action));
  const resourceCritical=criticalResourceNeedState(needs);
  if(resourceCritical){
    const resource=resourceCritical.resource;
    const action=normalizeAction(resourceCritical.action);
    const localAvailable=Number(resourceContext.localResources?.[resource] ?? resourceContext.actions?.[action]?.localAvailable ?? 0)>=1;
    if(localAvailable)protectedActions.add(action);
    // THIRST/HUNGER use WALKING as the resource-recovery action when the
    // resource is remote. Protect it even before route discovery succeeds.
    else protectedActions.add("WALKING");
  }
  return [...protectedActions];
}
function resolveCriticalDecisionRequirement(needs = [], recovery = null) {
  if (recovery?.critical) {
    return {
      needCode: normalizeAction(recovery.critical.code),
      requiredAction: normalizeAction(recovery.selectedAction),
      resource: recovery.critical.resource || null,
      targetLocationId: recovery.candidate?.targetLocationId || null,
      mode: recovery.mode
    };
  }

  const critical = criticalNeedState(needs);
  if (!critical) return null;

  return {
    needCode: normalizeAction(critical.code),
    requiredAction: normalizeAction(critical.action),
    resource: CRITICAL_NEED_ACTIONS[normalizeAction(critical.code)]?.resource || null,
    targetLocationId: null,
    mode: "DIRECT"
  };
}

function validateCriticalDecision(needs = [], actionType, targetLocationId = null, recovery = null) {
  const requirement = resolveCriticalDecisionRequirement(needs, recovery);
  if (!requirement) return null;

  const action = normalizeAction(actionType);
  if (action !== requirement.requiredAction) {
    throw Object.assign(
      new Error(
        "Critical need " + requirement.needCode +
        " requires " + requirement.requiredAction +
        " but decision selected " + action
      ),
      {
        code: "CRITICAL_DECISION_ACTION_MISMATCH",
        needCode: requirement.needCode,
        requiredAction: requirement.requiredAction,
        actualAction: action
      }
    );
  }

  if (
    ["ROUTING","RESOURCE_EMERGENCY"].includes(requirement.mode) &&
    requirement.targetLocationId &&
    String(targetLocationId || "") !== String(requirement.targetLocationId)
  ) {
    throw Object.assign(
      new Error(
        "Critical resource recovery for " + requirement.needCode +
        " must target " + requirement.targetLocationId
      ),
      {
        code: "CRITICAL_DECISION_TARGET_MISMATCH",
        needCode: requirement.needCode,
        requiredAction: requirement.requiredAction,
        expectedTargetLocationId: requirement.targetLocationId,
        actualTargetLocationId: targetLocationId || null
      }
    );
  }

  return requirement;
}

async function makeDecision({
  simulationId,
  entityId,
  simulationTime,
  triggerType = null,
  triggerEventId = null,
  context,
  aiChoice = null
}) {
  const decisionId = uuid();
  const baseCandidates = Array.isArray(context?.candidates) ? context.candidates : [];
  const proactivity = deriveProactivity(context);

  let candidates = applyProactiveOpportunityBias(
    baseCandidates.map(candidate => ({ ...candidate })),
    proactivity
  );
  candidates = applyPlanCommitment(candidates, context);
  candidates = applyExplorationCommitment(candidates, context);
  candidates = applySocialFeasibility(candidates, context, entityId);
  candidates = applySocialIsolationFallback(candidates, context);

  // Resolve critical resource recovery before recovery blocks so a block cannot
  // hide the action currently required to satisfy a critical physiological need.
  const criticalResourceRecovery = resolveCriticalResourceRecovery({
    ...context,
    candidates
  });
  const protectedActions = criticalProtectedActions(
    context?.needs || [],
    context?.resourceContext || {}
  );
  if (criticalResourceRecovery?.selectedAction)protectedActions.push(normalizeAction(criticalResourceRecovery.selectedAction));
  candidates = applyRecoveryBlocks(candidates,context?.recoveryBlocks || [],protectedActions);

  if (criticalResourceRecovery?.candidate) {
    const recoveryCandidate = criticalResourceRecovery.candidate;
    const recoveryAction = normalizeAction(recoveryCandidate.action);
    const recoveryTarget = recoveryCandidate.targetLocationId || null;
    const exists = candidates.some(candidate =>
      normalizeAction(candidate.action) === recoveryAction &&
      (!recoveryTarget || String(candidate.targetLocationId || "") === String(recoveryTarget))
    );
    if (!exists)candidates=[recoveryCandidate,...candidates];
  }

  const committed = resolvePlanCommitment({ ...context, candidates });
  const criticalRequirement = resolveCriticalDecisionRequirement(
    context?.needs || [],
    criticalResourceRecovery
  );
  const criticalAction = criticalRequirement?.requiredAction || null;
  const criticalNeedCode = criticalRequirement?.needCode || null;

  const aiAction = normalizeAction(aiChoice?.selectedActionType);
  const aiCandidate = candidates.find(
    candidate =>
      normalizeAction(candidate.action) === aiAction &&
      !candidate.recoveryBlocked
  );
  const aiHasSocialTarget =
    aiAction !== "TALKING" ||
    Boolean(aiChoice?.targetEntityId || aiCandidate?.targetEntityId);
  const validAiAction = Boolean(
    aiAction && ACTIONS.includes(aiAction) && aiHasSocialTarget
  );
  const aiBlockedByCritical = Boolean(
    criticalAction && aiAction && aiAction !== criticalAction
  );

  let chosenCandidate;
  let selectionMode;
  let selectedStrategy = null;
  let selectedPlanProposal = null;

  if (criticalResourceRecovery) {
    chosenCandidate = criticalResourceRecovery.candidate;
    selectionMode =
      criticalResourceRecovery.mode === "RESOURCE_EMERGENCY"
        ? "RESOURCE_EMERGENCY"
        : "CRITICAL_RESOURCE_RECOVERY";
  } else if (criticalAction) {
    const criticalCandidate = candidates.find(
      candidate =>
        normalizeAction(candidate.action) === criticalAction &&
        !candidate.recoveryBlocked
    );
    if (!criticalCandidate) {
      throw Object.assign(
        new Error("Critical action " + criticalAction + " is not executable in the current context"),
        {
          code: "CRITICAL_ACTION_UNAVAILABLE",
          requiredAction: criticalAction
        }
      );
    }
    chosenCandidate = criticalCandidate;
    selectionMode = "CRITICAL_NEED";
  } else if (committed) {
    chosenCandidate = committed.candidate;
    selectionMode = "PLAN_COMMITMENT";
  } else if (validAiAction && !aiBlockedByCritical) {
    chosenCandidate = aiCandidate || { action: aiAction, score: 0 };
    selectedStrategy = aiChoice?.strategy || null;
    selectedPlanProposal = aiChoice?.planProposal || null;
    selectionMode = "AI_DELIBERATION";
  } else {
    const certainty = Number(
      context?.cognitiveProfile?.mentalState?.certainty ?? 0.65
    );
    const temperature =
      BASE_TEMPERATURE + Math.max(0, Math.min(1, 1 - certainty)) * 0.20;
    chosenCandidate = chooseStochasticCandidate(candidates, { temperature });
    selectionMode = "STOCHASTIC_DETERMINISTIC";
  }

  const chosen = chosenCandidate.action;
  const decisionSource =
    selectionMode === "AI_DELIBERATION"
      ? "GEMINI"
      : context?.geminiDecision?.status === "FALLBACK"
        ? "DETERMINISTIC_FALLBACK"
        : "DETERMINISTIC";
  const selectedTargetEntityId =
    validAiAction &&
    !aiBlockedByCritical &&
    selectionMode === "AI_DELIBERATION"
      ? aiChoice?.targetEntityId || chosenCandidate.targetEntityId || null
      : chosenCandidate.targetEntityId || null;
  const selectedTargetLocationId =
    validAiAction &&
    !aiBlockedByCritical &&
    selectionMode === "AI_DELIBERATION"
      ? aiChoice?.targetLocationId || chosenCandidate.targetLocationId || null
      : chosenCandidate.targetLocationId || null;
  validateCriticalDecision(context?.needs || [], chosen, selectedTargetLocationId, criticalResourceRecovery);
  const needPriority = needPriorityState(context?.needs || []);
  const mysqlSimulationTime = effectiveSimulationTimeString(simulationTime);

  let reason;
  if (criticalResourceRecovery) {
    reason =
      (criticalResourceRecovery.mode === "RESOURCE_EMERGENCY"
        ? "RESOURCE_EMERGENCY: "
        : "critical resource recovery: ") +
      criticalResourceRecovery.critical.code +
      " -> " +
      chosen;
  } else if (criticalAction) {
    reason = "critical need: " + criticalAction;
  } else if (selectionMode === "PLAN_COMMITMENT") {
    reason =
      "active plan step: " +
      normalizeAction(
        context?.activePlanStep?.actionType ||
        context?.activePlanStep?.result?.actionType
      );
  } else if (selectionMode === "AI_DELIBERATION") {
    reason = aiChoice?.reason || "AI strategic deliberation";
  } else if (chosenCandidate.resourceIntent) {
    reason = "resource-driven routing: " + chosenCandidate.resourceIntent.resource;
  } else if (chosenCandidate.socialTarget) {
    reason =
      "social interaction with " +
      (chosenCandidate.targetName || chosenCandidate.targetEntityId);
  } else if (proactivity.priority !== "LOW") {
    reason =
      "proactive " +
      String(proactivity.signals[0]?.type || "state").toLowerCase() +
      "-driven decision";
  } else {
    reason = "deterministic needs, personality, experience and recent-action diversity";
  }

  await pool.query(
    `INSERT INTO decisions(id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,'CREATED',1)`,
    [
      decisionId,
      simulationId,
      entityId,
      mysqlSimulationTime,
      triggerEventId,
      triggerType || proactivity.trigger || proactivity.mode || "AUTONOMOUS",
      JSON.stringify(
        compactDecisionContext({
          ...context,
          proactivity,
          needPriority,
          selectionMode,
          chosenAction: chosen,
          criticalNeed: criticalNeedCode,
          criticalAction,
          criticalResourceRecovery: criticalResourceRecovery
            ? {
                code: criticalResourceRecovery.critical.code,
                resource: criticalResourceRecovery.critical.resource,
                mode: criticalResourceRecovery.mode,
                targetLocationId: criticalResourceRecovery.candidate?.targetLocationId || null
              }
            : null,
          individuality: individualityBias(entityId, chosen),
          candidates,
          aiChoice: aiChoice || null
        })
      )
    ]
  );

  const optionId = uuid();
  await pool.query(
    `INSERT INTO decision_options(id,decision_id,option_code,description,action_definition,evaluation,expected_outcome) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?, ?,?)`,
    [
      optionId,
      decisionId,
      chosen,
      "Autonomously selected " + chosen,
      JSON.stringify({
        actionType: chosen,
        targetEntityId: selectedTargetEntityId,
        targetLocationId: selectedTargetLocationId,
        strategy: selectedStrategy
      }),
      JSON.stringify({
        score: Number(chosenCandidate.score || 0),
        resourceIntent: chosenCandidate.resourceIntent || null,
        proactivity,
        aiAccepted:
          validAiAction &&
          !aiBlockedByCritical &&
          selectionMode === "AI_DELIBERATION",
        criticalNeed: criticalNeedCode,
        criticalAction,
        criticalResourceRecovery: criticalResourceRecovery
          ? {
              code: criticalResourceRecovery.critical.code,
              resource: criticalResourceRecovery.critical.resource,
              mode: criticalResourceRecovery.mode,
              targetLocationId: criticalResourceRecovery.candidate?.targetLocationId || null
            }
          : null,
        needPriority,
        selectionMode,
        planCommitted: selectionMode === "PLAN_COMMITMENT",
        socialTarget:
          selectedTargetEntityId && chosen === "TALKING"
            ? chosenCandidate.targetName || null
            : null
      }),
      JSON.stringify({
        actionType: chosen,
        targetEntityId: selectedTargetEntityId,
        targetLocationId: selectedTargetLocationId,
        strategy: selectedStrategy,
        planProposal: selectedPlanProposal
      })
    ]
  );

  await pool.query(
    `UPDATE decisions SET selected_option_id=UUID_TO_BIN(?),status='EVALUATED',expected_outcome=? WHERE id=UUID_TO_BIN(?)`,
    [
      optionId,
      JSON.stringify({
        actionType: chosen,
        targetEntityId: selectedTargetEntityId,
        targetLocationId: selectedTargetLocationId,
        strategy: selectedStrategy,
        planProposal: selectedPlanProposal
      }),
      decisionId
    ]
  );

  return {
    decisionId,
    actionType: chosen,
    targetEntityId: selectedTargetEntityId,
    targetLocationId: selectedTargetLocationId,
    strategy: selectedStrategy,
    planProposal: selectedPlanProposal,
    aiAccepted:
      validAiAction &&
      !aiBlockedByCritical &&
      selectionMode === "AI_DELIBERATION",
    selectionMode,
    decisionSource,
    geminiDecision: context.geminiDecision || null,
    reason,
    confidence:
      selectionMode === "AI_DELIBERATION"
        ? aiChoice?.confidence ?? 0.7
        : criticalResourceRecovery || criticalAction
          ? 0.92
          : Math.max(
              0.45,
              Math.min(
                0.92,
                0.55 +
                  Math.min(
                    0.35,
                    Math.max(
                      0,
                      Number(chosenCandidate.score || 0) -
                        Number(candidates[1]?.score || 0)
                    ) * 0.20
                  )
              )
            ),
    proactivity,
    needPriority
  };
}

function effectiveSimulationTimeString(value){const date=value instanceof Date?value:new Date(value);if(!Number.isFinite(date.getTime()))throw Object.assign(new Error("Invalid simulation time"),{code:"INVALID_SIMULATION_TIME"});const pad=n=>String(n).padStart(2,"0"),ms=String(date.getUTCMilliseconds()).padStart(3,"0");return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${ms}`;}
module.exports={ACTIONS,RESOURCE_REQUIREMENTS,scoreAction,buildDecisionContext,makeDecision,applyLocationBias,LOCATION_ACTION_BIAS,loadResourceContext,findNearestResourceLocation,shortestRoute,deriveProactivity,applyProactiveOpportunityBias,applyPlanCommitment,applyExplorationCommitment,applyRecoveryBlocks,criticalProtectedActions,recoveryBlockForInterruption,activeRecoveryBlocks,criticalNeedState,criticalNeedAction,criticalResourceNeedState,resolveCriticalResourceRecovery,resolveCriticalDecisionRequirement,validateCriticalDecision,applyRecentActionPenalty,individualityBias,chooseStochasticCandidate,resolvePlanCommitment,chooseSocialTargetCandidate,applySocialFeasibility,applySocialIsolationFallback,compactDecisionContext};
