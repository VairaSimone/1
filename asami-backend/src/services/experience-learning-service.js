const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function clampSigned(value, maxAbs = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-maxAbs, Math.min(maxAbs, n)) : 0;
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function isSignificantExperience({ outcome, targetEntityId, relationshipIntent, resource, needChanges }) {
  const normalizedOutcome = normalize(outcome);
  if (normalizedOutcome === "FAILURE" || normalizedOutcome === "PARTIAL") return true;
  if (targetEntityId || (relationshipIntent && normalize(relationshipIntent) !== "NONE")) return true;
  if (resource?.resource && (Number(resource.consumed) > 0 || Number(resource.remaining) <= 0)) return true;
  return (needChanges || []).some(change => Math.abs(Number(change?.delta || 0)) >= 0.35);
}

function shouldCreateExperiencePreference({ outcome, needChanges = [], interrupted = false }) {
  if (interrupted) return false;
  const normalizedOutcome = normalize(outcome);
  if (normalizedOutcome === "FAILURE" || normalizedOutcome === "PARTIAL") return true;
  return (needChanges || []).some(change => Math.abs(Number(change?.delta || 0)) >= 0.35);
}

function outcomeLearningSignal(outcome) {
  const normalized = normalize(outcome);
  if (normalized === "SUCCESS") return 0.12;
  if (normalized === "PARTIAL") return -0.055;
  if (normalized === "FAILURE") return -0.09;
  return 0;
}

function computeLearningStrength({ outcome, confidence = 0.7, repetition = 0, contextSimilarity = 0.5, interrupted = false }) {
  if (interrupted) return 0;
  const signal = outcomeLearningSignal(outcome);
  if (!signal) return 0;
  const confidenceFactor = clamp01(confidence, 0.7);
  const repetitionFactor = Math.min(1, 0.15 + Math.max(0, Number(repetition) || 0) * 0.85);
  const contextFactor = 0.35 + 0.65 * clamp01(contextSimilarity, 0.5);
  return clampSigned(signal * confidenceFactor * repetitionFactor * contextFactor, 0.25);
}

async function loadExperienceRepetition({ simulationId, entityId, actionType, locationId, locationType, targetEntityId }) {
  const [rows] = await pool.query(`
    SELECT action_type AS actionType,result
    FROM actions
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='COMPLETED'
    ORDER BY completed_simulation_at DESC LIMIT 48
  `, [simulationId, entityId]);

  const normalizedAction = normalize(actionType);
  let sameActionCount = 0;
  let similarContextCount = 0;
  for (const row of rows) {
    if (normalize(row.actionType) !== normalizedAction) continue;
    sameActionCount += 1;
    const result = parseJson(row.result, {}) || {};
    const sameTarget = targetEntityId && result.targetEntityId && String(targetEntityId) === String(result.targetEntityId);
    const sameLocation = locationId && (result.targetLocationId === locationId || result.locationId === locationId);
    const sameLocationType = locationType && normalize(result.locationType) === normalize(locationType);
    if (sameTarget || sameLocation || sameLocationType) similarContextCount += 1;
  }

  return {
    sameActionCount,
    similarContextCount,
    repetition: Math.min(1, (sameActionCount + 1) / 8),
    contextSimilarity: sameActionCount ? Math.min(1, (similarContextCount + 1) / (sameActionCount + 1)) : 0.35
  };
}

async function upsertExperiencePreference({ simulationId, entityId, simulationTime, targetType, value, strength, confidence }) {
  const normalizedType = normalize(targetType);
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,version,preference_value,strength,confidence
    FROM preferences
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      AND target_type=? AND target_entity_id IS NULL
    ORDER BY updated_simulation_at DESC LIMIT 1
  `, [simulationId, entityId, normalizedType]);

  const signedValue = clampSigned(value, 1);
  const learningWeight = Math.max(0.025, Math.min(0.22, Math.abs(Number(strength)) || 0.025));
  if (!rows.length) {
    const id = uuid();
    await pool.query(`
      INSERT INTO preferences
        (id,simulation_id,entity_id,target_type,target_entity_id,preference_value,strength,confidence,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,NULL,?,?,?,?,?,1)
    `, [id, simulationId, entityId, normalizedType, signedValue * learningWeight, clamp01(Math.abs(strength), 0.05), clamp01(confidence, 0.7), simulationTime, simulationTime]);
    return id;
  }

  const current = rows[0];
  const currentValue = clampSigned(current.preference_value, 1);
  const nextValue = clampSigned(currentValue * (1 - learningWeight) + signedValue * learningWeight, 1);
  const nextStrength = clamp01(Number(current.strength) * 0.82 + Math.abs(Number(strength) || 0) * 0.18);
  const nextConfidence = clamp01(Number(current.confidence) * 0.8 + clamp01(confidence, 0.7) * 0.2);
  const [updated] = await pool.query(`
    UPDATE preferences SET preference_value=?,strength=?,confidence=?,updated_simulation_at=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=?
  `, [nextValue, nextStrength, nextConfidence, simulationTime, current.id, current.version]);
  return updated.affectedRows ? current.id : null;
}

async function upsertExperienceBelief({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence }) {
  const predicate = `ACTION_OUTCOME_${normalize(actionType).slice(0, 70)}`;
  const objectValue = { actionType: normalize(actionType), outcome: normalize(outcome), locationId: locationId || null, resource: resource || null, consequence: consequence || null };
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,version,confidence,importance
    FROM beliefs
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      AND predicate=? AND subject_entity_id IS NULL
    ORDER BY updated_simulation_at DESC LIMIT 1
  `, [simulationId, entityId, predicate]);

  const confidence = normalize(outcome) === "FAILURE" ? 0.9 : normalize(outcome) === "PARTIAL" ? 0.74 : 0.78;
  const importance = normalize(outcome) === "FAILURE" ? 0.85 : normalize(outcome) === "PARTIAL" ? 0.7 : 0.62;
  if (!rows.length) {
    const id = uuid();
    await pool.query(`
      INSERT INTO beliefs
        (id,simulation_id,entity_id,subject_entity_id,predicate,object_value,confidence,importance,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,CAST(? AS JSON),?,?, 'ACTIVE',?,?,1)
    `, [id, simulationId, entityId, predicate, JSON.stringify(objectValue), confidence, importance, simulationTime, simulationTime]);
    return id;
  }

  const current = rows[0];
  const nextConfidence = clamp01(Number(current.confidence) * 0.7 + confidence * 0.3);
  const nextImportance = Math.max(Number(current.importance), importance);
  const [updated] = await pool.query(`
    UPDATE beliefs SET object_value=CAST(? AS JSON),confidence=?,importance=?,status='REVISED',updated_simulation_at=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=?
  `, [JSON.stringify(objectValue), nextConfidence, nextImportance, simulationTime, current.id, current.version]);
  return updated.affectedRows ? current.id : null;
}

async function recordExperienceKnowledge({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence, learning }) {
  const payload = { source: "ACTION_EXPERIENCE", actionType: normalize(actionType), outcome: normalize(outcome), locationId: locationId || null, resource: resource || null, consequence: consequence || null, learning: learning || null, learnedAt: simulationTime };
  const content = JSON.stringify(payload);
  const [existing] = await pool.query(`
    SELECT BIN_TO_UUID(ki.id) AS id,ek.version,ek.confidence,ek.importance
    FROM knowledge_items ki
    JOIN entity_knowledge ek ON ek.knowledge_item_id=ki.id AND ek.entity_id=UUID_TO_BIN(?)
    WHERE ki.simulation_id=UUID_TO_BIN(?) AND ki.knowledge_type='WORLD_EXPERIENCE' AND ki.predicate='ACTION_OUTCOME' AND ki.content=?
    LIMIT 1
  `, [entityId, simulationId, content]);
  const confidence = normalize(outcome) === "FAILURE" ? 0.96 : normalize(outcome) === "PARTIAL" ? 0.8 : 0.8;
  const importance = normalize(outcome) === "FAILURE" ? 0.9 : normalize(outcome) === "PARTIAL" ? 0.68 : 0.65;
  if (!existing.length) {
    const knowledgeId = uuid();
    await pool.query(`
      INSERT INTO knowledge_items
        (id,simulation_id,knowledge_type,subject_entity_id,predicate,object_entity_id,content,metadata,created_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'WORLD_EXPERIENCE',UUID_TO_BIN(?),'ACTION_OUTCOME',UUID_TO_BIN(?),?,?,?)
    `, [knowledgeId, simulationId, entityId, locationId, content, JSON.stringify({ source: "action_experience", schemaVersion: 2 }), simulationTime]);
    await pool.query(`
      INSERT INTO entity_knowledge
        (entity_id,simulation_id,knowledge_item_id,confidence,importance,learned_simulation_at,last_reinforced_at,status,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,'ACTIVE',1)
    `, [entityId, simulationId, knowledgeId, confidence, importance, simulationTime, simulationTime]);
    return knowledgeId;
  }
  const current = existing[0];
  const nextConfidence = clamp01(Number(current.confidence) * 0.75 + confidence * 0.25);
  const nextImportance = Math.max(Number(current.importance), importance);
  const [updated] = await pool.query(`
    UPDATE entity_knowledge SET confidence=?,importance=?,last_reinforced_at=?,version=version+1
    WHERE entity_id=UUID_TO_BIN(?) AND knowledge_item_id=UUID_TO_BIN(?) AND version=?
  `, [nextConfidence, nextImportance, simulationTime, entityId, current.id, current.version]);
  return updated.affectedRows ? current.id : null;
}

async function consolidateSemanticEvidence({ simulationId, entityId, simulationTime, actionType, outcome, locationId, locationType, resource, learning }) {
  if (!locationId || !resource) return { consolidated: false, reliability: null, beliefId: null, preferenceId: null };
  const normalizedResource = String(resource).trim().toLowerCase();
  if (!normalizedResource) return { consolidated: false, reliability: null, beliefId: null, preferenceId: null };

  const [rows] = await pool.query(`
    SELECT ki.content
    FROM knowledge_items ki
    JOIN entity_knowledge ek ON ek.knowledge_item_id=ki.id AND ek.entity_id=UUID_TO_BIN(?) AND ek.status='ACTIVE'
    WHERE ki.simulation_id=UUID_TO_BIN(?)
      AND ki.knowledge_type='WORLD_EXPERIENCE'
      AND ki.predicate='ACTION_OUTCOME'
      AND JSON_UNQUOTE(JSON_EXTRACT(ki.content,'$.locationId'))=?
      AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ki.content,'$.resource')),''))=?
    ORDER BY ki.created_simulation_at DESC LIMIT 32
  `, [entityId, simulationId, locationId, normalizedResource]);

  let success = 0;
  let partial = 0;
  let failure = 0;
  for (const row of rows) {
    const item = parseJson(row.content, {}) || {};
    if (normalize(item.outcome) === "SUCCESS") success += 1;
    else if (normalize(item.outcome) === "PARTIAL") partial += 1;
    else if (normalize(item.outcome) === "FAILURE") failure += 1;
  }
  const observations = success + partial + failure;
  if (observations < 3) return { consolidated: false, reliability: null, beliefId: null, preferenceId: null, observations };

  const reliability = (success + partial * 0.5) / observations;
  const confidence = Math.min(0.95, 0.45 + Math.min(1, observations / 12) * 0.5);
  const semanticOutcome = reliability >= 0.75 ? "RELIABLE" : reliability <= 0.35 ? "UNRELIABLE" : "MIXED";
  const predicate = `LOCATION_RESOURCE_${normalizeResource.slice(0, 40)}`;
  const objectValue = { locationId, locationType: locationType || null, resource: normalizedResource, reliability:Number(reliability.toFixed(4)), observations, success, partial, failure, status: semanticOutcome, learning: learning || null, consolidatedAt: simulationTime };

  const [existingBeliefs] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,version,confidence,importance
    FROM beliefs
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND predicate=? AND subject_entity_id IS NULL
    ORDER BY updated_simulation_at DESC LIMIT 1
  `, [simulationId, entityId, predicate]);

  let beliefId = null;
  if (!existingBeliefs.length) {
    beliefId = uuid();
    await pool.query(`
      INSERT INTO beliefs
        (id,simulation_id,entity_id,subject_entity_id,predicate,object_value,confidence,importance,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,?,CAST(? AS JSON),?,?, 'ACTIVE',?,?,1)
    `, [beliefId, simulationId, entityId, predicate, JSON.stringify(objectValue), confidence, semanticOutcome === "MIXED" ? 0.62 : 0.8, simulationTime, simulationTime]);
  } else {
    const current = existingBeliefs[0];
    const nextConfidence = clamp01(Number(current.confidence) * 0.7 + confidence * 0.3);
    const nextImportance = Math.max(Number(current.importance), semanticOutcome === "MIXED" ? 0.62 : 0.8);
    const [updated] = await pool.query(`
      UPDATE beliefs SET object_value=CAST(? AS JSON),confidence=?,importance=?,status='REVISED',updated_simulation_at=?,version=version+1
      WHERE id=UUID_TO_BIN(?) AND version=?
    `, [JSON.stringify(objectValue), nextConfidence, nextImportance, simulationTime, current.id, current.version]);
    if (updated.affectedRows) beliefId = current.id;
  }

  let preferenceId = null;
  if (locationType) {
    const preferenceValue = semanticOutcome === "RELIABLE" ? 1 : semanticOutcome === "UNRELIABLE" ? -1 : 0;
    const preferenceStrength = Math.max(0.03, Math.min(0.22, Math.abs(reliability - 0.5) * 0.38 * Math.min(1, observations / 8)));
    preferenceId = await upsertExperiencePreference({
      simulationId,
      entityId,
      simulationTime,
      targetType: `LOCATION_RESOURCE:${normalize(locationType).slice(0, 18)}:${normalizedResource.slice(0, 18)}`,
      value: preferenceValue,
      strength: preferenceStrength,
      confidence
    });
  }

  return { consolidated: true, reliability, observations, success, partial, failure, status: semanticOutcome, beliefId, preferenceId };
}

function habitActionForProfile(profile, actionType, simulationTime) {
  const action = normalize(actionType);
  const date = new Date(simulationTime || Date.now());
  const currentHour = date.getUTCHours() + date.getUTCMinutes() / 60;
  let best = null;
  for (const habit of profile?.habits || []) {
    const habitAction = normalize(habit.actionDefinition?.actionType || habit.actionType);
    if (habitAction !== action) continue;
    const trigger = habit.triggerDefinition || {};
    let triggerMatch = 0.5;
    if (normalize(trigger.type) === "TIME_WINDOW" && Number.isFinite(Number(trigger.hour))) {
      let distance = Math.abs(currentHour - Number(trigger.hour));
      distance = Math.min(distance, 24 - distance);
      const tolerance = Math.max(0.25, Number(trigger.toleranceHours || 2));
      triggerMatch = distance > tolerance ? 0 : 1 - distance / tolerance;
    }
    const strength = clamp01(habit.strength);
    const score = strength * triggerMatch;
    if (!best || score > best.score) best = { score, strength, triggerMatch };
  }
  return best;
}

function cognitiveExperienceModifier(profile, actionType, { locationType = null, locationId = null, simulationTime = Date.now() } = {}) {
  if (!profile || !actionType) return 0;
  const actionKey = `ACTION:${normalize(actionType)}`;
  const locationKey = locationType ? `LOCATION_ACTION:${normalize(locationType)}:${normalize(actionType)}` : null;
  let preferenceModifier = 0;
  for (const preference of profile.preferences || []) {
    const target = normalize(preference.targetType);
    if (target !== actionKey && target !== locationKey) continue;
    const weight = Number(preference.preferenceValue || 0) * Number(preference.strength || 0) * Number(preference.confidence || 0);
    preferenceModifier += weight * (target === locationKey ? 0.6 : 0.8);
  }

  let beliefModifier = 0;
  const actionPredicate = `ACTION_OUTCOME_${normalize(actionType).slice(0, 70)}`;
  for (const belief of profile.beliefs || []) {
    if (normalize(belief.predicate) !== actionPredicate) continue;
    const value = belief.objectValue || {};
    if (locationId && value.locationId && value.locationId !== locationId) continue;
    const confidence = Number(belief.confidence || 0);
    if (normalize(value.outcome) === "FAILURE") beliefModifier -= 0.08 * confidence;
    else if (normalize(value.outcome) === "SUCCESS") beliefModifier += 0.04 * confidence;
  }

  let semanticModifier = 0;
  const actionResourceKeys = [];
  if (locationType) actionResourceKeys.push(`LOCATION_RESOURCE:${normalize(locationType)}`);
  for (const preference of profile.preferences || []) {
    const target = normalize(preference.targetType);
    if (!actionResourceKeys.some(key => target.startsWith(key))) continue;
    semanticModifier += Number(preference.preferenceValue || 0) * Number(preference.strength || 0) * Number(preference.confidence || 0) * 0.45;
  }

  const habit = habitActionForProfile(profile, actionType, simulationTime);
  const habitModifier = habit ? 0.18 * habit.score : 0;

  return Math.max(-0.35, Math.min(0.35, preferenceModifier + beliefModifier + semanticModifier + habitModifier));
}

async function recordSignificantExperience({ simulationId, entityId, simulationTime, actionType, outcome, locationId = null, locationType = null, targetEntityId = null, resource = null, needChanges = [], relationshipIntent = "NONE", consequence = null, learning = null, interrupted = false }) {
  if (!isSignificantExperience({ outcome, targetEntityId, relationshipIntent, resource, needChanges })) return { significant: false, preferenceIds: [], beliefId: null, knowledgeId: null, semantic: null, learningStrength: 0 };

  const normalizedOutcome = normalize(outcome);
  const evidence = await loadExperienceRepetition({ simulationId, entityId, actionType, locationId, locationType, targetEntityId });
  const confidence = normalizedOutcome === "FAILURE" ? 0.96 : normalizedOutcome === "PARTIAL" ? 0.8 : 0.72;
  const learningStrength = computeLearningStrength({ outcome: normalizedOutcome, confidence, repetition: evidence.repetition, contextSimilarity: evidence.contextSimilarity, interrupted });
  const preferenceIds = [];

  if (shouldCreateExperiencePreference({ outcome: normalizedOutcome, needChanges, interrupted })) {
    const actionId = await upsertExperiencePreference({ simulationId, entityId, simulationTime, targetType: `ACTION:${normalize(actionType).slice(0, 70)}`, value: Math.sign(learningStrength), strength: Math.abs(learningStrength), confidence });
    if (actionId) preferenceIds.push(actionId);
    if (locationType) {
      const locationActionId = await upsertExperiencePreference({ simulationId, entityId, simulationTime, targetType: `LOCATION_ACTION:${normalize(locationType).slice(0, 35)}:${normalize(actionType).slice(0, 35)}`, value: Math.sign(learningStrength), strength: Math.abs(learningStrength) * 0.9, confidence: confidence * 0.95 });
      if (locationActionId) preferenceIds.push(locationActionId);
    }
  }

  const beliefId = await upsertExperienceBelief({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence });
  const knowledgeId = await recordExperienceKnowledge({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence, learning });
  const semantic = await consolidateSemanticEvidence({ simulationId, entityId, simulationTime, actionType, outcome, locationId, locationType, resource, learning });
  return { significant: true, preferenceIds, beliefId, knowledgeId, semantic, learningStrength, evidence };
}

module.exports = { isSignificantExperience, shouldCreateExperiencePreference, outcomeLearningSignal, computeLearningStrength, recordSignificantExperience, consolidateSemanticEvidence, cognitiveExperienceModifier, habitActionForProfile };
