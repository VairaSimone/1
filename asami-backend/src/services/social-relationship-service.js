const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createMemory } = require("./memory-service");
const { upsertInteractionRelationship } = require("./relationship-service");

const PERSON_ENTITY_TYPE_ID = "00000000-0000-4000-8000-000000000001";
const PARTNER_RELATIONSHIP_TYPE_ID = "00000000-0000-4000-8007-000000000011";

const TRAIT_CODES = [
  "EXTRAVERSION","SOCIABILITY","OPENNESS","EMPATHY","CONSCIENTIOUSNESS",
  "IMPULSIVITY","CONFIDENCE","PATIENCE","INDEPENDENCE","CREATIVITY"
];

function clamp(value){ return Math.max(0,Math.min(1,Number(value)||0)); }
function avg(values){ return values.length ? values.reduce((sum,v)=>sum+v,0)/values.length : 0; }
function relationshipScore(r){ return Number(r?.familiarity||0)*0.9 + Number(r?.closeness||0)*1.1 + Number(r?.affection||0)*1.2 + Number(r?.trust||0) + Number(r?.attraction||0)*0.8; }
function romanticScore(r,compatibility){ return clamp(compatibility*0.35 + Number(r?.attraction||0)*0.25 + Number(r?.affection||0)*0.2 + Number(r?.closeness||0)*0.15 + Number(r?.trust||0)*0.05); }

function compatibilityFromTraits(sourceTraits,targetTraits){
  const source = new Map((sourceTraits||[]).map(t=>[String(t.code).toUpperCase(),Number(t.value)]));
  const target = new Map((targetTraits||[]).map(t=>[String(t.code).toUpperCase(),Number(t.value)]));
  const diffs=[];
  for(const code of TRAIT_CODES){
    if(source.has(code)&&target.has(code))diffs.push(Math.abs(source.get(code)-target.get(code)));
  }
  return diffs.length ? clamp(1-avg(diffs)) : 0.5;
}

async function loadTraits(entityId){
  const [rows]=await pool.query(`SELECT td.code,etc.value FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1`,[entityId]);
  return rows.map(r=>({code:r.code,value:Number(r.value)}));
}

async function relationshipBetween(simulationId,a,b,status=null){
  const statusClause=status ? "AND r.status=?" : "";
  const params=status ? [simulationId,a,b,b,a,status] : [simulationId,a,b,b,a];
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(r.id) AS id,r.status,r.version,
           BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
           rt.code AS type,r.trust_score AS trust,r.affection_score AS affection,r.respect_score AS respect,
           r.familiarity_score AS familiarity,r.attraction_score AS attraction,r.conflict_score AS conflict,
           r.fear_score AS fear,r.admiration_score AS admiration,r.jealousy_score AS jealousy,
           r.dependence_score AS dependence,r.closeness_score AS closeness,r.irritation_score AS irritation,
           r.started_simulation_at AS startedSimulationAt
    FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
    WHERE r.simulation_id=UUID_TO_BIN(?)
      AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?))
        OR (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?)))
      ${statusClause}
    ORDER BY CASE rt.code WHEN 'PARTNER' THEN 3 WHEN 'FRIEND' THEN 2 WHEN 'ACQUAINTANCE' THEN 1 ELSE 0 END DESC,
             r.started_simulation_at DESC LIMIT 1
  `,params);
  return rows[0]||null;
}

async function currentPartner(simulationId,entityId){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(CASE WHEN r.source_entity_id=UUID_TO_BIN(?) THEN r.target_entity_id ELSE r.source_entity_id END) AS partnerId,
           BIN_TO_UUID(r.id) AS relationshipId
    FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
    WHERE r.simulation_id=UUID_TO_BIN(?) AND rt.code='PARTNER' AND r.status='ACTIVE'
      AND (r.source_entity_id=UUID_TO_BIN(?) OR r.target_entity_id=UUID_TO_BIN(?)) LIMIT 1
  `,[entityId,simulationId,entityId,entityId]);
  return rows[0]||null;
}

async function socialCandidates(simulationId,entityId){
  const [people]=await pool.query(`
    SELECT BIN_TO_UUID(other.id) AS id,other.display_name AS name
    FROM entity_locations_current me
    JOIN entity_locations_current otherLoc ON otherLoc.simulation_id=me.simulation_id AND otherLoc.location_id=me.location_id AND otherLoc.entity_id<>me.entity_id
    JOIN entities other ON other.id=otherLoc.entity_id AND other.simulation_id=me.simulation_id
    JOIN persons p ON p.entity_id=other.id
    WHERE me.simulation_id=UUID_TO_BIN(?) AND me.entity_id=UUID_TO_BIN(?) AND other.status='ACTIVE'
    ORDER BY other.display_name LIMIT 20
  `,[simulationId,entityId]);
  const sourceTraits=await loadTraits(entityId);
  const result=[];
  for(const person of people){
    const targetTraits=await loadTraits(person.id);
    const rel=await relationshipBetween(simulationId,entityId,person.id,"ACTIVE");
    const endedPartner=rel ? null : await relationshipBetween(simulationId,entityId,person.id,"ENDED");
    const compatibility=compatibilityFromTraits(sourceTraits,targetTraits);
    const romantic=romanticScore(rel||{},compatibility);
    result.push({id:person.id,name:person.name,relationshipType:rel?.type||endedPartner?.type||null,relationship:rel,endedRelationship:endedPartner,compatibility,romanticScore:romantic,score:relationshipScore(rel)});
  }
  return result.sort((a,b)=>b.score-a.score || b.romanticScore-a.romanticScore);
}

async function buildSocialContext(simulationId,entityId){
  const [partner,candidates,traits]=await Promise.all([currentPartner(simulationId,entityId),socialCandidates(simulationId,entityId),loadTraits(entityId)]);
  return {partner,candidates,traits};
}

function deriveSocialIntent({actionType,targetId,partner,candidates}){
  if(actionType!=="TALKING" || !targetId)return "NONE";
  const candidate=(candidates||[]).find(x=>x.id===targetId);
  if(!candidate)return "NONE";
  if(candidate.endedRelationship?.type==='PARTNER' && !partner){
    const r=candidate.endedRelationship;
    if(Number(r.affection)>=0.45&&Number(r.trust)>=0.4&&Number(r.closeness)>=0.4)return "RECONCILE";
  }
  if(partner?.partnerId===targetId)return "NONE";
  if(Number(candidate.romanticScore)>=0.62 && Number(candidate.compatibility)>=0.5)return "PURSUE_RELATIONSHIP";
  if(!partner && Number(candidate.romanticScore)<0.32)return "STAY_SINGLE";
  return "NONE";
}

async function writeRelationshipHistory(r,simulationAt,sourceEventId=null){
  await pool.query(`INSERT INTO relationship_history
    (id,simulation_id,relationship_id,simulation_time,affection,trust,respect,familiarity,attraction,conflict,fear,irritation,admiration,jealousy,dependence,closeness,source_event_id)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,UUID_TO_BIN(?))`,
    [uuid(),r.simulation_id,r.id,simulationAt,r.affection_score,r.trust_score,r.respect_score,r.familiarity_score,r.attraction_score,
     r.conflict_score,r.fear_score,r.irritation_score,r.admiration_score,r.jealousy_score,r.dependence_score,r.closeness_score,sourceEventId]);
}

async function endRelationship(relationshipId,simulationAt,reason="ENDED"){ 
  const [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,simulation_id,status,version,affection_score,trust_score,respect_score,familiarity_score,attraction_score,conflict_score,fear_score,admiration_score,jealousy_score,dependence_score,closeness_score,irritation_score FROM relationships WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId]);
  if(!rows.length)return false;
  const r=rows[0];
  const [updated]=await pool.query(`UPDATE relationships SET status='ENDED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?`,[relationshipId,r.version]);
  if(!updated.affectedRows)return false;
  await writeRelationshipHistory(r,simulationAt,null);
  return {id:r.id,reason};
}

async function updateRelationshipScores(simulationId,relationshipId,simulationAt,deltas={},sourceEventId=null){
  const [rows]=await pool.query(`SELECT * FROM relationships WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId,simulationId]);
  if(!rows.length)return null;
  const r=rows[0];
  const next={
    trust_score:clamp(Number(r.trust_score)+Number(deltas.trust||0)),affection_score:clamp(Number(r.affection_score)+Number(deltas.affection||0)),
    respect_score:clamp(Number(r.respect_score)+Number(deltas.respect||0)),familiarity_score:clamp(Number(r.familiarity_score)+Number(deltas.familiarity||0)),
    attraction_score:clamp(Number(r.attraction_score)+Number(deltas.attraction||0)),conflict_score:clamp(Number(r.conflict_score)+Number(deltas.conflict||0)),
    fear_score:clamp(Number(r.fear_score)+Number(deltas.fear||0)),admiration_score:clamp(Number(r.admiration_score)+Number(deltas.admiration||0)),
    jealousy_score:clamp(Number(r.jealousy_score)+Number(deltas.jealousy||0)),dependence_score:clamp(Number(r.dependence_score)+Number(deltas.dependence||0)),
    closeness_score:clamp(Number(r.closeness_score)+Number(deltas.closeness||0)),irritation_score:clamp(Number(r.irritation_score)+Number(deltas.irritation||0))
  };
  const [updated]=await pool.query(`UPDATE relationships SET trust_score=?,affection_score=?,respect_score=?,familiarity_score=?,attraction_score=?,conflict_score=?,fear_score=?,admiration_score=?,jealousy_score=?,dependence_score=?,closeness_score=?,irritation_score=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[next.trust_score,next.affection_score,next.respect_score,next.familiarity_score,next.attraction_score,next.conflict_score,next.fear_score,next.admiration_score,next.jealousy_score,next.dependence_score,next.closeness_score,next.irritation_score,relationshipId,r.version]);
  if(!updated.affectedRows)return null;
  r.simulation_id=simulationId;r.id=relationshipId;Object.assign(r,next);await writeRelationshipHistory(r,simulationAt,sourceEventId);return r;
}

async function setRelationshipType(simulationId,relationshipId,typeCode,simulationAt,sourceEventId=null){
  const [[type]] = await Promise.all([pool.query("SELECT BIN_TO_UUID(id) AS id FROM relationship_types WHERE code=? AND active=1 LIMIT 1",[typeCode]).then(([r])=>[r[0]||null])]);
  if(!type)return null;
  const [rows]=await pool.query(`SELECT * FROM relationships WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[relationshipId,simulationId]);
  if(!rows.length)return null;
  const r=rows[0];
  const [updated]=await pool.query(`UPDATE relationships SET relationship_type_id=UUID_TO_BIN(?),version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[type.id,relationshipId,r.version]);
  if(!updated.affectedRows)return null;
  r.simulation_id=simulationId;r.id=relationshipId;r.relationship_type_id=type.id;await writeRelationshipHistory(r,simulationAt,sourceEventId);return relationshipId;
}

async function recordSocialMemory({simulationId,entityId,targetEntityId,targetName,locationId,simulationAt,eventId,relationshipType,intent,outcome,compatibility,scoreChanges}){
  const direction=entityId===targetEntityId?"":` with ${targetName||targetEntityId}`;
  const label={PURSUE_RELATIONSHIP:"pursuing a romantic relationship",STAY_SINGLE:"choosing to remain single for now",RECONCILE:"trying to reconcile a past relationship",NONE:"having a social interaction"}[intent]||"having a social interaction";
  await createMemory({simulationId,entityId,eventId,locationId,type:"EPISODIC",content:`Social memory: ${label}${direction}. Outcome: ${outcome}. Relationship: ${relationshipType||"NONE"}. Compatibility ${compatibility.toFixed(2)}.`,importance:intent==='STAY_SINGLE'?0.52:0.62,strength:0.95,confidence:0.9,emotionalIntensity:Math.min(1,0.25+Math.abs(Number(scoreChanges?.affection||0))*4+Number(scoreChanges?.conflict||0)),simulationAt,metadata:{social:true,targetEntityId,targetName,intent,outcome,relationshipType,compatibility,scoreChanges}});
}

async function recordBetrayal({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId}){
  const partner=await currentPartner(simulationId,sourceEntityId);
  if(!partner || partner.partnerId===targetEntityId)return null;
  const rel=await relationshipBetween(simulationId,sourceEntityId,partner.partnerId,"ACTIVE");
  if(!rel)return null;
  await updateRelationshipScores(simulationId,rel.id,simulationAt,{jealousy:.3,conflict:.22,irritation:.16,trust:-.2,affection:-.12,closeness:-.08,attraction:-.06},eventId);
  const locationRows=await pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,sourceEntityId]);
  const locationId=locationRows[0][0]?.locationId||null;
  const [names]=await pool.query(`SELECT id,display_name AS name FROM entities WHERE id IN (UUID_TO_BIN(?),UUID_TO_BIN(?))`,[sourceEntityId,partner.partnerId]);
  const partnerName=names.find(n=>n.id)?.name||partner.partnerId;
  await recordSocialMemory({simulationId,entityId:partner.partnerId,targetEntityId:sourceEntityId,targetName:names.find(n=>n.name!==partnerName)?.name||sourceEntityId,locationId,simulationAt,eventId,relationshipType:'PARTNER',intent:'PURSUE_RELATIONSHIP',outcome:'Betrayal detected; jealousy and conflict increased',compatibility:0.5,scoreChanges:{conflict:.22,jealousy:.3,trust:-.2,affection:-.12}});
  if(Number(rel.trust)<0.2 || Number(rel.conflict)>0.8)await endRelationship(rel.id,simulationAt,"BETRAYAL");
  return rel.id;
}

async function requestPartnership({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,compatibility}){
  const sourcePartner=await currentPartner(simulationId,sourceEntityId);if(sourcePartner)return {accepted:false,reason:"SOURCE_ALREADY_PARTNER"};
  const targetPartner=await currentPartner(simulationId,targetEntityId);if(targetPartner)return {accepted:false,reason:"TARGET_ALREADY_PARTNER"};
  const rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");
  if(!rel)return {accepted:false,reason:"NO_ACTIVE_RELATIONSHIP"};
  const acceptance=clamp(Number(rel.affection)*.35+Number(rel.trust)*.25+Number(rel.closeness)*.2+Number(rel.attraction)*.1+compatibility*.1);
  if(acceptance<0.5 || Number(rel.conflict)>.62 || Number(rel.irritation)>.65)return {accepted:false,reason:"NOT_READY"};
  const relationshipId=await setRelationshipType(simulationId,rel.id,'PARTNER',simulationAt,eventId);
  await updateRelationshipScores(simulationId,relationshipId,simulationAt,{affection:.06,closeness:.06,trust:.03,attraction:.08,dependence:.02},eventId);
  return {accepted:Boolean(relationshipId),relationshipId,acceptance};
}

async function reconcileRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId}){
  const sourcePartner=await currentPartner(simulationId,sourceEntityId);if(sourcePartner)return {accepted:false,reason:"SOURCE_ALREADY_PARTNER"};
  const targetPartner=await currentPartner(simulationId,targetEntityId);if(targetPartner)return {accepted:false,reason:"TARGET_ALREADY_PARTNER"};
  const rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ENDED");
  if(!rel || rel.type!=='PARTNER')return {accepted:false,reason:"NO_ENDED_PARTNER"};
  const ageHours=Math.max(0,(new Date(simulationAt)-new Date(rel.startedSimulationAt))/3600000);
  if(ageHours<0 || ageHours>24*60)return {accepted:false,reason:"TOO_OLD"};
  if(Number(rel.affection)<.35 || Number(rel.trust)<.3 || Number(rel.closeness)<.3)return {accepted:false,reason:"BOND_TOO_WEAK"};
  const relationshipId=await setRelationshipType(simulationId,rel.id,'PARTNER',simulationAt,eventId);
  await updateRelationshipScores(simulationId,relationshipId,simulationAt,{affection:.04,closeness:.05,trust:.05,conflict:-.08,irritation:-.08},eventId);
  return {accepted:Boolean(relationshipId),relationshipId};
}

async function processSocialInteraction({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,locationId,relationshipIntent="NONE"}){
  const [sourceLoc,targetLoc]=await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,sourceEntityId]),
    pool.query(`SELECT BIN_TO_UUID(location_id) AS locationId FROM entity_locations_current WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,targetEntityId])
  ]);
  const sourceLocation=sourceLoc[0][0]?.locationId||null,targetLocation=targetLoc[0][0]?.locationId||null;
  if(!sourceLocation||sourceLocation!==targetLocation)return {outcome:"NO_CONTACT",relationshipIntent};
  const sourceTraits=await loadTraits(sourceEntityId),targetTraits=await loadTraits(targetEntityId);
  const compatibility=compatibilityFromTraits(sourceTraits,targetTraits);
  let rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");
  if(!rel){await upsertInteractionRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,typeCode:'ACQUAINTANCE',sourceEventId:eventId,deltas:{}});rel=await relationshipBetween(simulationId,sourceEntityId,targetEntityId,"ACTIVE");}
  const friction=clamp(Number(rel?.conflict||0)*.7+Number(rel?.irritation||0)*.3);
  const difficult=friction>.45 || compatibility<.38 ? true : (Math.random() < .08);
  const deltas=difficult
    ? {familiarity:.006,closeness:-.004,affection:-.008,trust:-.012,attraction:-.006,respect:-.004,conflict:.045+Math.max(0,.5-compatibility)*.04,irritation:.05+friction*.03,jealousy:friction*.025}
    : {familiarity:.015,closeness:.008,affection:.004,trust:.002,attraction:.003,respect:.002,conflict:-.006,irritation:-.008};
  rel=await updateRelationshipScores(simulationId,rel.id,simulationAt,deltas,eventId) || rel;
  let outcome=difficult?"Tense interaction":"Positive interaction";
  let relationshipResult=null;
  if(relationshipIntent==='PURSUE_RELATIONSHIP'){
    await recordBetrayal({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId});
    relationshipResult=await requestPartnership({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId,compatibility});
    outcome=relationshipResult.accepted?"Romantic relationship started":"Romantic interest declined or postponed";
  }else if(relationshipIntent==='RECONCILE'){
    relationshipResult=await reconcileRelationship({simulationId,sourceEntityId,targetEntityId,simulationAt,eventId});
    outcome=relationshipResult.accepted?"Relationship reconciled":"Reconciliation was not accepted";
  }else if(relationshipIntent==='STAY_SINGLE'){
    outcome="Entity chose to remain single for now";
  }
  const [targetRow]=await pool.query(`SELECT display_name AS name FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`,[targetEntityId]);
  const targetName=targetRow[0]?.name||targetEntityId;
  await recordSocialMemory({simulationId,entityId:sourceEntityId,targetEntityId,targetName,locationId:sourceLocation,simulationAt,eventId,relationshipType:relationshipResult?.accepted?'PARTNER':rel.type,intent:relationshipIntent,outcome,compatibility,scoreChanges:deltas});
  await recordSocialMemory({simulationId,entityId:targetEntityId,targetEntityId:sourceEntityId,targetName:(await pool.query(`SELECT display_name AS name FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`,[sourceEntityId]))[0][0]?.name||sourceEntityId,locationId:sourceLocation,simulationAt,eventId,relationshipType:relationshipResult?.accepted?'PARTNER':rel.type,intent:relationshipResult?.accepted?'PURSUE_RELATIONSHIP':'NONE',outcome,compatibility,scoreChanges:deltas});
  return {relationshipId:rel.id,relationshipIntent,outcome,compatibility,relationshipResult};
}

async function maintainRelationships(simulationId,simulationTime){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(r.id) AS id,r.simulation_id,r.version,rt.code AS type,
      BIN_TO_UUID(r.source_entity_id) AS sourceEntityId,BIN_TO_UUID(r.target_entity_id) AS targetEntityId,
      r.affection_score affection,r.trust_score trust,r.respect_score respect,r.familiarity_score familiarity,
      r.attraction_score attraction,r.conflict_score conflict,r.fear_score fear,r.admiration_score admiration,
      r.jealousy_score jealousy,r.dependence_score dependence,r.closeness_score closeness,r.irritation_score irritation,
      COALESCE(MAX(CASE WHEN a.action_type='TALKING' AND a.status='COMPLETED' AND JSON_UNQUOTE(JSON_EXTRACT(a.parameters,'$.targetEntityId'))=BIN_TO_UUID(CASE WHEN r.source_entity_id=a.entity_id THEN r.target_entity_id ELSE r.source_entity_id END) THEN a.started_simulation_at END),r.started_simulation_at) lastInteraction
    FROM relationships r JOIN relationship_types rt ON rt.id=r.relationship_type_id
    LEFT JOIN actions a ON a.simulation_id=r.simulation_id AND (a.entity_id=r.source_entity_id OR a.entity_id=r.target_entity_id)
    WHERE r.simulation_id=UUID_TO_BIN(?) AND r.status='ACTIVE' AND rt.code IN ('ACQUAINTANCE','FRIEND','PARTNER')
    GROUP BY r.id,r.simulation_id,r.version,rt.code,r.source_entity_id,r.target_entity_id,r.affection_score,r.trust_score,r.respect_score,r.familiarity_score,r.attraction_score,r.conflict_score,r.fear_score,r.admiration_score,r.jealousy_score,r.dependence_score,r.closeness_score,r.irritation_score,r.started_simulation_at
  `,[simulationId]);
  for(const r of rows){
    const hours=Math.max(0,(new Date(simulationTime)-new Date(r.lastInteraction))/3600000);
    if(hours<12)continue;
    const days=Math.min(3,hours/24);
    if(r.type==='PARTNER'){
      await updateRelationshipScores(simulationId,r.id,simulationTime,{familiarity:-.002*days,closeness:-.012*days,affection:-.010*days,trust:-.004*days,conflict:.012*days,irritation:.014*days,jealousy:.006*days});
      const [current]=await pool.query(`SELECT trust_score,affection_score,conflict_score FROM relationships WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[r.id]);
      if(current.length && (Number(current[0].trust_score)<.15 || Number(current[0].affection_score)<.12 || Number(current[0].conflict_score)>.8))await endRelationship(r.id,simulationTime,"PROLONGED_CONFLICT_OR_NEGLECT");
    }else{
      await updateRelationshipScores(simulationId,r.id,simulationTime,{familiarity:-.006*days,closeness:-.008*days,affection:-.005*days,trust:-.002*days,conflict:.003*days,irritation:.002*days});
      const [current]=await pool.query(`SELECT familiarity_score,closeness_score FROM relationships WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' LIMIT 1`,[r.id]);
      if(r.type==='FRIEND' && current.length && Number(current[0].familiarity_score)<.04 && Number(current[0].closeness_score)<.025){
        await setRelationshipType(simulationId,r.id,'ACQUAINTANCE',simulationTime,null);
      }else if(r.type==='ACQUAINTANCE' && current.length && Number(current[0].familiarity_score)<.01 && Number(current[0].closeness_score)<.005 && hours>24*30){
        await endRelationship(r.id,simulationTime,"RELATIONSHIP_FADED");
      }
    }
  }
  return rows.length;
}

module.exports={
  buildSocialContext,compatibilityFromTraits,deriveSocialIntent,processSocialInteraction,maintainRelationships,
  getRelationshipBetween:relationshipBetween,currentPartner,requestPartnership,reconcileRelationship,recordBetrayal,endRelationship
};
