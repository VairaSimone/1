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
  const meaningfulNeedChange = (needChanges || []).some(change => Math.abs(Number(change?.delta || 0)) >= 0.35);
  return meaningfulNeedChange;
}

function shouldCreateExperiencePreference({ outcome, needChanges = [] }) {
  const normalizedOutcome = normalize(outcome);
  if (normalizedOutcome === "FAILURE" || normalizedOutcome === "PARTIAL") return true;
  return (needChanges || []).some(change => Math.abs(Number(change?.delta || 0)) >= 0.35);
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

  if (!rows.length) {
    const id = uuid();
    await pool.query(`
      INSERT INTO preferences
        (id,simulation_id,entity_id,target_type,target_entity_id,preference_value,strength,confidence,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,NULL,?,?,?,?,?,1)
    `, [id, simulationId, entityId, normalizedType, clampSigned(value), clamp01(strength, 0.35), clamp01(confidence, 0.7), simulationTime, simulationTime]);
    return id;
  }

  const current = rows[0];
  const nextValue = clampSigned(Number(current.preference_value) * 0.65 + clampSigned(value) * 0.35);
  const nextStrength = clamp01(Number(current.strength) * 0.7 + clamp01(strength, 0.35) * 0.3);
  const nextConfidence = clamp01(Number(current.confidence) * 0.7 + clamp01(confidence, 0.7) * 0.3);
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

  const confidence = normalize(outcome) === "FAILURE" ? 0.9 : 0.78;
  const importance = normalize(outcome) === "FAILURE" ? 0.85 : 0.62;
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
  const payload = {
    source: "ACTION_EXPERIENCE",
    actionType: normalize(actionType),
    outcome: normalize(outcome),
    locationId: locationId || null,
    resource: resource || null,
    consequence: consequence || null,
    learning: learning || null,
    learnedAt: simulationTime
  };
  const content = JSON.stringify(payload);
  const [existing] = await pool.query(`
    SELECT BIN_TO_UUID(ki.id) AS id,ek.version,ek.confidence,ek.importance
    FROM knowledge_items ki
    JOIN entity_knowledge ek ON ek.knowledge_item_id=ki.id AND ek.entity_id=UUID_TO_BIN(?)
    WHERE ki.simulation_id=UUID_TO_BIN(?) AND ki.knowledge_type='WORLD_EXPERIENCE' AND ki.predicate='ACTION_OUTCOME' AND ki.content=?
    LIMIT 1
  `, [entityId, simulationId, content]);
  const confidence = normalize(outcome) === "FAILURE" ? 0.96 : 0.8;
  const importance = normalize(outcome) === "FAILURE" ? 0.9 : 0.65;
  if (!existing.length) {
    const knowledgeId = uuid();
    await pool.query(`
      INSERT INTO knowledge_items
        (id,simulation_id,knowledge_type,subject_entity_id,predicate,object_entity_id,content,metadata,created_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'WORLD_EXPERIENCE',UUID_TO_BIN(?),'ACTION_OUTCOME',UUID_TO_BIN(?),?,?,?)
    `, [knowledgeId, simulationId, entityId, locationId, content, JSON.stringify({ source: "action_experience", schemaVersion: 1 }), simulationTime]);
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

async function recordSignificantExperience({ simulationId, entityId, simulationTime, actionType, outcome, locationId = null, locationType = null, targetEntityId = null, resource = null, needChanges = [], relationshipIntent = "NONE", consequence = null, learning = null }) {
  if (!isSignificantExperience({ outcome, targetEntityId, relationshipIntent, resource, needChanges })) return { significant: false, preferenceIds: [], beliefId: null, knowledgeId: null };

  const normalizedOutcome = normalize(outcome);
  const valence = normalizedOutcome === "SUCCESS" ? 1 : normalizedOutcome === "PARTIAL" ? -0.15 : -1;
  const confidence = normalizedOutcome === "FAILURE" ? 0.96 : normalizedOutcome === "PARTIAL" ? 0.8 : 0.72;
  const strength = normalizedOutcome === "FAILURE" ? 0.62 : 0.42;
  const preferenceIds = [];

  if (shouldCreateExperiencePreference({ outcome: normalizedOutcome, needChanges })) {
    const actionId = await upsertExperiencePreference({
      simulationId, entityId, simulationTime,
      targetType: `ACTION:${normalize(actionType).slice(0, 70)}`,
      value: valence,
      strength,
      confidence
    });
    if (actionId) preferenceIds.push(actionId);

    if (locationType) {
      const locationActionId = await upsertExperiencePreference({
        simulationId, entityId, simulationTime,
        targetType: `LOCATION_ACTION:${normalize(locationType).slice(0, 35)}:${normalize(actionType).slice(0, 35)}`,
        value: valence,
        strength: strength * 0.9,
        confidence: confidence * 0.95
      });
      if (locationActionId) preferenceIds.push(locationActionId);
    }
  }

  const beliefId = await upsertExperienceBelief({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence });
  const knowledgeId = await recordExperienceKnowledge({ simulationId, entityId, simulationTime, actionType, outcome, locationId, resource, consequence, learning });
  return { significant: true, preferenceIds, beliefId, knowledgeId };
}

function cognitiveExperienceModifier(profile, actionType, { locationType = null, locationId = null } = {}) {
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
    const sameLocation = !locationId || !value.locationId || value.locationId === locationId;
    if (!sameLocation) continue;
    const confidence = Number(belief.confidence || 0);
    if (normalize(value.outcome) === "FAILURE") beliefModifier -= 0.08 * confidence;
    else if (normalize(value.outcome) === "SUCCESS") beliefModifier += 0.04 * confidence;
  }

  // Knowledge is retained as episodic/world memory, not converted directly into an action preference.
  return Math.max(-0.35, Math.min(0.35, preferenceModifier + beliefModifier));
}

module.exports = {
  isSignificantExperience,
  shouldCreateExperiencePreference,
  recordSignificantExperience,
  cognitiveExperienceModifier
};
