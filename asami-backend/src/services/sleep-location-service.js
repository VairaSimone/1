const SLEEP_LOCATION_HIERARCHY=Object.freeze([
  {rank:0,label:"HOME"},
  {rank:1,label:"BEDROOM"},
  {rank:2,label:"SAFE_PLACE"},
  {rank:3,label:"OTHER"}
]);

const BEDROOM_TYPES=new Set(["BEDROOM"]);
const SAFE_PLACE_TYPES=new Set(["SAFE_PLACE","CLINIC","EMERGENT"]);
const SAFE_PLACE_OBJECTS=new Set(["SHELTER","BED","REST_AREA","SAFE_ROOM"]);

function normalize(value){return String(value||"").trim().toUpperCase();}
function parseJson(value,fallback={}) {
  if(value===null||value===undefined)return fallback;
  if(typeof value==="object")return value;
  try{return JSON.parse(value);}catch{return fallback;}
}
function locationCode(location){return normalize(location?.data?.worldCode||location?.worldCode||location?.locationType);}
function locationObjects(location){
  const value=location?.objects??location?.data?.objects;
  return Array.isArray(value)?value.map(normalize):[];
}
function sleepLocationRank(location){
  const type=normalize(location?.locationType);
  const code=locationCode(location);
  if(type==="HOME"||code==="HOME")return 0;
  if(BEDROOM_TYPES.has(type)||code==="BEDROOM"||locationObjects(location).some(value=>SAFE_PLACE_OBJECTS.has(value)&&value==="BED"))return 1;
  if(SAFE_PLACE_TYPES.has(type)||code==="SAFE_PLACE"||locationObjects(location).some(value=>SAFE_PLACE_OBJECTS.has(value)))return 2;
  return 3;
}
function sleepException(context={}){
  const policy=context?.sleepPolicy&&typeof context.sleepPolicy==="object"?context.sleepPolicy:{};
  const step=context?.activePlanStep?.result&&typeof context.activePlanStep.result==="object"?context.activePlanStep.result:{};
  const motivation=context?.goal?.motivation&&typeof context.goal.motivation==="object"
    ?context.goal.motivation
    :context?.activeGoal?.motivation&&typeof context.activeGoal.motivation==="object"
      ?context.activeGoal.motivation
      :{};
  const explicitReason=policy.reason||step.sleepExceptionReason||step.allowUnusualSleepReason||motivation.sleepExceptionReason||null;
  const allow=policy.allowUnusual===true||step.allowUnusualSleep===true||Boolean(explicitReason);
  return allow?{allowUnusual:true,reason:String(explicitReason||"contextual_sleep_reason")}:{allowUnusual:false,reason:null};
}

function reachableDistance(locations,originId,targetId){
  if(!originId||!targetId)return null;
  const byId=new Map((locations||[]).map(location=>[String(location.locationId),location]));
  const byCode=new Map((locations||[]).map(location=>[locationCode(location),location]).filter(([code])=>Boolean(code)));
  if(!byId.has(String(originId))||!byId.has(String(targetId)))return null;
  if(String(originId)===String(targetId))return 0;
  const queue=[[String(originId),0]],visited=new Set([String(originId)]);
  while(queue.length){
    const [id,distance]=queue.shift();
    const current=byId.get(id);
    const connections=Array.isArray(current?.data?.connections)?current.data.connections:[];
    for(const connection of connections){
      const next=byId.get(String(connection))||byCode.get(normalize(connection));
      if(!next)continue;
      const nextId=String(next.locationId);
      if(visited.has(nextId))continue;
      if(nextId===String(targetId))return distance+1;
      visited.add(nextId);
      queue.push([nextId,distance+1]);
    }
  }
  return null;
}

function resolvePreferredSleepLocation({
  locations=[],
  originId=null,
  context={}
}={}){
  const candidates=(Array.isArray(locations)?locations:[])
    .filter(location=>location?.locationId)
    .map(location=>({
      ...location,
      sleepRank:sleepLocationRank(location),
      graphDistance:reachableDistance(locations,originId,location.locationId)
    }))
    .filter(location=>location.graphDistance!==null);

  const exception=sleepException(context);
  if(exception.allowUnusual){
    return {
      targetLocationId:String(originId||candidates[0]?.locationId||""),
      rank:candidates.find(item=>String(item.locationId)===String(originId))?.sleepRank??3,
      category:candidates.find(item=>String(item.locationId)===String(originId))?.sleepRank===0?"HOME":"OTHER",
      reason:exception.reason,
      allowUnusual:true,
      fallback:false
    };
  }

  const ranked=candidates
    .slice()
    .sort((a,b)=>{
      if(a.sleepRank!==b.sleepRank)return a.sleepRank-b.sleepRank;
      if(a.graphDistance!==b.graphDistance)return a.graphDistance-b.graphDistance;
      return String(a.locationId).localeCompare(String(b.locationId));
    });
  const selected=ranked[0];
  if(selected){
    const category=SLEEP_LOCATION_HIERARCHY[selected.sleepRank]?.label||"OTHER";
    return {
      targetLocationId:String(selected.locationId),
      rank:selected.sleepRank,
      category,
      reason:selected.sleepRank===0?"HOME_PREFERRED":selected.sleepRank===1?"BEDROOM_PREFERRED":selected.sleepRank===2?"SAFE_PLACE_FALLBACK":"NO_PREFERRED_SLEEP_LOCATION",
      allowUnusual:false,
      fallback:selected.sleepRank>=3
    };
  }

  return {
    targetLocationId:originId?String(originId):null,
    rank:3,
    category:"OTHER",
    reason:"NO_REACHABLE_SLEEP_LOCATION",
    allowUnusual:false,
    fallback:true
  };
}

module.exports={
  SLEEP_LOCATION_HIERARCHY,
  sleepLocationRank,
  sleepException,
  reachableDistance,
  resolvePreferredSleepLocation
};
