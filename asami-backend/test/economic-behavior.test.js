"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {FOOD_PURCHASE_MIN_HUNGER,buildDecisionActivities,applyEconomicOpportunityBias,affordableWholeUnitQuantity}=require("../src/services/economic-behavior");
const {resolveCriticalResourceRecovery}=require("../src/services/decision-service");
const need=(code,value)=>({code,value,priorityWeight:1});
const activity=(action,score,options={})=>({action,score,targetLocationId:options.targetLocationId||null,activityDefinition:options.activityDefinition||{code:action,category:options.category||"ECONOMY",parameters:options.parameters||{}}});
test("global catalog does not expose location-specific economic actions",()=>{
 const catalog=[{code:"RESTING"},{code:"BUY_FOOD"},{code:"SELL_TOOLS"},{code:"WORK_JOB"},{code:"PRODUCE_GOODS"}];
 const local=[{code:"WORK_JOB",locationId:"workshop"},{code:"SELL_TOOLS",locationId:"market"}];
 assert.deepEqual(buildDecisionActivities(catalog,local).map(a=>a.code),["RESTING","WORK_JOB","SELL_TOOLS"]);
});
test("food buying requires hunger, no personal stock, and no better free-food option",()=>{
 const catalog=[{code:"EATING"},{code:"BUY_FOOD",parameters:{gate:["HUNGER",0.25]}}];
 const o={marketFoodLocation:{locationId:"market",travelMinutes:4},nearestFoodLocation:null,localFoodAvailable:0,hasPersonalFood:false,hungerLevel:FOOD_PURCHASE_MIN_HUNGER};
 const buy=buildDecisionActivities(catalog,[],o).find(a=>a.code==="BUY_FOOD");assert.ok(buy);
 assert.equal(buy.parameters.targetLocationId,"market");assert.equal(buy.parameters.destinationLocationId,"market");
 assert.equal(buildDecisionActivities(catalog,[],{...o,hasPersonalFood:true}).some(a=>a.code==="BUY_FOOD"),false);
 assert.equal(buildDecisionActivities(catalog,[],{...o,hungerLevel:0.2}).some(a=>a.code==="BUY_FOOD"),false);
 assert.equal(buildDecisionActivities(catalog,[],{...o,localFoodAvailable:1}).some(a=>a.code==="BUY_FOOD"),false);
 assert.equal(buildDecisionActivities(catalog,[],{...o,nearestFoodLocation:{locationId:"forage",travelMinutes:2}}).some(a=>a.code==="BUY_FOOD"),false);
});
test("moderate hunger biases food purchases while critical needs prevent economic bias",()=>{
 const c=[activity("EATING",1.2),activity("BUY_FOOD",1.45,{targetLocationId:"market"})],o={marketFoodLocation:{locationId:"market",travelMinutes:1},localFoodAvailable:0,hasPersonalFood:false};
 const normal=applyEconomicOpportunityBias(c,[need("HUNGER",0.5)],o);assert.ok(normal.find(a=>a.action==="BUY_FOOD").score>normal.find(a=>a.action==="EATING").score);
 assert.equal(applyEconomicOpportunityBias(c,[need("HUNGER",0.9)],o).find(a=>a.action==="BUY_FOOD").score,1.45);
});
test("workers alternate paid work and production, while critical needs take priority",()=>{
 const c=[activity("WORK_JOB",0.2,{targetLocationId:"workshop"}),activity("MAKE_TOOLS",0.3,{targetLocationId:"workshop",category:"PRODUCTION",activityDefinition:{code:"MAKE_TOOLS",category:"PRODUCTION",locationId:"workshop",parameters:{gate:["ACHIEVEMENT",0.25]}}})];
 const first=applyEconomicOpportunityBias(c,[need("ACHIEVEMENT",0.4)]),afterWork=applyEconomicOpportunityBias(c,[need("ACHIEVEMENT",0.4)],{recentActions:["WORK_JOB"]}),afterProduction=applyEconomicOpportunityBias(c,[need("ACHIEVEMENT",0.4)],{recentActions:["MAKE_TOOLS","WORK_JOB"]});
 assert.ok(first.find(a=>a.action==="WORK_JOB").score>0.2);assert.ok(afterWork.find(a=>a.action==="MAKE_TOOLS").score>afterWork.find(a=>a.action==="WORK_JOB").score);assert.ok(afterProduction.find(a=>a.action==="WORK_JOB").score>afterProduction.find(a=>a.action==="MAKE_TOOLS").score);
 const critical=applyEconomicOpportunityBias(c,[need("THIRST",0.9)]);assert.equal(critical.find(a=>a.action==="WORK_JOB").score,0.2);assert.equal(critical.find(a=>a.action==="MAKE_TOOLS").score,0.3);
});
test("wholesale quantity respects whole units and available cash",()=>{
 assert.equal(affordableWholeUnitQuantity({stockQuantity:2,marketBalance:5,unitPrice:2.88,maxQuantity:4}),1);
 assert.equal(affordableWholeUnitQuantity({stockQuantity:4,marketBalance:2.87,unitPrice:2.88,maxQuantity:4}),0);
 assert.equal(affordableWholeUnitQuantity({stockQuantity:0.8,marketBalance:5,unitPrice:1,maxQuantity:4}),0);
 assert.equal(affordableWholeUnitQuantity({stockQuantity:9,marketBalance:100,unitPrice:4,maxQuantity:4}),4);
 assert.equal(affordableWholeUnitQuantity({stockQuantity:1,marketBalance:5,unitPrice:0,maxQuantity:4}),0);
});
test("critical hunger routes to market and buys on arrival",()=>{
 const base={needs:[need("HUNGER",0.95)],entityId:"person",simulationTime:"2026-01-01T12:00:00Z",candidates:[activity("EATING",5),activity("WALKING",0.1),activity("BUY_FOOD",2,{targetLocationId:"market"})],resourceContext:{currentLocationId:"home",localResources:{food:0},nearestResources:{food:null},actions:{EATING:{localAvailable:0,nearestLocation:null}},marketFoodLocation:{locationId:"market",travelMinutes:8}}};
 const route=resolveCriticalResourceRecovery(base);assert.equal(route.selectedAction,"WALKING");assert.equal(route.mode,"ROUTING");assert.equal(route.candidate.targetLocationId,"market");assert.equal(route.candidate.resourceIntent.reason,"CRITICAL_NEED_MARKET_RECOVERY");
 const arrived=resolveCriticalResourceRecovery({...base,resourceContext:{...base.resourceContext,currentLocationId:"market"}});assert.equal(arrived.selectedAction,"BUY_FOOD");assert.equal(arrived.mode,"DIRECT");
});
