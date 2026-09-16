const ACTIONS = [
  "SLEEPING","EATING","DRINKING","TALKING","PLAYING","RESTING","STUDYING","READING","EXPLORING","WALKING","WORKING","WATCHING"
];

const actionNeeds={EATING:{HUNGER:2.4},DRINKING:{THIRST:2.8},TALKING:{SOCIAL_NEED:1.8,BELONGING:1.1},PLAYING:{FUN:1.6},STUDYING:{ACHIEVEMENT:.9,CURIOSITY:.5},READING:{CURIOSITY:.8,ACHIEVEMENT:.3},EXPLORING:{CURIOSITY:1.4},WALKING:{FUN:.3,CURIOSITY:.3},WORKING:{ACHIEVEMENT:1},WATCHING:{FUN:.9}};
const actionNeedGates={EATING:["HUNGER",.15],DRINKING:["THIRST",.25],TALKING:["SOCIAL_NEED",.12],PLAYING:["FUN",.18],STUDYING:["ACHIEVEMENT",.18],READING:["CURIOSITY",.18],EXPLORING:["CURIOSITY",.18],WORKING:["ACHIEVEMENT",.2]};
const CRITICAL_NEED_ACTIONS={THIRST:{action:"DRINKING",threshold:.8,maxBoost:1.6,resource:"water"},HUNGER:{action:"EATING",threshold:.8,maxBoost:1.4,resource:"food"},SLEEPINESS:{action:"SLEEPING",threshold:.85,maxBoost:1.5}};
const RESOURCE_REQUIREMENTS={EATING:{resource:"food",amount:1},DRINKING:{resource:"water",amount:1}};
const NEED_PRIORITY_THRESHOLDS={CRITICAL:{pressure:.8,safetyMax:.2,energyMax:.15},HIGH:{pressure:.6,safetyMax:.4,energyMax:.3},MEDIUM:{pressure:.35,safetyMax:.6,energyMax:.5}};

function needValue(needs,code){const need=needs.find(item=>item.code===code);return need?Number(need.value):0;}
function needWeight(needs,code){const need=needs.find(item=>item.code===code);return Number(need?.priorityWeight||1);}
function normalizeNeedCode(code){return String(code||"").trim().toUpperCase();}

function needPriorityState(needs=[]){
  const pressureCodes=["HUNGER","THIRST","SLEEPINESS","SOCIAL_NEED","FUN","CURIOSITY","ACHIEVEMENT","BELONGING"];
  let highest=null;
  for(const need of needs){
    const code=normalizeNeedCode(need.code),value=Number(need.value||0),weight=Math.max(0.1,Number(need.priorityWeight||1));
    let level="LOW";
    if(code==="SAFETY") level=value<=NEED_PRIORITY_THRESHOLDS.CRITICAL.safetyMax?"CRITICAL":value<=NEED_PRIORITY_THRESHOLDS.HIGH.safetyMax?"HIGH":value<=NEED_PRIORITY_THRESHOLDS.MEDIUM.safetyMax?"MEDIUM":"LOW";
    else if(code==="ENERGY") level=value<=NEED_PRIORITY_THRESHOLDS.CRITICAL.energyMax?"CRITICAL":value<=NEED_PRIORITY_THRESHOLDS.HIGH.energyMax?"HIGH":value<=NEED_PRIORITY_THRESHOLDS.MEDIUM.energyMax?"MEDIUM":"LOW";
    else if(pressureCodes.includes(code)) level=value>=NEED_PRIORITY_THRESHOLDS.CRITICAL.pressure?"CRITICAL":value>=NEED_PRIORITY_THRESHOLDS.HIGH.pressure?"HIGH":value>=NEED_PRIORITY_THRESHOLDS.MEDIUM.pressure?"MEDIUM":"LOW";
    const rank={LOW:0,MEDIUM:1,HIGH:2,CRITICAL:3}[level];
    const urgency=level==="CRITICAL"?1+value*0.25:level==="HIGH"?0.65+value*0.2:level==="MEDIUM"?0.3+value*0.15:value*0.1;
    const item={code,value,weight,level,rank,urgency:Math.min(1.5,urgency*weight)};
    if(!highest||item.rank>highest.rank||(item.rank===highest.rank&&item.urgency>highest.urgency)) highest=item;
  }
  return highest||{code:null,value:0,weight:1,level:"LOW",rank:0,urgency:0};
}

function actionNeedCodes(action){
  const direct=Object.keys(actionNeeds[action]||{});
  if(action==="SLEEPING") return ["SLEEPINESS","ENERGY"];
  if(action==="RESTING") return ["ENERGY","COMFORT"];
  return direct;
}

function actionPriorityState(action,needs=[]){
  const priority=needPriorityState(needs),codes=new Set(actionNeedCodes(action).map(normalizeNeedCode));
  const directlyServes=codes.has(priority.code);
  const criticalAlternative=priority.level==="CRITICAL"&&((priority.code==="THIRST"||priority.code==="HUNGER")&&action==="WALKING");
  if(priority.level==="CRITICAL") return { ...priority, servesPriorityNeed:directlyServes||criticalAlternative, multiplier:directlyServes?2.4:criticalAlternative?1.45:1 };
  if(priority.level==="HIGH") return { ...priority, servesPriorityNeed:directlyServes, multiplier:directlyServes?1.55:0.9 };
  if(priority.level==="MEDIUM") return { ...priority, servesPriorityNeed:directlyServes, multiplier:directlyServes?1.2:1 };
  return { ...priority, servesPriorityNeed:directlyServes, multiplier:1 };
}

function resourceModifier(action,resourceContext={}){const requirement=RESOURCE_REQUIREMENTS[action];if(!requirement)return 0;const localResources=resourceContext.localResources||{},available=Number(localResources[requirement.resource]??0),localBlocked=Boolean(resourceContext.blockedResources?.[requirement.resource]);if(available>=requirement.amount)return localBlocked?-.2:.08;const nearest=resourceContext.nearestResources?.[requirement.resource];if(!nearest)return-1.25;const travelMinutes=Number(nearest.travelMinutes),finiteTravel=Number.isFinite(travelMinutes)?travelMinutes:60,travelPenalty=Math.min(.55,Math.max(.05,finiteTravel/60*.45)),knowledgePenalty=localBlocked?.35:0;return-.55-travelPenalty-knowledgePenalty;}
function criticalNeedModifier(action,needs,resourceContext={}){for(const[code,policy]of Object.entries(CRITICAL_NEED_ACTIONS)){if(policy.action!==action)continue;const value=needValue(needs,code);if(!Number.isFinite(value)||value<=policy.threshold)return 0;if(policy.resource){const required=RESOURCE_REQUIREMENTS[action],available=Number(resourceContext.localResources?.[policy.resource]??0);if(!required||available<required.amount)return 0;}const urgency=Math.min(1,(value-policy.threshold)/(1-policy.threshold));return urgency*policy.maxBoost*needWeight(needs,code);}return 0;}

function scoreAction(action,needs,traits,resourceContext={}){
  const gate=actionNeedGates[action],gatedNeed=gate?needValue(needs,gate[0]):null;
  if(gate&&gatedNeed<gate[1])return 0;
  const priority=actionPriorityState(action,needs);
  let score=0;
  if(action==="SLEEPING"){const sleepiness=needValue(needs,"SLEEPINESS"),energy=needValue(needs,"ENERGY");score+=sleepiness*2*needWeight(needs,"SLEEPINESS");score+=(1-energy)*1.4*needWeight(needs,"ENERGY");if(sleepiness<.18&&energy>.72)score*=.15;}
  else if(action==="RESTING"){const energy=needValue(needs,"ENERGY"),comfort=needValue(needs,"COMFORT");if(energy>=.72&&comfort<.65)score=0;else{score+=Math.max(0,1-energy)*needWeight(needs,"ENERGY");score+=Math.max(0,.65-comfort)*.7*needWeight(needs,"COMFORT");if(energy>=.82)score*=.25;else if(energy>=.72)score*=.5;}}
  else for(const[code,weight]of Object.entries(actionNeeds[action]||{}))score+=needValue(needs,code)*weight*needWeight(needs,code);
  const traitMap=new Map(traits.map(item=>[item.code,Number(item.value)]));
  if(action==="TALKING")score+=((traitMap.get("EXTRAVERSION")||.5)+(traitMap.get("SOCIABILITY")||.5))*.2;
  if(action==="EXPLORING")score+=((traitMap.get("OPENNESS")||.5)+(traitMap.get("CURIOSITY")||.5))*.2;
  if(action==="STUDYING")score+=((traitMap.get("CONSCIENTIOUSNESS")||.5)+(traitMap.get("DISCIPLINE")||.5))*.2;
  if(action==="PLAYING")score+=(1-(traitMap.get("NEUROTICISM")||.5))*.1;
  if(action==="WORKING")score+=(traitMap.get("CONSCIENTIOUSNESS")||.5)*.25;
  score*=priority.multiplier;
  score+=criticalNeedModifier(action,needs,resourceContext);
  return Math.max(0,score+resourceModifier(action,resourceContext));
}

module.exports={ACTIONS,scoreAction,RESOURCE_REQUIREMENTS,criticalNeedModifier,needPriorityState,actionPriorityState};