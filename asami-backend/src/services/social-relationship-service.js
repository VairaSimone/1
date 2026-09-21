const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createMemory } = require("./memory-service");
const { upsertInteractionRelationship } = require("./relationship-service");

const PERSON_ENTITY_TYPE_ID = "00000000-0000-4000-8000-000000000001";
const PARTNER_RELATIONSHIP_TYPE_ID = "00000000-0000-4000-8007-000000000011";
const TRAIT_CODES = ["EXTRAVERSION","SOCIABILITY","OPENNESS","EMPATHY","CONSCIENTIOUSNESS","IMPULSIVITY","CONFIDENCE","PATIENCE","INDEPENDENCE","CREATIVITY"];
function clamp(value){return Math.max(0,Math.min(1,Number(value)||0));}
function avg(values){return values.length?values.reduce((sum,v)=>sum+v,0)/values.length:0;}
function relationshipScore(r){return Number(r?.familiarity||0)*.9+Number(r?.closeness||0)*1.1+Number(r?.affection||0)*1.2+Number(r?.trust||0)+Number(r?.attraction||0)*.8;}
function romanticScore(r,compatibility){return clamp(compatibility*.35+Number(r?.attraction||0)*.25+Number(r?.affection||0)*.2+Number(r?.closeness||0)*.15+Number(r?.trust||0)*.05);}
function compatibilityFromTraits(sourceTraits,targetTraits){const source=new Map((sourceTraits||[]).map(t=>[String(t.code).toUpperCase(),Number(t.value)])),target=new Map((targetTraits||[]).map(t=>[String(t.code).toUpperCase(),Number(t.value)])),diffs=[];for(const code of TRAIT_CODES)if(source.has(code)&&target.has(code))diffs.push(Math.abs(source.get(code)-target.get(code)));return diffs.length?clamp(1-avg(diffs)):.5;}
function stableInteractionNoise(sourceEntityId,targetEntityId,simulationAt){
  const input=`${sourceEntityId}:${targetEntityId}:${simulationAt}`;
  let hash=2166136261;
  for(let i=0;i<input.length;i++){hash^=input.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return ((hash>>>0)/4294967295)-.5;
}
function traitValue(traits,code,fallback=.5){
  const row=(traits||[]).find(t=>String(t.code||"").toUpperCase()===String(code).toUpperCase());
  return row?clamp(row.value):fallback;
}
function socialChemistry(sourceTraits,targetTraits,compatibility,receptiveness){
  const extraversionGap=Math.abs(traitValue(sourceTraits,"EXTRAVERSION")-traitValue(targetTraits,"EXTRAVERSION"));
  const patienceGap=Math.abs(traitValue(sourceTraits,"PATIENCE")-traitValue(targetTraits,"PATIENCE"));
  const impulsivityDisciplineGap=Math.abs(
    traitValue(sourceTraits,"IMPULSIVITY")-(1-traitValue(targetTraits,"CONSCIENTIOUSNESS"))
  );
  const empathyGap=Math.abs(traitValue(sourceTraits,"EMPATHY")-traitValue(targetTraits,"EMPATHY"));
  const tension=clamp(extraversionGap*.22+patienceGap*.22+impulsivityDisciplineGap*.28+empathyGap*.16);
  return clamp(Number(compatibility)*.58+Number(receptiveness)*.27+(1-tension)*.15);
}
function relationshipFormationAccepted({compatibility,receptiveness,simulationAt,sourceEntityId,targetEntityId,sourceTraits=[],targetTraits=[]}){
  const chemistry=socialChemistry(sourceTraits,targetTraits,compatibility,receptiveness);
  const noise=stableInteractionNoise(sourceEntityId,targetEntityId,simulationAt);
  return chemistry + noise*.20 >= .66;
}
function socialInteractionOutcome({compatibility,receptiveness,simulationAt,sourceEntityId,targetEntityId,sourceTraits=[],targetTraits=[]}){
  const noise=stableInteractionNoise(sourceEntityId,targetEntityId,simulationAt);
  const chemistry=socialChemistry(sourceTraits,targetTraits,compatibility,receptiveness);
  if(chemistry<=.40 || (chemistry<.52 && noise<-.08))return "NEGATIVE";
  if(chemistry>=.67 && noise>-.28)return "POSITIVE";
  return "NEUTRAL";
}
function socialRouteDistance(locations,originId,targetId){
  if(!originId||!targetId||String(originId)===String(targetId))return {distanceMeters:0,travelMinutes:0};
  const byId=new Map((locations||[]).map(location=>[String(location.locationId),location]));
  const origin=byId.get(String(originId)),target=byId.get(String(targetId));
  if(!origin||!target)return null;
  const queue=[originId],previous=new Map([[String(originId),null]]);
  let found=false;
  while(queue.length){
    const currentId=queue.shift();
    if(String(currentId)===String(targetId)){found=true;break;}
    const current=byId.get(String(currentId));
    for(const connection of Array.isArray(current?.data?.connections)?current.data.connections:[]){
      const next=byId.get(String(connection))||[...byId.values()].find(item=>String(item.data?.worldCode||"").toUpperCase()===String(connection).toUpperCase());
      if(!next||previous.has(String(next.locationId)))continue;
      previous.set(String(next.locationId),String(currentId));queue.push(next.locationId);
    }
  }
  if(!found)return null;
  const path=[];let cursor=String(targetId);
  while(cursor){path.unshift(cursor);cursor=previous.get(cursor)||null;}
  let distanceMeters=0;
  for(let i=1;i<path.length;i++){
    const a=byId.get(String(path[i-1])),b=byId.get(String(path[i]));
    const lat1=Number(a?.latitude),lon1=Number(a?.longitude),lat2=Number(b?.latitude),lon2=Number(b?.longitude);
    if([lat1,lon1,lat2,lon2].some(v=>!Number.isFinite(v)))return null;
    const rad=Math.PI/180,R=6371000,dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
    distanceMeters+=2*R*Math.asin(Math.sqrt(h));
  }
  return {distanceMeters,travelMinutes:distanceMeters/1000/4.8*60};
}
function buildRemoteCandidatesForSource(sourceId,allPeople,traitsByEntity,relationshipsByPair,locations,maxCandidates){
  const source=allPeople.get(sourceId);if(!source?.locationId)return[];
  const sourceTraits=traitsByEntity.get(sourceId)||[],candidates=[];
  for(const person of allPeople.values()){
    if(person.id===sourceId||!person.locationId||person.locationId===source.locationId)continue;
    const route=socialRouteDistance(locations,source.locationId,person.locationId);if(!route||!Number.isFinite(route.travelMinutes))continue;
    const pair=relationshipsByPair.get(`${sourceId}|${person.id}`)||relationshipsByPair.get(`${person.id}|${sourceId}`),rel=pair?.status==="ACTIVE"?pair:null;
    const targetTraits=traitsByEntity.get(person.id)||[],compatibility=compatibilityFromTraits(sourceTraits,targetTraits),relationship=rel||{},relationshipValue=relationshipScore(relationship);
    const novelty=rel?0:.18,distancePenalty=Math.min(.75,route.travelMinutes/60*.75),noise=stableInteractionNoise(sourceId,person.id,person.locationId);
    candidates.push({id:person.id,name:person.name,locationId:person.locationId,relationshipType:rel?.type||null,relationship:rel,compatibility,romanticScore:romanticScore(rel||{},compatibility),score:relationshipValue+compatibility*.50+novelty-distancePenalty+noise*.08,remote:true,travelMinutes:route.travelMinutes,distanceMeters:route.distanceMeters});
  }
  return candidates.sort((a,b)=>b.score-a.score||b.romanticScore-a.romanticScore).slice(0,maxCandidates);
}
async function loadTraits(entityId){const[rows]=await pool.query(`SELECT td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,[entityId]);return rows.map(r=>({code:r.code,value:Number(r.value)}));}
async function relationshipBetween(simulationId,a,b,status=null){const statusClause=status?"AND r.status=?":"",params=status?[simulationId,a,b,b,a,status]:[simulationId,a,b,b,a];const[rows]=await pool.query(`SELECT BIN_TO_UUID(r.id) AS id,r.status,r.version,BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,BIN_TO_UUID(r.target_entity_id) AS targetEntityId,rt.code AS type,r.trust_score AS trust,r.affection_score AS affection,r.respect_score AS respect,r.familiarity_score AS familiarity,r.attraction_score AS attraction,r.conflict_score AS conflict,r.fear_score AS fear,r.admiration_score AS admiration,r.jealousy_score AS jealousy,r.dependence_score AS dependence,r.closeness_score AS closeness,r.irritation_score AS irritation,r.started_simulation_at AS startedSimulationAt,r.ended_simulation_at AS endedSimulationAt FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id WHERE r.simulation_id=UUID_TO_BIN(?) AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?)) OR (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?))) ${statusClause} ORDER BY CASE rt.code WHEN 'PARTNER' THEN 3 WHEN 'FRIEND' THEN 2 WHEN 'ACQUAINTANCE' THEN 1 ELSE 0 END DESC,r.started_simulation_at DESC LIMIT 1`,params);return rows[0]||null;}
async function currentPartner(simulationId,entityId){const[rows]=await pool.query(`SELECT BIN_TO_UUID(CASE WHEN r.source_entity_id=UUID_TO_BIN(?) THEN r.target_entity_id ELSE r.source_entity_id END) AS partnerId,BIN_TO_UUID(r.id) AS relationshipId FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id WHERE r.simulation_id=UUID_TO_BIN(?) AND rt.code='PARTNER' AND r.status='ACTIVE' AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?)) LIMIT 1`,[entityId,simulationId,entityId,entityId]);return rows[0]||null;}
async function socialCandidates(simulationId,entityId){
  const[people]=await pool.query(
    `SELECT BIN_TO_UUID(other.id) AS id,other.display_name AS name
     FROM entity_locations_current me
     JOIN entity_locations_current otherLoc
       ON otherLoc.simulation_id=me.simulation_id
      AND otherLoc.location_id=me.location_id
      AND otherLoc.entity_id<>me.entity_id
     JOIN entities other
       ON other.id=otherLoc.entity_id
      AND other.simulation_id=me.simulation_id
     JOIN persons p ON p.entity_id=other.id
     WHERE me.simulation_id=UUID_TO_BIN(?)
       AND me.entity_id=UUID_TO_BIN(?)
       AND other.status='ACTIVE'
     ORDER BY other.display_name
     LIMIT 20`,
    [simulationId,entityId]
  );
  if(!people.length)return[];

  const candidateIds=people.map(person=>person.id);
  const placeholders=candidateIds.map(()=> "UUID_TO_BIN(?)").join(",");
  const[traitRows]=await pool.query(
    `SELECT BIN_TO_UUID(etc.entity_id) AS entityId,td.code,etc.value
     FROM entity_traits_current etc
     JOIN trait_definitions td ON td.id=etc.trait_id AND td.active=1
     WHERE etc.entity_id IN (${placeholders})`,
    candidateIds
  );
  const[relationshipRows]=await pool.query(
    `SELECT BIN_TO_UUID(r.id) AS id,r.status,r.started_simulation_at AS startedSimulationAt,
            BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,
            BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
            rt.code AS type,r.trust_score AS trust,r.affection_score AS affection,
            r.respect_score AS respect,r.familiarity_score AS familiarity,
            r.attraction_score AS attraction,r.conflict_score AS conflict,
            r.fear_score AS fear,r.admiration_score AS admiration,
            r.jealousy_score AS jealousy,r.dependence_score AS dependence,
            r.closeness_score AS closeness,r.irritation_score AS irritation,
            r.ended_simulation_at AS endedSimulationAt
     FROM relationships r
     JOIN relationship_types rt ON rt.id=r.relationship_type_id
     WHERE r.simulation_id=UUID_TO_BIN(?)
       AND r.status IN ('ACTIVE','ENDED')
       AND (
         (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id IN (${placeholders}))
         OR
         (r.target_entity_id=UUID_TO_BIN(?) AND r.source_entity_id IN (${placeholders}))
       )`,
    [simulationId,entityId,...candidateIds,entityId,...candidateIds]
  );
  const sourceTraits=await loadTraits(entityId);
  const traitsByEntity=new Map();
  for(const row of traitRows){
    if(!traitsByEntity.has(row.entityId))traitsByEntity.set(row.entityId,[]);
    traitsByEntity.get(row.entityId).push({code:row.code,value:Number(row.value)});
  }
  const relationshipByCandidate=new Map();
  for(const row of relationshipRows){
    const candidateId=row.sourceEntityId===entityId?row.targetEntityId:row.sourceEntityId;
    const current=relationshipByCandidate.get(candidateId);
    if(
      !current ||
      (row.status==="ACTIVE"&&current.status!=="ACTIVE") ||
      (row.status===current.status&&new Date(row.startedSimulationAt||0).getTime()>new Date(current.startedSimulationAt||0).getTime())
    )relationshipByCandidate.set(candidateId,row);
  }
  const sourceByCode=new Map(sourceTraits.map(t=>[String(t.code).toUpperCase(),Number(t.value)]));
  return people.map(person=>{
    const targetTraits=traitsByEntity.get(person.id)||[],
      rel=relationshipByCandidate.get(person.id)?.status==="ACTIVE"?relationshipByCandidate.get(person.id):null,
      endedPartner=rel?null:(relationshipByCandidate.get(person.id)?.status==="ENDED"&&relationshipByCandidate.get(person.id)?.type==="PARTNER"?relationshipByCandidate.get(person.id):null),
      compatibility=compatibilityFromTraits(sourceTraits,targetTraits),
      romantic=romanticScore(rel||{},compatibility);
    return{
      id:person.id,
      name:person.name,
      relationshipType:rel?.type||endedPartner?.type||null,
      relationship:rel,
      endedRelationship:endedPartner,
      compatibility,
      romanticScore:romantic,
      score:relationshipScore(rel)
    };
  }).sort((a,b)=>b.score-a.score||b.romanticScore-a.romanticScore);
}
async function buildSocialContext(simulationId,entityId){const[partner,candidates,traits]=await Promise.all([currentPartner(simulationId,entityId),socialCandidates(simulationId,entityId),loadTraits(entityId)]);return{partner,candidates,traits};}
async function buildSocialContexts(simulationId,entityIds=[],{maxCandidates=20,worldLocations=[]}={}){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))],contexts=new Map();if(!ids.length)return contexts;
  const placeholders=ids.map(()=> 'UUID_TO_BIN(?)').join(',');
  const [people]=await pool.query(`SELECT BIN_TO_UUID(me.entity_id) AS sourceEntityId,BIN_TO_UUID(other.id) AS id,other.display_name AS name,BIN_TO_UUID(me.location_id) AS locationId FROM entity_locations_current me JOIN entity_locations_current otherLoc ON otherLoc.simulation_id=me.simulation_id AND otherLoc.location_id=me.location_id AND otherLoc.entity_id<>me.entity_id JOIN entities other ON other.id=otherLoc.entity_id AND other.simulation_id=me.simulation_id JOIN persons p ON p.entity_id=other.id WHERE me.simulation_id=UUID_TO_BIN(?) AND me.entity_id IN (${placeholders}) AND other.status='ACTIVE' ORDER BY me.entity_id,other.display_name`,[simulationId,...ids]);
  const bySource=new Map(ids.map(id=>[id,[]]));for(const row of people){const list=bySource.get(row.sourceEntityId);if(list&&list.length<maxCandidates)list.push(row);}
  const allPeopleRows=await pool.query(`SELECT BIN_TO_UUID(elc.entity_id) AS entityId,BIN_TO_UUID(e.id) AS id,e.display_name AS name,BIN_TO_UUID(elc.location_id) AS locationId
       FROM entity_locations_current elc JOIN entities e ON e.id=elc.entity_id JOIN persons p ON p.entity_id=e.id
       WHERE elc.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`,[simulationId]);
  const allPeople=new Map(allPeopleRows[0].map(row=>({id:row.id,name:row.name,locationId:row.locationId})).map(row=>[row.id,row]));
  for(const id of ids)if(!allPeople.has(id))allPeople.set(id,{id,name:"",locationId:null});
  const candidateIds=[...new Set(people.map(row=>row.id).filter(Boolean))],allPersonIds=[...new Set([...ids,...allPeople.keys()])];
  const allPlaceholders=allPersonIds.map(()=> 'UUID_TO_BIN(?)').join(',');
  const [traitRows]=allPersonIds.length?await pool.query(`SELECT BIN_TO_UUID(etc.entity_id) AS entityId,td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id AND td.active=1 WHERE etc.entity_id IN (${allPlaceholders})`,allPersonIds):[[]];
  const [relationshipRows]=candidateIds.length?await pool.query(`SELECT BIN_TO_UUID(r.id) AS id,r.status,r.started_simulation_at AS startedSimulationAt,BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,BIN_TO_UUID(r.target_entity_id) AS targetEntityId,rt.code AS type,r.trust_score AS trust,r.affection_score AS affection,r.respect_score AS respect,r.familiarity_score AS familiarity,r.attraction_score AS attraction,r.conflict_score AS conflict,r.fear_score AS fear,r.admiration_score AS admiration,r.jealousy_score AS jealousy,r.dependence_score AS dependence,r.closeness_score AS closeness,r.irritation_score AS irritation,r.ended_simulation_at AS endedSimulationAt FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id WHERE r.simulation_id=UUID_TO_BIN(?) AND r.status IN ('ACTIVE','ENDED') AND ((r.source_entity_id IN (${placeholders}) AND r.target_entity_id IN (${allPlaceholders})) OR (r.target_entity_id IN (${placeholders}) AND r.source_entity_id IN (${allPlaceholders})))`,[simulationId,...ids,...allPersonIds,...ids,...allPersonIds]):[[]];
  const traitsByEntity=new Map();for(const row of traitRows){if(!traitsByEntity.has(row.entityId))traitsByEntity.set(row.entityId,[]);traitsByEntity.get(row.entityId).push({code:row.code,value:Number(row.value)});}
  const relationshipsByPair=new Map();
  for(const row of relationshipRows){
    const key=`${row.sourceEntityId}|${row.targetEntityId}`;
    const reverse=`${row.targetEntityId}|${row.sourceEntityId}`;
    const current=relationshipsByPair.get(reverse)||relationshipsByPair.get(key);
    if(!current||(row.status==='ACTIVE'&&current.status!=='ACTIVE')||(row.status===current.status&&new Date(row.startedSimulationAt||0).getTime()>new Date(current.startedSimulationAt||0).getTime()))relationshipsByPair.set(key,row);
  }
  const sourceTraitsByEntity=new Map();for(const id of ids)sourceTraitsByEntity.set(id,traitsByEntity.get(id)||[]);
  for(const id of ids){
    const sourceTraits=sourceTraitsByEntity.get(id)||[],sourcePeople=bySource.get(id)||[],partnerRow=relationshipRows.find(row=>row.status==='ACTIVE'&&row.type==='PARTNER'&&(row.sourceEntityId===id||row.targetEntityId===id));
    const partner=partnerRow?{partnerId:partnerRow.sourceEntityId===id?partnerRow.targetEntityId:partnerRow.sourceEntityId,relationshipId:partnerRow.id}:null;
    const candidates=sourcePeople.map(person=>{
      const targetTraits=traitsByEntity.get(person.id)||[],pair=relationshipsByPair.get(`${id}|${person.id}`)||relationshipsByPair.get(`${person.id}|${id}`),rel=pair?.status==='ACTIVE'?pair:null,endedPartner=rel?null:(pair?.status==='ENDED'&&pair?.type==='PARTNER'?pair:null),compatibility=compatibilityFromTraits(sourceTraits,targetTraits),romantic=romanticScore(rel||{},compatibility);
      return{id:person.id,name:person.name,locationId:person.locationId,relationshipType:rel?.type||endedPartner?.type||null,relationship:rel,endedRelationship:endedPartner,compatibility,romanticScore:romantic,score:relationshipScore(rel)};
    }).sort((a,b)=>b.score-a.score||b.romanticScore-a.romanticScore);
    const remoteCandidates=buildRemoteCandidatesForSource(id,allPeople,traitsByEntity,relationshipsByPair,worldLocations,maxCandidates);
    contexts.set(id,{partner,candidates,remoteCandidates,traits:sourceTraits});
  }
  return contexts;
}
function deriveSocialIntent({actionType,targetId,partner,candidates}){if(actionType!=="TALKING"||!targetId)return"NONE";const candidate=(candidates||[]).find(x=>x.id===targetId);if(!candidate)return"NONE";if(candidate.endedRelationship?.type==='PARTNER'&&!partner){const r=candidate.endedRelationship;if(Number(r.affection)>=.45&&Number(r.trust)>=.4&&Number(r.closeness)>=.4)return"RECONCILE";}if(partner?.partnerId===targetId)return"NONE";if(Number(candidate.romanticScore)>=.62&&Number(candidate.compatibility)>=.5)return"PURSUE_RELATIONSHIP";if(!partner&&Number(candidate.romanticScore)<.32)return"STAY_SINGLE";return"NONE";}
async function writeRelationshipHistory(r,simulationAt,sourceEventId=null){await pool.query(`INSERT INTO relationship_history(id,simulation_id,relationship_id,simulation_time,affection,trust,respect,familiarity,attraction,conflict,fear,irritation,admiration,jealousy,dependence,closeness,source_event_id) VALUES(UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,UUID_TO_BIN(?))`,[uuid(),r.simulation_id,r.id,simulationAt,r.affection_score,r.trust_score,r.respect_score,r.familiarity_score,r.attraction_score,r.conflict_score,r.fear_score,r.irritation_score,r.admiration_score,r.jealousy_score,r.dependence_score,r.closeness_score,sourceEventId]);}
async function endRelationship(relationshipId,simulationAt,reason="ENDED"){const[rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,simulation_id,status,version,affection_score,trust_score,respect_score,familiarity_score,attraction_score,admiration_score,jealousy_score,dependence_score,closeness_score,irritation_score,conflict_score,fear_score FROM relationships WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId]);if(!rows.length)return false;const r=rows[0];const[updated]=await pool.query(`UPDATE relationships SET status='ENDED',ended_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?`,[simulationAt,relationshipId,r.version]);if(!updated.affectedRows)return false;await writeRelationshipHistory(r,simulationAt,null);return{id:r.id,reason};}
async function updateRelationshipScores(simulationId,relationshipId,simulationAt,deltas={},sourceEventId=null){const[rows]=await pool.query(`SELECT * FROM relationships WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId,simulationId]);if(!rows.length)return null;const r=rows[0],next={trust_score:clamp(Number(r.trust_score)+Number(deltas.trust||0)),affection_score:clamp(Number(r.affection_score)+Number(deltas.affection||0)),respect_score:clamp(Number(r.respect_score)+Number(deltas.respect||0)),familiarity_score:clamp(Number(r.familiarity_score)+Number(deltas.familiarity||0)),attraction_score:clamp(Number(r.attraction_score)+Number(deltas.attraction||0)),conflict_score:clamp(Number(r.conflict_score)+Number(deltas.conflict||0)),fear_score:clamp(Number(r.fear_score)+Number(deltas.fear||0)),admiration_score:clamp(Number(r.admiration_score)+Number(deltas.admiration||0)),jealousy_score:clamp(Number(r.jealousy_score)+Number(deltas.jealousy||0)),dependence_score:clamp(Number(r.dependence_score)+Number(deltas.dependence||0)),closeness_score:clamp(Number(r.closeness_score)+Number(deltas.closeness||0)),irritation_score:clamp(Number(r.irritation_score)+Number(deltas.irritation||0))};const[updated]=await pool.query(`UPDATE relationships SET trust_score=?,affection_score=?,respect_score=?,familiarity_score=?,attraction_score=?,conflict_score=?,fear_score=?,admiration_score=?,jealousy_score=?,dependence_score=?,closeness_score=?,irritation_score=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[next.trust_score,next.affection_score,next.respect_score,next.familiarity_score,next.attraction_score,next.conflict_score,next.fear_score,next.admiration_score,next.jealousy_score,next.dependence_score,next.closeness_score,next.irritation_score,relationshipId,r.version]);if(!updated.affectedRows)return null;r.simulation_id=simulationId;r.id=relationshipId;Object.assign(r,next);await writeRelationshipHistory(r,simulationAt,sourceEventId);return r;}
async function setRelationshipType(simulationId,relationshipId,typeCode,simulationAt,sourceEventId=null){const[rowsType]=await pool.query("SELECT BIN_TO_UUID(id) AS id FROM relationship_types WHERE code=? AND active=1 LIMIT 1",[typeCode]);if(!rowsType.length)return null;const[type]=rowsType;const[rows]=await pool.query(`SELECT * FROM relationships WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId,simulationId]);if(!rows.length)return null;const r=rows[0],[updated]=await pool.query(`UPDATE relationships SET relationship_type_id=UUID_TO_BIN(?),version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[type.id,relationshipId,r.version]);if(!updated.affectedRows)return null;r.simulation_id=simulationId;r.id=relationshipId;r.relationship_type_id=type.id;await writeRelationshipHistory({...r,simulation_id:simulationId,id:relationshipId},simulationAt,sourceEventId);return relationshipId;}
async function reactivateRelationship(simulationId,relationshipId,simulationAt,sourceEventId=null){const[rows]=await pool.query(`SELECT * FROM relationships WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ENDED' LIMIT 1`,[relationshipId,simulationId]);if(!rows.length)return null;const r=rows[0];const[updated]=await pool.query(`UPDATE relationships SET status='ACTIVE',ended_simulation_at=NULL,version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ENDED' AND version=?`,[relationshipId,r.version]);if(!updated.affectedRows)return null;r.simulation_id=simulationId;r.id=relationshipId;await writeRelationshipHistory({...r,simulation_id:simulationId,id:relationshipId},simulationAt,sourceEventId);return relationshipId;}
async function recordSocialMemory({simulationId,entityId,targetEntityId,targetName,locationId,simulationAt,eventId,relationshipType,intent,outcome,compatibility,scoreChanges}){const direction=entityId===targetEntityId?"":` with ${targetName||targetEntityId}`,label={PURSUE_RELATIONSHIP:"pursuing a romantic relationship",STAY_SINGLE:"choosing to remain single for now",RECONCILE:"trying to reconcile a past relationship",NONE:"having a social interaction"}[intent]||"having a social interaction";await createMemory({simulationId,entityId,eventId,locationId,type:"EPISODIC",content:`Social memory: ${label}${direction}. Outcome: ${outcome}. Relationship: ${relationshipType||"NONE"}. Compatibility ${compatibility.toFixed(2)}.`,importance:intent==='STAY_SINGLE'?.52:.62,strength:.95,confidence:.9,emotionalIntensity:Math.min(1,.25+Math.abs(Number(scoreChanges?.affection||0))*4+Number(scoreChanges?.conflict||0)),simulationAt,metadata:{social:true,targetEntityId,targetName,intent,outcome,relationshipType,compatibility,scoreChanges}});}
async function recordBetrayal({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId}){const partner=await currentPartner(simulationId,sourceEntityId);if(!partner||partner.partnerId===targetEntityId)return null;const rel=await relationshipBetween(simulationId,sourceEntityId,partner.partnerId,"ACTIVE");if(!rel)return null;await updateRelationshipScores(simulationId,rel.id,simulationAt,{jealousy:.3,conflict:.22,irritation:.16,trust:-.2,affection:-.12,closeness:-.08,attraction:-.06},eventId);const locationRows=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,sourceEntityId]);const locationId=locationRows[0][0]?.locationId||null;const[names]=await pool.query(`SELECT id,display_name AS name FROM entities WHERE id IN (UUID_TO_BIN(?),UUID_TO_BIN(?))`,[sourceEntityId,partner.partnerId]);const partnerName=names.find(n=>n.id)?.name||partner.partnerId;await recordSocialMemory({simulationId,entityId:partner.partnerId,targetEntityId:sourceEntityId,targetName:names.find(n=>n.name!==partnerName)?.name||sourceEntityId,locationId,simulationAt,eventId,relationshipType:'PARTNER',intent:'PURSUE_RELATIONSHIP',outcome:'Betrayal detected; jealousy and conflict increased',compatibility:.5,scoreChanges:{conflict:.22,jealousy:.3,trust:-.2,affection:-.12}});if(Number(rel.trust)<.2||Number(rel.conflict)>.8)await endRelationship(rel.id,simulationAt,"BETRAYAL");return rel.id;}
async function requestPartnership({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,compatibility}){const sourcePartner=await currentPartner(simulationId,sourceEntityId);if(sourcePartner)return{accepted:false,reason:"SOURCE_ALREADY_PARTNER"};const targetPartner=await currentPartner(simulationId,targetEntityId);if(targetPartner)return{accepted:false,reason:"TARGET_ALREADY_PARTNER"};const rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");if(!rel)return{accepted:false,reason:"NO_ACTIVE_RELATIONSHIP"};const acceptance=clamp(Number(rel.affection)*.35+Number(rel.trust)*.25+Number(rel.closeness)*.2+Number(rel.attraction)*.1+compatibility*.1);if(acceptance<.5||Number(rel.conflict)>.62||Number(rel.irritation)>.65)return{accepted:false,reason:"NOT_READY"};const relationshipId=await setRelationshipType(simulationId,rel.id,'PARTNER',simulationAt,eventId);await updateRelationshipScores(simulationId,relationshipId,simulationAt,{affection:.06,closeness:.06,trust:.03,attraction:.08,dependence:.02},eventId);return{accepted:Boolean(relationshipId),relationshipId,acceptance};}
async function reconcileRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId}){const sourcePartner=await currentPartner(simulationId,sourceEntityId);if(sourcePartner)return{accepted:false,reason:"SOURCE_ALREADY_PARTNER"};const targetPartner=await currentPartner(simulationId,targetEntityId);if(targetPartner)return{accepted:false,reason:"TARGET_ALREADY_PARTNER"};const rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ENDED");if(!rel||rel.type!=='PARTNER')return{accepted:false,reason:"NO_ENDED_PARTNER"};const endedAt=rel.endedSimulationAt?new Date(rel.endedSimulationAt):null;if(!endedAt||Number.isNaN(endedAt.getTime()))return{accepted:false,reason:"MISSING_END_TIME"};const ageHours=Math.max(0,(new Date(simulationAt)-endedAt)/3600000);if(ageHours>24*60)return{accepted:false,reason:"TOO_OLD"};const reconcilable=Number(rel.affection)>=.35&&Number(rel.trust)>=.35&&Number(rel.closeness)>=.35&&Number(rel.conflict)<=.55;if(!reconcilable)return{accepted:false,reason:"INSUFFICIENT_BOND"};const reactivated=await reactivateRelationship(simulationId,rel.id,simulationAt,eventId);if(!reactivated)return{accepted:false,reason:"REACTIVATION_FAILED"};await updateRelationshipScores(simulationId,reactivated,simulationAt,{affection:.04,closeness:.05,trust:.04,conflict:-.08,irritation:-.06},eventId);return{accepted:true,relationshipId:reactivated};}
function shouldPromoteToFriend({relationship,interactionCount,ageHours=0}={}) {
  if (!relationship || String(relationship.type||"").toUpperCase() !== "ACQUAINTANCE") return false;
  if (Number(interactionCount) < 6 || Number(ageHours) < 12) return false;
  const trust = Number(relationship.trust||0);
  const affection = Number(relationship.affection||0);
  const closeness = Number(relationship.closeness||0);
  const conflict = Number(relationship.conflict||0);
  const irritation = Number(relationship.irritation||0);
  return relationshipScore(relationship) >= 1.0 &&
    trust >= .22 &&
    affection >= .14 &&
    closeness >= .10 &&
    conflict <= .45 &&
    irritation <= .50;
}
async function matureRelationship(simulationId,entityId,targetEntityId,simulationAt,eventId) {
  const relationship = await relationshipBetween(simulationId,entityId,targetEntityId,"ACTIVE");
  if (!relationship || String(relationship.type||"").toUpperCase() !== "ACQUAINTANCE") return relationship;
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS interactionCount
     FROM relationship_history
     WHERE simulation_id=UUID_TO_BIN(?) AND relationship_id=UUID_TO_BIN(?)`,
    [simulationId,relationship.id]
  );
  const interactionCount = Number(rows[0]?.interactionCount||0);
  const ageHours = Math.max(0,(new Date(simulationAt)-new Date(relationship.startedSimulationAt))/3600000);
  if (!shouldPromoteToFriend({relationship,interactionCount,ageHours})) return relationship;
  const promoted = await setRelationshipType(simulationId,relationship.id,"FRIEND",simulationAt,eventId);
  return promoted ? relationshipBetween(simulationId,entityId,targetEntityId,"ACTIVE") : relationship;
}

function conversationOutcomeDeltas(outcome="NEUTRAL"){
  return outcome==="POSITIVE"
    ? {familiarity:.04,affection:.03,trust:.025,closeness:.025,conflict:-.015,irritation:-.02}
    : outcome==="NEGATIVE"
      ? {familiarity:.02,affection:-.025,trust:-.035,closeness:-.02,conflict:.05,irritation:.04}
      : {familiarity:.015,closeness:.008};
}
function mergeRelationshipDeltas(base={},outcome={}){
  const keys=new Set([...Object.keys(base),...Object.keys(outcome)]),merged={};
  for(const key of keys) merged[key]=Number(base[key]||0)+Number(outcome[key]||0);
  return merged;
}
async function applyConversationOutcome({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,outcome="NEUTRAL",intent="NONE"}){const rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");if(!rel)return null;const deltas=conversationOutcomeDeltas(outcome),updated=await updateRelationshipScores(simulationId,rel.id,simulationAt,deltas,eventId);if(updated&&intent==='PURSUE_RELATIONSHIP')return requestPartnership({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,compatibility:.5});return updated;}
async function ensureSocialConversation(simulationId,sourceEntityId,targetEntityId,simulationAt){const[existing]=await pool.query(`SELECT BIN_TO_UUID(c.id) AS id FROM conversations c JOIN conversation_participants p1 ON p1.conversation_id=c.id AND p1.entity_id=UUID_TO_BIN(?) JOIN conversation_participants p2 ON p2.conversation_id=c.id AND p2.entity_id=UUID_TO_BIN(?) WHERE c.simulation_id=UUID_TO_BIN(?) AND c.status='ACTIVE' AND p1.left_simulation_at IS NULL AND p2.left_simulation_at IS NULL ORDER BY c.created_simulation_at DESC LIMIT 1`,[sourceEntityId,targetEntityId,simulationId]);if(existing.length)return existing[0].id;const conversationId=uuid();await pool.query(`INSERT INTO conversations(id,simulation_id,channel,created_simulation_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT',?,'ACTIVE',?,1)`,[conversationId,simulationId,simulationAt,JSON.stringify({type:"AUTONOMOUS_SOCIAL",sourceEntityId,targetEntityId})]);for(const entityId of[sourceEntityId,targetEntityId])await pool.query(`INSERT INTO conversation_participants(conversation_id,simulation_id,entity_id,joined_simulation_at) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)`,[conversationId,simulationId,entityId,simulationAt]);return conversationId;}
async function createSocialMessage({simulationId,conversationId,senderEntityId,content,simulationAt,metadata}){const messageId=uuid();await pool.query(`INSERT INTO messages(id,simulation_id,conversation_id,sender_entity_id,message_type,content,simulation_created_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'ASSISTANT',?,?,'DELIVERED',?,1)`,[messageId,simulationId,conversationId,senderEntityId,content,simulationAt,JSON.stringify({source:"AUTONOMOUS_SOCIAL",...(metadata||{})})]);return messageId;}
async function processSocialInteraction({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,relationshipIntent="NONE",locationId=null}){
  if(!sourceEntityId||!targetEntityId||sourceEntityId===targetEntityId)return null;
  const [sourceTraits,targetTraits]=await Promise.all([loadTraits(sourceEntityId),loadTraits(targetEntityId)]);
  const compatibility=compatibilityFromTraits(sourceTraits,targetTraits);
  const sourceExtra=traitValue(sourceTraits,"EXTRAVERSION"),sourceConfidence=traitValue(sourceTraits,"CONFIDENCE");
  const targetExtra=traitValue(targetTraits,"EXTRAVERSION"),targetEmpathy=traitValue(targetTraits,"EMPATHY"),targetPatience=traitValue(targetTraits,"PATIENCE");
  const receptiveness=clamp(targetExtra*.40+targetEmpathy*.35+targetPatience*.25);
  const chemistry=socialChemistry(sourceTraits,targetTraits,compatibility,receptiveness);
  const existingRelationship=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");
  const formationAccepted=Boolean(existingRelationship)||relationshipFormationAccepted({compatibility,receptiveness,simulationAt,sourceEntityId,targetEntityId,sourceTraits,targetTraits});
  const interactionOutcome=socialInteractionOutcome({compatibility,receptiveness,simulationAt,sourceEntityId,targetEntityId,sourceTraits,targetTraits});
  if(!formationAccepted&&!existingRelationship){
    await recordSocialMemory({
      simulationId,entityId:sourceEntityId,targetEntityId,targetName:targetEntityId,locationId,simulationAt,eventId,
      relationshipType:"NONE",intent:relationshipIntent,outcome:interactionOutcome,compatibility,
      scoreChanges:{conflict:interactionOutcome==="NEGATIVE"?.015:0,affection:0}
    });
    return{relationshipId:null,conversationId:null,interactionOutcome,compatibility,receptiveness,relationshipFormed:false};
  }

  const outcomeDeltas=conversationOutcomeDeltas(interactionOutcome);
  const chemistryDeltas=interactionOutcome==="POSITIVE"
    ? {attraction:.018*compatibility*receptiveness,affection:.012*chemistry,trust:.010*chemistry,closeness:.010*chemistry}
    : interactionOutcome==="NEGATIVE"
      ? {attraction:-.020,affection:-.025,trust:-.030,closeness:-.022,conflict:.045,irritation:.040,fear:.015}
      : {attraction:.005*compatibility,conflict:.004,irritation:.003};
  const relationshipDeltas=mergeRelationshipDeltas(outcomeDeltas,chemistryDeltas);
  const relationshipId=await upsertInteractionRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,deltas:relationshipDeltas,typeCode:"ACQUAINTANCE",sourceEventId:eventId});
  if(!relationshipId)return{relationshipId:null,conversationId:null,interactionOutcome,compatibility,receptiveness,relationshipFormed:false};

  const updatedRelationship=await matureRelationship(simulationId,sourceEntityId,targetEntityId,simulationAt,eventId);
  if(updatedRelationship && (Number(updatedRelationship.conflict||0)>=.78 || Number(updatedRelationship.trust||0)<=.12)){
    await endRelationship(updatedRelationship.id,simulationAt,"SOCIAL_CONFLICT");
  }
  const conversationId=await ensureSocialConversation(simulationId,sourceEntityId,targetEntityId,simulationAt);
  const [sourceRows,targetRows]=await Promise.all([
    pool.query(`SELECT display_name AS name FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`,[sourceEntityId]),
    pool.query(`SELECT display_name AS name FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`,[targetEntityId])
  ]);
  const sourceName=sourceRows[0][0]?.name||"",targetName=targetRows[0][0]?.name||"";
  const opener=sourceExtra>.7?`Ehi ${targetName}, che fai?`:`Ciao ${targetName}, come stai?`;
  const response=receptiveness>.68?`Ciao ${sourceName}! Bene, grazie. Mi fa piacere vederti.`:receptiveness>.46?`Ciao ${sourceName}, tutto bene. E tu?`:`Ciao. Tutto bene, grazie.`;
  const sourceMessageId=await createSocialMessage({simulationId,conversationId,senderEntityId:sourceEntityId,content:opener,simulationAt,metadata:{role:"INITIATOR",targetEntityId,compatibility,receptiveness,interactionOutcome}});
  const targetMessageId=await createSocialMessage({simulationId,conversationId,senderEntityId:targetEntityId,content:response,simulationAt,metadata:{role:"RESPONDER",targetEntityId:sourceEntityId,compatibility,receptiveness,interactionOutcome}});
  const intentId=uuid();
  await pool.query(`INSERT INTO communication_intents(id,simulation_id,entity_id,target_entity_id,channel,reason_type,priority,status,created_simulation_at,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT','AUTONOMOUS_INITIATED',?,?,?,1)`,[intentId,simulationId,sourceEntityId,targetEntityId,clamp(.40+chemistry*.45), "SENT",simulationAt]);
  const attemptId=uuid();
  await pool.query(`INSERT INTO communication_attempts(id,simulation_id,intent_id,attempted_simulation_at,status,result,message_id) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'DELIVERED',?,UUID_TO_BIN(?))`,[attemptId,simulationId,intentId,simulationAt,JSON.stringify({conversationId,interactionOutcome,sourceMessageId,targetMessageId,relationshipId}),targetMessageId]);
  await recordSocialMemory({simulationId,entityId:sourceEntityId,targetEntityId,targetName,locationId,simulationAt,eventId,relationshipType:updatedRelationship?.type||"ACQUAINTANCE",intent:relationshipIntent,outcome:interactionOutcome,compatibility,scoreChanges:relationshipDeltas});
  await recordSocialMemory({simulationId,entityId:targetEntityId,targetEntityId:sourceEntityId,targetName:sourceName,locationId,simulationAt,eventId,relationshipType:updatedRelationship?.type||"ACQUAINTANCE",intent:"NONE",outcome:`received interaction from ${sourceName}: ${interactionOutcome}`,compatibility,scoreChanges:relationshipDeltas});
  return{relationshipId:updatedRelationship?.id||relationshipId,conversationId,sourceMessageId,targetMessageId,interactionOutcome,compatibility,receptiveness,relationshipFormed:!existingRelationship};
}

async function maintainRelationships(simulationId,simulationAt){const[candidates]=await pool.query(`SELECT BIN_TO_UUID(r.id) AS id,r.status,r.started_simulation_at AS startedSimulationAt,r.source_entity_id AS sourceEntityId,r.target_entity_id AS targetEntityId,rt.code AS type FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id WHERE r.simulation_id=UUID_TO_BIN(?)`,[simulationId]);for(const r of candidates){const ageHours=Math.max(0,(new Date(simulationAt)-new Date(r.startedSimulationAt))/3600000);if(r.status==='ACTIVE'&&ageHours>24*45&&r.type==='ACQUAINTANCE')await endRelationship(r.id,simulationAt,"TIMEOUT");if(r.status==='ACTIVE'&&ageHours>24*120&&r.type==='FRIEND')await endRelationship(r.id,simulationAt,"FRIENDSHIP_DECAY");}}

module.exports={maintainRelationships,buildSocialContext,buildSocialContexts,socialCandidates,relationshipBetween,currentPartner,deriveSocialIntent,updateRelationshipScores,setRelationshipType,reactivateRelationship,requestPartnership,reconcileRelationship,recordBetrayal,conversationOutcomeDeltas,mergeRelationshipDeltas,shouldPromoteToFriend,matureRelationship,applyConversationOutcome,recordSocialMemory,compatibilityFromTraits,processSocialInteraction,stableInteractionNoise,socialChemistry,relationshipFormationAccepted,socialInteractionOutcome};
