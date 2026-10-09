"use strict";
const FOOD_PURCHASE_MIN_HUNGER = 0.35;
const CRITICAL = Object.freeze({HUNGER:0.8,THIRST:0.8,SLEEPINESS:0.9,ENERGY:0.15,SAFETY:0.12});
const DEFAULT_BUY_FOOD = Object.freeze({code:"BUY_FOOD",name:"Buy food",category:"ECONOMY",parameters:{code:"BUY_FOOD",name:"Buy food",category:"ECONOMY",goodCode:"FOOD",economicType:"BUY_GOOD",needWeights:{HUNGER:2.9},gate:["HUNGER",0.25],durationMinutes:25}});
function norm(v){return String(v||"").trim().toUpperCase();}
function obj(v){if(v&&typeof v==="object"&&!Array.isArray(v))return v;if(typeof v==="string"){try{const p=JSON.parse(v);return p&&typeof p==="object"&&!Array.isArray(p)?p:{};}catch{return {};}}return {};}
function need(needs,code){const n=Number((Array.isArray(needs)?needs:[]).find(x=>norm(x?.code)===code)?.value);return Number.isFinite(n)?n:0;}
function isScopedAction(code){const c=norm(code);return c==="WORK_JOB"||c==="PRODUCE_GOODS"||c.startsWith("BUY_")||c.startsWith("SELL_");}
function shouldOfferFoodPurchase({marketFoodLocation=null,nearestFoodLocation=null,localFoodAvailable=0,hasPersonalFood=false,hungerLevel=0}={}){
  if(!marketFoodLocation?.locationId||hasPersonalFood||Number(hungerLevel)<FOOD_PURCHASE_MIN_HUNGER||Number(localFoodAvailable)>=1)return false;
  if(!nearestFoodLocation?.locationId)return true;
  const market=Number(marketFoodLocation.travelMinutes),free=Number(nearestFoodLocation.travelMinutes);
  return Number.isFinite(market)&&Number.isFinite(free)&&market<=free;
}
function buildDecisionActivities(catalog=[],local=[],options={}){
  const globals=Array.isArray(catalog)?catalog:[],locals=Array.isArray(local)?local:[],byCode=new Map();
  // Global activity types are possible action templates, not proof of local access to a shop/job.
  for(const a of globals){const c=norm(a?.code);if(c&&!isScopedAction(c))byCode.set(c,a);}
  for(const a of locals){const c=norm(a?.code);if(c&&c!=="BUY_FOOD")byCode.set(c,a);}
  if(shouldOfferFoodPurchase(options)){
    const template=globals.find(a=>norm(a?.code)==="BUY_FOOD")||DEFAULT_BUY_FOOD;
    const loc=String(options.marketFoodLocation.locationId);
    byCode.set("BUY_FOOD",{...template,code:"BUY_FOOD",name:template.name||"Buy food",category:template.category||"ECONOMY",locationId:loc,
      parameters:{...obj(template.parameters),code:"BUY_FOOD",name:template.name||"Buy food",category:"ECONOMY",goodCode:"FOOD",economicType:"BUY_GOOD",targetLocationId:loc,destinationLocationId:loc}});
  }
  return [...byCode.values()];
}
function survivalCritical(needs){return need(needs,"HUNGER")>=CRITICAL.HUNGER||need(needs,"THIRST")>=CRITICAL.THIRST||need(needs,"SLEEPINESS")>=CRITICAL.SLEEPINESS||need(needs,"ENERGY")<=CRITICAL.ENERGY||need(needs,"SAFETY")<=CRITICAL.SAFETY;}
function candidateLocation(c){return c?.targetLocationId||c?.activityDefinition?.parameters?.targetLocationId||c?.activityDefinition?.locationId||c?.locationId||null;}
function category(c){return norm(c?.activityDefinition?.category||obj(c?.activityDefinition?.parameters).category);}
function gateSatisfied(c,needs){const p=obj(c?.activityDefinition?.parameters);const g=Array.isArray(p.gate)?p.gate:p.gate&&typeof p.gate==="object"?[p.gate.needCode,p.gate.min]:null;if(!g)return true;const n=Number(g[1]);return need(needs,norm(g[0]))>=(Number.isFinite(n)?n:0);}
function recentCodes(items){return(Array.isArray(items)?items:[]).map(x=>norm(x?.actionType||x)).filter(Boolean).slice(0,12);}
function applyEconomicOpportunityBias(candidates,needs=[],options={}){
  if(!Array.isArray(candidates)||!candidates.length)return candidates;
  const {marketFoodLocation=null,nearestFoodLocation=null,localFoodAvailable=0,hasPersonalFood=false,recentActions=[]}=options;
  const hunger=need(needs,"HUNGER"),achievement=need(needs,"ACHIEVEMENT"),critical=survivalCritical(needs),recent=recentCodes(recentActions);
  const production=candidates.filter(c=>["PRODUCTION","CRAFT"].includes(category(c))),productionCodes=new Set(production.map(c=>norm(c.action)));
  const workLocations=new Set(candidates.filter(c=>norm(c.action)==="WORK_JOB").map(candidateLocation).filter(Boolean).map(String));
  const last=recent.find(c=>c==="WORK_JOB"||productionCodes.has(c)),lastWasWork=last==="WORK_JOB",lastWasProduction=Boolean(last&&productionCodes.has(last));
  return candidates.map(c=>{
    if(c?.recoveryBlocked||c?.wanderingBlocked||critical)return c;
    const action=norm(c?.action);
    if(action==="BUY_FOOD"&&shouldOfferFoodPurchase({marketFoodLocation,nearestFoodLocation,localFoodAvailable,hasPersonalFood,hungerLevel:hunger})){
      return {...c,targetLocationId:String(marketFoodLocation.locationId),score:Math.max(0,Number(c.score)||0)+0.55+Math.min(0.65,hunger*0.6)};
    }
    let bonus=0;
    if(action==="WORK_JOB"&&candidateLocation(c))bonus=lastWasProduction?1.15:lastWasWork?0.08:0.75+Math.min(0.25,achievement*0.3);
    else if(workLocations.has(String(candidateLocation(c)||""))&&["PRODUCTION","CRAFT"].includes(category(c))&&gateSatisfied(c,needs))bonus=lastWasWork?1.0:lastWasProduction?0.05:0.65;
    return bonus>0?{...c,score:Math.max(0,Number(c.score)||0)+bonus}:c;
  });
}
function affordableWholeUnitQuantity({stockQuantity,marketBalance,unitPrice,maxQuantity=4}={}){
  const stock=Number(stockQuantity),balance=Number(marketBalance),price=Number(unitPrice),max=Number(maxQuantity);
  if(![stock,balance,price,max].every(Number.isFinite)||stock<1||balance<0||price<=0||max<1)return 0;
  return Math.max(0,Math.min(Math.floor(stock+1e-9),Math.floor((balance+1e-9)/price),Math.floor(max)));
}
module.exports={FOOD_PURCHASE_MIN_HUNGER,buildDecisionActivities,applyEconomicOpportunityBias,affordableWholeUnitQuantity,isScopedAction,shouldOfferFoodPurchase};
