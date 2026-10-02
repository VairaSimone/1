const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { persistNeedTransition } = require("./state-service");
const logger = require("../lib/logger");

const KINDS = new Set(["STRUCTURE","INSTITUTION","ACTIVITY","SYSTEM"]);
const EFFECT_TYPES = new Set(["NEED_DELTA","RESOURCE_DELTA","INVENTORY_DELTA","PRODUCTION"]);
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_EFFECTS = 4;
const MAX_ACTIVITIES = 6;
const MAX_ABS_NEED_DELTA = 0.45;
const MAX_RESOURCE_DELTA = 5;
const MAX_INVENTORY_DELTA = 3;

function parseJson(value, fallback={}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalize(value) { return String(value || "").trim().toUpperCase(); }
function clamp(value,min=0,max=1) {
  const n=Number(value);
  return Number.isFinite(n)?Math.max(min,Math.min(max,n)):min;
}
function code(value) { return normalize(value).replace(/\s+/g,"_"); }

function sanitizeText(value,max,fallback="") {
  const text=String(value || "").replace(/[\u0000-\u001f]/g," ").trim().replace(/\s+/g," ");
  return text.slice(0,max) || fallback;
}

function normalizeEffect(effect) {
  const item=effect && typeof effect==="object" ? effect : {};
  const type=normalize(item.type);
  if(type==="NEED_DELTA"){
    return { type, needCode:code(item.needCode), delta:Number(item.delta) };
  }
  if(type==="RESOURCE_DELTA"){
    return { type, resource:String(item.resource||"").trim().toLowerCase(), delta:Number(item.delta) };
  }
  if(type==="INVENTORY_DELTA"){
    return { type, goodCode:code(item.goodCode), delta:Number(item.delta) };
  }
  if(type==="PRODUCTION"){
    const resourceInputs={};
    for(const [key,value] of Object.entries(item.resourceInputs||{}).slice(0,8)){
      const n=Number(value), resource=String(key||"").trim().toLowerCase();
      if(Number.isFinite(n)&&n>0&&n<=5)resourceInputs[resource]=Number(n.toFixed(4));
    }
    const inventoryInputs={};
    for(const [key,value] of Object.entries(item.inventoryInputs||{}).slice(0,8)){
      const n=Number(value), good=code(key);
      if(Number.isFinite(n)&&n>0&&n<=5)inventoryInputs[good]=Number(n.toFixed(4));
    }
    return {
      type,
      goodCode:code(item.goodCode),
      quantity:Number(item.quantity),
      resourceInputs,
      inventoryInputs
    };
  }
  return { type };
}

function normalizeActivity(activity) {
  const item=activity && typeof activity==="object" ? activity : {};
  const needWeights={};
  if(item.needWeights && typeof item.needWeights==="object"){
    for(const [k,v] of Object.entries(item.needWeights).slice(0,8)){
      const n=Number(v);
      if(CODE_RE.test(code(k)) && Number.isFinite(n) && n>=-3 && n<=3) needWeights[code(k)]=Number(n.toFixed(4));
    }
  }
  const gate=item.gate && typeof item.gate==="object"
    ? { needCode:code(item.gate.needCode), min:Number(item.gate.min) }
    : null;
  return {
    code:code(item.code),
    name:sanitizeText(item.name,120,code(item.code).replaceAll("_"," ").toLowerCase()),
    category:sanitizeText(item.category,48,"EMERGENT").toUpperCase(),
    durationMinutes:Number(item.durationMinutes),
    needWeights,
    gate,
    effects:Array.isArray(item.effects)?item.effects.slice(0,MAX_EFFECTS).map(normalizeEffect):[]
  };
}

function normalizeDefinition(definition={}) {
  const source=definition && typeof definition==="object"?definition:{};
  const activities=Array.isArray(source.activities)?source.activities.slice(0,MAX_ACTIVITIES).map(normalizeActivity):[];
  const resourceCosts={};
  if(source.resourceCosts && typeof source.resourceCosts==="object"){
    for(const [k,v] of Object.entries(source.resourceCosts).slice(0,8)){
      const n=Number(v);
      const resource=String(k||"").trim().toLowerCase();
      if(CODE_RE.test(code(k)) && Number.isFinite(n) && n>=0 && n<=50)resourceCosts[resource]=Number(n.toFixed(3));
    }
  }
  const products=Array.isArray(source.products)
    ?source.products.slice(0,3).map(item=>({
      code:code(item?.code),
      name:sanitizeText(item?.name,120,code(item?.code).replaceAll("_"," ").toLowerCase()),
      category:sanitizeText(item?.category,48,"PRODUCT").toUpperCase(),
      unit:sanitizeText(item?.unit,24,"unit"),
      basePrice:Number(item?.basePrice)
    })).filter(item=>CODE_RE.test(item.code)&&item.name.length>=3&&Number.isFinite(item.basePrice)&&item.basePrice>0&&item.basePrice<=100)
    : [];
  return {
    schemaVersion:2,
    kind:normalize(source.kind),
    code:code(source.code),
    name:sanitizeText(source.name,160,code(source.code).replaceAll("_"," ").toLowerCase()),
    category:sanitizeText(source.category,64,"EMERGENT").toUpperCase(),
    purpose:sanitizeText(source.purpose,600,"A new social possibility proposed by inhabitants."),
    activities,
    products,
    resourceCosts,
    targetNeeds:Array.isArray(source.targetNeeds)
      ?source.targetNeeds.slice(0,8).map(item=>({code:code(item?.code),weight:Number(item?.weight)}))
        .filter(item=>CODE_RE.test(item.code)&&Number.isFinite(item.weight)&&item.weight>=-3&&item.weight<=3)
      : [],
    formation:sanitizeText(source.formation,120,"BOTTOM_UP"),
    membership:sanitizeText(source.membership,120,"VOLUNTARY"),
    origin:sanitizeText(source.origin,64,"AGENT_PROPOSAL")
  };
}

async function loadActiveNeedCodes(simulationId) {
  const [rows]=await pool.query(
    `SELECT nd.code FROM need_definitions nd WHERE nd.active=1`
  );
  return new Set(rows.map(row=>code(row.code)));
}

async function loadKnownGoodCodes(simulationId) {
  const [rows]=await pool.query(
    `SELECT code FROM emergent_goods WHERE simulation_id=UUID_TO_BIN(?)`,
    [simulationId]
  );
  return new Set(rows.map(row=>code(row.code)));
}

async function existingDefinition(simulationId,kind,definitionCode) {
  const [rows]=await pool.query(
    `SELECT id,code,status FROM emergent_definition_catalog
     WHERE simulation_id=UUID_TO_BIN(?) AND kind=? AND code=? LIMIT 1`,
    [simulationId,kind,definitionCode]
  );
  return rows[0]||null;
}

async function validateDefinition(simulationId,definition,{scopeLocationId=null,localResources={},proposerCount=0}={}) {
  const normalized=normalizeDefinition(definition);
  const errors=[],warnings=[];
  if(!KINDS.has(normalized.kind))errors.push("UNSUPPORTED_KIND");
  if(!CODE_RE.test(normalized.code))errors.push("INVALID_CODE");
  if(normalized.name.length<3||normalized.name.length>160)errors.push("INVALID_NAME");
  if(!normalized.purpose)errors.push("MISSING_PURPOSE");
  if(normalized.activities.length>MAX_ACTIVITIES)errors.push("TOO_MANY_ACTIVITIES");
  if(["STRUCTURE","INSTITUTION","SYSTEM"].includes(normalized.kind)&&normalized.activities.length===0)errors.push("NO_ACTIVITIES");
  if(normalized.kind==="ACTIVITY"&&normalized.activities.length!==1)errors.push("ACTIVITY_KIND_REQUIRES_ONE_ACTIVITY");

  const existing=await existingDefinition(simulationId,normalized.kind,normalized.code);
  if(existing)errors.push("CODE_ALREADY_EXISTS");

  const [activityRows]=await pool.query(
    `SELECT code FROM activity_types WHERE active=1`
  );
  const knownActivityCodes=new Set(activityRows.map(row=>code(row.code)));
  const knownEmergentActivities=new Set(
    (await pool.query(`SELECT code FROM emergent_definition_catalog WHERE simulation_id=UUID_TO_BIN(?) AND kind='ACTIVITY' AND status='ACTIVE'`,[simulationId]))[0]
      .map(row=>code(row.code))
  );
  const needCodes=await loadActiveNeedCodes(simulationId);
  const goodCodes=await loadKnownGoodCodes(simulationId);
  const proposalGoodCodes=new Set(normalized.products.map(product=>product.code));
  const effectiveGoodCodes=new Set([...goodCodes,...proposalGoodCodes]);
  const seenActivities=new Set();

  if(normalized.kind==="ACTIVITY"){
    normalized.activities[0].code=normalized.code;
  }

  for(const activity of normalized.activities){
    if(!CODE_RE.test(activity.code))errors.push("INVALID_ACTIVITY_CODE");
    if(seenActivities.has(activity.code))errors.push("DUPLICATE_ACTIVITY_CODE");
    seenActivities.add(activity.code);
    if(knownActivityCodes.has(activity.code)||knownEmergentActivities.has(activity.code)){
      errors.push("ACTIVITY_CODE_ALREADY_EXISTS");
    }
    if(!Number.isFinite(activity.durationMinutes)||activity.durationMinutes<5||activity.durationMinutes>720)errors.push("INVALID_ACTIVITY_DURATION");
    if(Object.keys(activity.needWeights).length>8)errors.push("TOO_MANY_NEED_WEIGHTS");
    if(activity.gate){
      if(!needCodes.has(activity.gate.needCode)||!Number.isFinite(activity.gate.min)||activity.gate.min<0||activity.gate.min>1)errors.push("INVALID_ACTIVITY_GATE");
    }
    if(!Array.isArray(activity.effects)||activity.effects.length===0)errors.push("ACTIVITY_HAS_NO_EFFECTS");
    if(activity.effects.length>MAX_EFFECTS)errors.push("TOO_MANY_EFFECTS");
    for(const effect of activity.effects){
      if(!EFFECT_TYPES.has(effect.type)){errors.push("UNSUPPORTED_EFFECT");continue;}
      if(effect.type==="NEED_DELTA"){
        if(!needCodes.has(effect.needCode))errors.push("UNKNOWN_NEED");
        if(!Number.isFinite(effect.delta)||Math.abs(effect.delta)>MAX_ABS_NEED_DELTA)errors.push("INVALID_NEED_DELTA");
      }else if(effect.type==="RESOURCE_DELTA"){
        if(!effect.resource||!CODE_RE.test(code(effect.resource)))errors.push("INVALID_RESOURCE");
        if(!Number.isFinite(effect.delta)||Math.abs(effect.delta)>MAX_RESOURCE_DELTA)errors.push("INVALID_RESOURCE_DELTA");
        if(Number(effect.delta)>0)errors.push("RESOURCE_CREATION_FORBIDDEN");
      }else if(effect.type==="INVENTORY_DELTA"){
        if(!effectiveGoodCodes.has(effect.goodCode))errors.push("UNKNOWN_GOOD");
        if(!Number.isFinite(effect.delta)||Math.abs(effect.delta)>MAX_INVENTORY_DELTA)errors.push("INVALID_INVENTORY_DELTA");
      }else if(effect.type==="PRODUCTION"){
        if(!effectiveGoodCodes.has(effect.goodCode))errors.push("UNKNOWN_PRODUCED_GOOD");
        if(!Number.isFinite(effect.quantity)||effect.quantity<=0||effect.quantity>5)errors.push("INVALID_PRODUCTION_QUANTITY");
        const resourceInputs=effect.resourceInputs||{},inventoryInputs=effect.inventoryInputs||{};
        if(!Object.keys(resourceInputs).length&&!Object.keys(inventoryInputs).length)errors.push("PRODUCTION_REQUIRES_INPUT");
        for(const [resource,input] of Object.entries(resourceInputs)){
          if(!/^[a-z0-9_]{1,64}$/.test(resource))errors.push("INVALID_PRODUCTION_RESOURCE");
          if(!Number.isFinite(Number(input))||Number(input)<=0||Number(input)>5)errors.push("INVALID_PRODUCTION_RESOURCE_INPUT");
          if(Number(localResources?.[resource]||0)<Number(input))errors.push("INSUFFICIENT_PRODUCTION_RESOURCE_"+resource);
        }
        for(const [good,input] of Object.entries(inventoryInputs)){
          if(!effectiveGoodCodes.has(good))errors.push("UNKNOWN_PRODUCTION_INPUT_GOOD");
          if(!Number.isFinite(Number(input))||Number(input)<=0||Number(input)>5)errors.push("INVALID_PRODUCTION_INVENTORY_INPUT");
        }
      }
    }
  }

  const totalResourceCost=Object.values(normalized.resourceCosts).reduce((sum,value)=>sum+Number(value||0),0);
  const availableResourceTotal=Object.values(localResources||{}).reduce((sum,value)=>sum+Math.max(0,Number(value||0)),0);
  for(const [resource,costValue] of Object.entries(normalized.resourceCosts||{})){
    const available=Number(localResources?.[resource]||0);
    if(available<Number(costValue||0))errors.push("INSUFFICIENT_LOCAL_RESOURCE_"+resource);
  }
  if(totalResourceCost>0 && availableResourceTotal<totalResourceCost)errors.push("INSUFFICIENT_LOCAL_RESOURCES");

  for(const activity of normalized.activities){
    const effects=activity.effects||[];
    const positiveInventory=effects.some(effect=>effect.type==="INVENTORY_DELTA" && Number(effect.delta)>0);
    const hasInput=effects.some(effect =>
      (effect.type==="INVENTORY_DELTA" && Number(effect.delta)<0) ||
      (effect.type==="RESOURCE_DELTA" && Number(effect.delta)<0)
    );
    if(positiveInventory && !hasInput)errors.push("INVENTORY_CREATION_REQUIRES_INPUT");
  }

  for(const [resource,costValue] of Object.entries(normalized.resourceCosts||{})){
    const consumed=normalized.activities
      .flatMap(activity=>activity.effects||[])
      .filter(effect=>effect.type==="RESOURCE_DELTA" && String(effect.resource||"").toLowerCase()===resource)
      .reduce((sum,effect)=>sum+Math.max(0,-Number(effect.delta||0)),0);
    if(consumed+1e-9<Number(costValue||0))errors.push("DECLARED_RESOURCE_COST_NOT_BACKED_BY_EFFECT_"+resource);
  }

  const minimumSupport=Math.max(3,Math.ceil(Math.max(0,Number(proposerCount)||0)*0.35));
  if(["STRUCTURE","INSTITUTION","SYSTEM"].includes(normalized.kind) && !scopeLocationId)errors.push("SCOPE_LOCATION_REQUIRED");
  if(["STRUCTURE","INSTITUTION","SYSTEM"].includes(normalized.kind) && proposerCount<minimumSupport)errors.push("INSUFFICIENT_SUPPORT_BASE");

  const valid=errors.length===0;
  return {
    valid,
    errors:[...new Set(errors)],
    warnings:[...new Set(warnings)],
    definition:normalized,
    limits:{maxActivities:MAX_ACTIVITIES,maxEffects:MAX_EFFECTS,maxNeedDelta:MAX_ABS_NEED_DELTA},
    feasibility:{scopeLocationId:scopeLocationId||null,proposerCount:Number(proposerCount||0),minimumSupport,totalResourceCost,availableResourceTotal},
    knownActivityCodes:[...new Set([...knownActivityCodes,...knownEmergentActivities])]
  };
}

async function registerDefinition(simulationId,{kind,definition,scopeLocationId=null,originEntityId=null,originProposalId=null,simulationTime}) {
  const normalized=normalizeDefinition({...definition,kind});
  const id=uuid();
  await pool.query(
    `INSERT INTO emergent_definition_catalog
      (id,simulation_id,kind,code,name,category,scope_location_id,origin_entity_id,origin_proposal_id,definition,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,
    [
      id,simulationId,normalized.kind,normalized.code,normalized.name,normalized.category,
      scopeLocationId||null,originEntityId||null,originProposalId||null,JSON.stringify(normalized),
      simulationTime,simulationTime
    ]
  );
  return id;
}

async function applyNeedEffect({conn,entityId,actionId,simulationTime,effect}) {
  const [rows]=await conn.query(
    `SELECT BIN_TO_UUID(enc.need_id) needId,enc.value,enc.version
       FROM entity_needs_current enc
       JOIN need_definitions nd ON nd.id=enc.need_id
      WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.code=? AND nd.active=1
      LIMIT 1 FOR UPDATE`,
    [entityId,effect.needCode]
  );
  if(!rows.length)return {ok:false,failureReason:"NEED_NOT_AVAILABLE",effect};
  const row=rows[0],oldValue=Number(row.value);
  const nextValue=clamp(oldValue+Number(effect.delta),0,1);
  const transition=await persistNeedTransition({
    entityId,needId:row.needId,code:effect.needCode,oldValue,nextValue,version:row.version,
    simulationTime,causeActionId:actionId,significant:true,db:conn
  });
  if(!transition)return {ok:false,failureReason:"NEED_EFFECT_NOT_PERSISTED",effect};
  return {ok:true,effect:{...effect,oldValue,newValue:nextValue,appliedDelta:Number((nextValue-oldValue).toFixed(5))}};
}

async function applyResourceEffect({conn,simulationId,entityId,simulationTime,locationId,effect}) {
  const [rows]=await conn.query(
    `SELECT attributes,version FROM entities WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
    [locationId,simulationId]
  );
  if(!rows.length)return {ok:false,failureReason:"LOCATION_NOT_FOUND",effect};
  const attributes=parseJson(rows[0].attributes,{});
  const resources={...(attributes.resources||{})};
  const before=Number(resources[effect.resource]||0);
  const after=before+Number(effect.delta);
  if(after<0)return {ok:false,failureReason:"LOCAL_RESOURCE_UNAVAILABLE",effect,available:before};
  resources[effect.resource]=Number(after.toFixed(4));
  const [updated]=await conn.query(
    `UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?`,
    [JSON.stringify({...attributes,resources}),locationId,simulationId,Number(rows[0].version||1)]
  );
  if(!updated.affectedRows)return {ok:false,failureReason:"LOCATION_UPDATE_CONFLICT",effect};
  return {ok:true,effect:{...effect,oldValue:before,newValue:after}};
}

async function applyInventoryEffect({conn,simulationId,entityId,simulationTime,effect}) {
  const [rows]=await conn.query(
    `SELECT id,quantity FROM emergent_inventory
      WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=?
      LIMIT 1 FOR UPDATE`,
    [simulationId,entityId,effect.goodCode]
  );
  const before=Number(rows[0]?.quantity||0),after=before+Number(effect.delta);
  if(after<0)return {ok:false,failureReason:"INVENTORY_UNAVAILABLE",effect,available:before};
  if(rows.length){
    await conn.query(
      `UPDATE emergent_inventory SET quantity=?,updated_simulation_at=?,version=version+1 WHERE id=?`,
      [after,simulationTime,rows[0].id]
    );
  }else{
    await conn.query(
      `INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)`,
      [uuid(),simulationId,entityId,effect.goodCode,after,simulationTime]
    );
  }
  return {ok:true,effect:{...effect,oldValue:before,newValue:after}};
}

async function applyProductionEffect({conn,simulationId,entityId,simulationTime,locationId,effect}) {
  const [structureRows]=await conn.query(
    "SELECT BIN_TO_UUID(es.entity_id) producerEntityId FROM emergent_structures es " +
    "WHERE es.simulation_id=UUID_TO_BIN(?) AND es.scope_location_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
    [simulationId,locationId]
  );
  const producerEntityId=structureRows[0]?.producerEntityId;
  if(!producerEntityId)return {ok:false,failureReason:"NO_PRODUCTION_STRUCTURE",effect};

  const resourceInputs=effect.resourceInputs||{};
  const inventoryInputs=effect.inventoryInputs||{};

  for(const [resource,input] of Object.entries(resourceInputs)){
    const [locationRows]=await conn.query(
      "SELECT attributes,version FROM entities WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
      [locationId,simulationId]
    );
    if(!locationRows.length)return {ok:false,failureReason:"LOCATION_NOT_FOUND",effect};
    const attributes=parseJson(locationRows[0].attributes,{});
    const resources={...(attributes.resources||{})};
    const available=Number(resources[resource]||0);
    if(available<Number(input))return {ok:false,failureReason:"PRODUCTION_RESOURCE_UNAVAILABLE",resource,available,required:Number(input),effect};
    resources[resource]=Number((available-Number(input)).toFixed(4));
    const [updated]=await conn.query(
      "UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND version=?",
      [JSON.stringify({...attributes,resources}),locationId,simulationId,Number(locationRows[0].version||1)]
    );
    if(!updated.affectedRows)return {ok:false,failureReason:"LOCATION_UPDATE_CONFLICT",effect};
  }

  for(const [good,input] of Object.entries(inventoryInputs)){
    const [rows]=await conn.query(
      "SELECT id,quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE",
      [simulationId,producerEntityId,good]
    );
    const available=Number(rows[0]?.quantity||0);
    if(available<Number(input))return {ok:false,failureReason:"PRODUCTION_INPUT_GOOD_UNAVAILABLE",goodCode:good,available,required:Number(input),effect};
    await conn.query("UPDATE emergent_inventory SET quantity=quantity-?,updated_simulation_at=?,version=version+1 WHERE id=?",
      [Number(input),simulationTime,rows[0].id]);
  }

  const [outputRows]=await conn.query(
    "SELECT id,quantity FROM emergent_inventory WHERE simulation_id=UUID_TO_BIN(?) AND owner_entity_id=UUID_TO_BIN(?) AND good_code=? LIMIT 1 FOR UPDATE",
    [simulationId,producerEntityId,effect.goodCode]
  );
  const output=Number(effect.quantity);
  if(outputRows.length){
    await conn.query("UPDATE emergent_inventory SET quantity=quantity+?,updated_simulation_at=?,version=version+1 WHERE id=?",
      [output,simulationTime,outputRows[0].id]);
  }else{
    await conn.query(
      "INSERT INTO emergent_inventory(id,simulation_id,owner_entity_id,good_code,quantity,updated_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,1)",
      [uuid(),simulationId,producerEntityId,effect.goodCode,output,simulationTime]
    );
  }

  return {ok:true,effect:{...effect,producerEntityId,outputQuantity:output}};
}

async function executeDynamicActivity({conn,simulationId,entityId,actionId,actionType,simulationTime,targetLocationId=null}) {
  const normalizedAction=code(actionType);
  await conn.query("SAVEPOINT dynamic_activity_effects");

  const [locationRows]=await conn.query(
    "SELECT BIN_TO_UUID(location_id) locationId FROM entity_locations_current " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1",
    [simulationId,entityId]
  );
  const currentLocationId=locationRows[0]?.locationId||null;
  if(!currentLocationId){
    await conn.query("ROLLBACK TO SAVEPOINT dynamic_activity_effects");
    return {ok:false,failureReason:"NO_CURRENT_LOCATION"};
  }
  if(targetLocationId && String(targetLocationId)!==String(currentLocationId)){
    await conn.query("ROLLBACK TO SAVEPOINT dynamic_activity_effects");
    return {ok:false,failureReason:"DYNAMIC_ACTION_LOCATION_MISMATCH"};
  }

  const [rows]=await conn.query(
    "SELECT BIN_TO_UUID(wc.location_id) locationId,wc.parameters,wc.name,wc.category " +
    "FROM world_capabilities wc WHERE wc.simulation_id=UUID_TO_BIN(?) AND wc.code=? AND wc.active=1 " +
    "AND wc.location_id=UUID_TO_BIN(?) LIMIT 1",
    [simulationId,normalizedAction,currentLocationId]
  );
  if(!rows.length){
    await conn.query("ROLLBACK TO SAVEPOINT dynamic_activity_effects");
    return {ok:false,failureReason:"DYNAMIC_CAPABILITY_NOT_AVAILABLE"};
  }

  const definition=parseJson(rows[0].parameters,{});
  const effects=Array.isArray(definition.effects)
    ?definition.effects.map(normalizeEffect)
    :Array.isArray(definition.effect)
      ?definition.effect.map(normalizeEffect)
      :[];

  if(!effects.length){
    await conn.query("RELEASE SAVEPOINT dynamic_activity_effects");
    return {ok:true,dynamicActivity:true,activityCode:normalizedAction,effects:[],locationId:currentLocationId};
  }

  const effectResults=[];
  for(const effect of effects){
    let result=null;
    if(effect.type==="NEED_DELTA")result=await applyNeedEffect({conn,entityId,actionId,simulationTime,effect});
    else if(effect.type==="RESOURCE_DELTA")result=await applyResourceEffect({conn,simulationId,entityId,simulationTime,locationId:currentLocationId,effect});
    else if(effect.type==="INVENTORY_DELTA")result=await applyInventoryEffect({conn,simulationId,entityId,simulationTime,effect});
    else if(effect.type==="PRODUCTION")result=await applyProductionEffect({conn,simulationId,entityId,simulationTime,locationId:currentLocationId,effect});

    if(!result)continue;
    if(!result.ok){
      await conn.query("ROLLBACK TO SAVEPOINT dynamic_activity_effects");
      return {ok:false,failureReason:result.failureReason||"DYNAMIC_EFFECT_FAILED",effect,result};
    }
    effectResults.push(result.effect);
  }

  await conn.query("RELEASE SAVEPOINT dynamic_activity_effects");
  return {ok:true,dynamicActivity:true,activityCode:normalizedAction,effects:effectResults,locationId:currentLocationId};
}
async function createDynamicEvent({conn,simulationId,entityId,actionType,simulationTime,effectResults,locationId}) {
  const eventId=await require("./event-service").createEvent({
    simulationId,eventTypeCode:"PERSONAL",
    title:"Performed "+String(actionType).replaceAll("_"," ").toLowerCase(),
    description:"An emergent activity produced a persistent consequence in the world.",
    simulationAt:simulationTime,importance:.46,
    metadata:{emergent:true,kind:"DYNAMIC_ACTIVITY_EXECUTED",actionType,effects:effectResults,locationId},
    participants:[{entityId,role:"ACTOR"}]
  });
  return eventId;
}

module.exports={
  KINDS,EFFECT_TYPES,normalizeDefinition,normalizeActivity,normalizeEffect,validateDefinition,
  registerDefinition,executeDynamicActivity,code
};