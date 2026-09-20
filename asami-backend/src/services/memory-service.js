const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const DECAY_BATCH_SIZE = 250;
const DECAY_CHECKPOINT_MINUTES = 360;
const DECAY_PER_HOUR_FACTOR = 0.997;
const lastDecayCheckBySimulation = new Map();

function compactMemoryMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata || null;

  const compact = { ...metadata };
  delete compact.context;
  delete compact.cognitive;

  if (metadata.cognitive && typeof metadata.cognitive === "object") {
    const cognitive = metadata.cognitive;
    compact.cognitiveRefs = {
      preferenceIds: Array.isArray(cognitive.preferenceIds) ? cognitive.preferenceIds.slice(0, 8) : [],
      beliefId: cognitive.beliefId || null,
      knowledgeId: cognitive.knowledgeId || null,
      semantic: cognitive.semantic ? {
        consolidated: Boolean(cognitive.semantic.consolidated),
        reliability: Number.isFinite(Number(cognitive.semantic.reliability)) ? Number(Number(cognitive.semantic.reliability).toFixed(4)) : null,
        observations: Number.isFinite(Number(cognitive.semantic.observations)) ? Number(cognitive.semantic.observations) : 0,
        beliefId: cognitive.semantic.beliefId || null,
        preferenceId: cognitive.semantic.preferenceId || null
      } : null,
      learningStrength: Number.isFinite(Number(cognitive.learningStrength))
        ? Number(Number(cognitive.learningStrength).toFixed(4))
        : null
    };
  }

  if (Array.isArray(compact.needChanges)) {
    compact.needChanges = compact.needChanges
      .map(change => ({
        code: change?.code || null,
        delta: Number.isFinite(Number(change?.delta)) ? Number(Number(change.delta).toFixed(4)) : null,
        new: Number.isFinite(Number(change?.new)) ? Number(Number(change.new).toFixed(4)) : null
      }))
      .filter(change => change.code)
      .sort((a, b) => Math.abs(Number(b.delta || 0)) - Math.abs(Number(a.delta || 0)))
      .slice(0, 6);
  }

  if (compact.decision && typeof compact.decision === "object") {
    compact.decision = {
      decisionId: compact.decision.decisionId || null,
      actionType: compact.decision.actionType || null,
      goalId: compact.decision.goalId || null,
      confidence: Number.isFinite(Number(compact.decision.confidence))
        ? Number(Number(compact.decision.confidence).toFixed(4))
        : null,
      reason: String(compact.decision.reason || "").slice(0, 240) || null
    };
  }

  if (compact.location && typeof compact.location === "object") {
    compact.location = {
      id: compact.location.id || null,
      type: compact.location.type || null,
      label: String(compact.location.label || "").slice(0, 160) || null
    };
  }

  if (compact.resource && typeof compact.resource === "object") {
    compact.resource = {
      resource: compact.resource.resource || null,
      consumed: Number.isFinite(Number(compact.resource.consumed)) ? Number(compact.resource.consumed) : null,
      remaining: Number.isFinite(Number(compact.resource.remaining)) ? Number(compact.resource.remaining) : null,
      ok: compact.resource.ok === undefined ? null : Boolean(compact.resource.ok)
    };
  }

  if (compact.resourceLearning && typeof compact.resourceLearning === "object") {
    compact.resourceLearning = {
      type: compact.resourceLearning.type || null,
      resource: compact.resourceLearning.resource || null,
      locationId: compact.resourceLearning.locationId || null
    };
  }

  return compact;
}


function assertSimulationTime(value) {
  if (value === null || value === undefined || value === "") {
    throw Object.assign(
      new Error("Simulation time is required for cognitive memory operations"),
      { code: "SIMULATION_TIME_REQUIRED" }
    );
  }

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(
      new Error("Invalid simulation time for cognitive memory operation"),
      { code: "INVALID_SIMULATION_TIME" }
    );
  }

  return value;
}

function normalizeJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function actionLabel(actionType) { return String(actionType || "ACTION").toLowerCase().replaceAll("_", " "); }
function normalizeOutcome(outcome) { const value = String(outcome || "SUCCESS").toUpperCase(); return ["SUCCESS", "PARTIAL", "FAILURE"].includes(value) ? value : "SUCCESS"; }
function clamp01(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; }
function normalizeText(value) { return String(value || "").trim().toLowerCase(); }
function tokenOverlap(a, b) { const left = new Set(normalizeText(a).split(/[^a-z0-9_:-]+/i).filter(token => token.length >= 3)); const right = new Set(normalizeText(b).split(/[^a-z0-9_:-]+/i).filter(token => token.length >= 3)); if (!left.size || !right.size) return 0; let common = 0; for (const token of left) if (right.has(token)) common += 1; return common / Math.max(left.size, right.size); }

function buildMemoryContext({ perception, decision, actionType, needChanges, simulationAt, outcome = null, completion = null }) {
  const p = perception || {}, location = p.location || null, nearby = Array.isArray(p.nearby) ? p.nearby : [], recentEvents = Array.isArray(p.recentEvents) ? p.recentEvents : [], relationships = Array.isArray(p.relationships) ? p.relationships : [], needs = Array.isArray(needChanges) ? needChanges : [], result = completion || {};
  const normalizedOutcome = normalizeOutcome(outcome || result.outcome);
  const locationLabel = location?.addressData?.name || location?.addressData?.label || location?.locationType || location?.locationId || "unknown location";
  return { actionType, outcome: normalizedOutcome, simulationAt, location: { id: location?.locationId || null, type: location?.locationType || null, label: locationLabel }, observedPeople: nearby.slice(0, 5).map(person => person.displayName || person.entityId).filter(Boolean), recentEventTypes: recentEvents.slice(0, 5).map(event => event.type || event.title).filter(Boolean), relationshipRefs: relationships.slice(0, 5).map(r => ({ id: r.id, trust: Number(r.trust || 0), affection: Number(r.affection || 0), closeness: Number(r.closeness || 0) })), needChanges: needs.slice(0, 12), decision: { actionType: decision?.actionType || actionType, goalId: decision?.goalId || null, confidence: Number(decision?.confidence || 0), reason: decision?.reason || null }, result: { failureReason: result?.failureReason || null, resource: result?.resource || null, resourceLearning: result?.resourceLearning || null } };
}

function buildActionMemory({ actionType, outcome = "SUCCESS", perception = null, decision = null, needChanges = [], completion = null, simulationAt }) {
  const normalizedOutcome = normalizeOutcome(outcome); const context = buildMemoryContext({ perception, decision, actionType, needChanges, simulationAt, outcome: normalizedOutcome, completion }); const location = context.location, result = completion || {}, resource = result.resource, resourceName = resource?.resource ? String(resource.resource).toLowerCase() : null; let cause, consequence, learning, alternative;
  if (normalizedOutcome === "FAILURE") { cause = result.failureReason || "the action could not be completed"; consequence = result.goalBlocked ? `the current goal remains blocked (${result.goalBlocked})` : "the intended result was not obtained"; learning = result.resourceLearning?.type === "RESOURCE_UNAVAILABLE" ? `${resourceName || "the required resource"} is unavailable at this location` : `this strategy did not work at ${location.label}`; alternative = result.strategyAlternative || (resourceName ? `try another location or a different way to obtain ${resourceName}` : "try another strategy or reassess the situation"); }
  else if (normalizedOutcome === "PARTIAL") { cause = result.failureReason || "only part of the expected result was available"; consequence = "the need or goal was only partially satisfied"; learning = result.resourceLearning?.type === "RESOURCE_PARTIALLY_AVAILABLE" ? `${resourceName || "the required resource"} was only partially available here` : "a partial result may require a follow-up action"; alternative = result.strategyAlternative || (resourceName ? `find a more reliable source of ${resourceName}` : "follow up with another action if the need remains"); }
  else { cause = decision?.reason || "the action was selected to respond to the current state"; consequence = "the intended result was obtained"; learning = result.learning || `this action worked at ${location.label}`; alternative = result.strategyAlternative || null; }
  const subject = `I tried to ${actionLabel(actionType)} at ${location.label}.`, outcomeText = normalizedOutcome === "SUCCESS" ? "It succeeded." : normalizedOutcome === "PARTIAL" ? "It only partially succeeded." : "It failed.";
  const content = [subject, `Context: ${location.type ? `${location.type}, ` : ""}${location.label}.`, `Cause: ${cause}.`, `Outcome: ${outcomeText}`, `Consequence: ${consequence}.`, `Learning: ${learning}.`, alternative ? `Alternative strategy: ${alternative}.` : null].filter(Boolean).join(" ");
  return { content, context, importance: normalizedOutcome === "FAILURE" ? 0.88 : normalizedOutcome === "PARTIAL" ? 0.68 : 0.5, strength: normalizedOutcome === "FAILURE" ? 1 : normalizedOutcome === "PARTIAL" ? 0.92 : 0.86, confidence: normalizedOutcome === "FAILURE" ? 0.98 : 0.85, emotionalIntensity: normalizedOutcome === "FAILURE" ? 0.42 : normalizedOutcome === "PARTIAL" ? 0.32 : 0.24, metadata: { kind: "action_outcome", schemaVersion: 2, actionType, outcome: normalizedOutcome, cause, consequence, learning, strategyAlternative: alternative, location, resource: resource || null, failureReason: result.failureReason || null, needChanges: Array.isArray(needChanges) ? needChanges.slice(0, 12) : [], decision: decision ? { actionType: decision.actionType || actionType, goalId: decision.goalId || null, confidence: Number(decision.confidence || 0), reason: decision.reason || null } : null } };
}

function buildFailureMemory({ locationId, simulationTime, actionType, perception, decision, needChanges, physical, failureReason, resourceLearning, strategyAlternative = null }) { const resource = physical?.resource ? String(physical.resource).toLowerCase() : null; const resourceState = Number.isFinite(Number(physical?.remaining)) ? Number(physical.remaining) : null; const normalizedLearning = resourceLearning ? { ...resourceLearning, type: resourceLearning.type || "RESOURCE_UNAVAILABLE" } : null; const memory = buildActionMemory({ actionType, outcome: "FAILURE", perception, decision, needChanges, simulationAt: simulationTime, completion: { failureReason: failureReason || "ACTION_FAILED", resource: physical || null, resourceLearning: normalizedLearning, strategyAlternative: strategyAlternative || (resource ? `go to another location with ${resource} available` : "choose another strategy") } }); memory.context.resource = { ...(memory.context.resource || {}), name: resource, remaining: resourceState }; memory.metadata.resource = physical || null; memory.metadata.locationId = locationId || memory.metadata.location?.id || null; memory.metadata.failureReason = failureReason || "ACTION_FAILED"; memory.metadata.resourceLearning = normalizedLearning; memory.metadata.strategyAlternative = strategyAlternative || memory.metadata.strategyAlternative; memory.metadata.source = "action_completion"; memory.metadata.kind = "resource_failure"; return memory; }

function routineLocationKey(locationId, metadata = {}) {
  const id = locationId || metadata?.locationId || metadata?.location?.id;
  if (id) return String(id);
  const type = normalizeText(metadata?.location?.type);
  const label = normalizeText(metadata?.location?.label);
  return [type, label].filter(Boolean).join(":") || "unknown";
}
function isSalientActionOutcome({ metadata = {}, importance = 0.5, emotionalIntensity = 0.2 } = {}) {
  if (metadata?.kind !== "action_outcome") return true;
  if (normalizeOutcome(metadata.outcome) !== "SUCCESS") return true;
  const decision = metadata.decision || {};
  if (decision.goalId || metadata.goalId || metadata.planId || metadata.planStepId) return true;
  const actionType = normalizeText(metadata.actionType);
  const relationshipIntent = normalizeText(metadata.relationshipIntent);
  if (actionType === "talking" || (relationshipIntent && relationshipIntent !== "none")) return true;
  const needChanges = Array.isArray(metadata.needChanges) ? metadata.needChanges : [];
  if (needChanges.some(change => Math.abs(Number(change?.delta || 0)) >= 0.20)) return true;
  return Number(emotionalIntensity) >= 0.45 || Number(importance) >= 0.68;
}
function routineMemoryContent(actionType, location, observationCount) {
  const label = location?.label || location?.type || "the current place";
  return "Routine pattern: I often " + actionLabel(actionType) + " at " + label + ". I have observed this routine " + observationCount + " time" + (observationCount === 1 ? "" : "s") + ".";
}
async function upsertRoutineActionMemory({ simulationId, entityId, locationId, importance, strength, confidence, emotionalIntensity, simulationAt, metadata }) {
  const actionType = normalizeText(metadata?.actionType);
  if (!actionType || !simulationAt) return null;
  const routineKey = actionType + ":" + routineLocationKey(locationId, metadata) + ":SUCCESS";
  const [rows] = await pool.query("SELECT BIN_TO_UUID(id) AS id,version,created_simulation_at AS createdAt,strength,confidence,importance,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='action_routine' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.routineKey'))=? ORDER BY created_simulation_at DESC LIMIT 1", [simulationId, entityId, routineKey]);
  const existing = rows[0] || null;
  const previousMetadata = normalizeJson(existing?.metadata) || {};
  const observationCount = Math.max(1, Number(previousMetadata.routineObservationCount || 1) + (existing ? 1 : 0));
  const firstObservedSimulationAt = previousMetadata.firstObservedSimulationAt || existing?.createdAt || simulationAt;
  const nextMetadata = { ...metadata, kind: "action_routine", schemaVersion: Math.max(1, Number(metadata.schemaVersion || 1)), routineKey, routineObservationCount: observationCount, firstObservedSimulationAt, lastObservedSimulationAt: simulationAt, aggregated: true };
  if (!existing) return { isNew: true, metadata: nextMetadata, content: routineMemoryContent(metadata.actionType, metadata.location, observationCount), type: "SEMANTIC", importance: Math.min(0.55, Math.max(0.28, Number(importance) * 0.65)), strength: Math.min(0.90, Math.max(0.55, Number(strength) * 0.65)), confidence: Math.min(0.90, Math.max(0.55, Number(confidence) * 0.72)), emotionalIntensity: Math.min(0.20, Math.max(0.08, Number(emotionalIntensity) * 0.60)) };
  const nextStrength = Math.min(0.92, Math.max(Number(existing.strength || 0), 0.50 + Math.log1p(observationCount) * 0.07));
  const nextConfidence = Math.min(0.94, Math.max(Number(existing.confidence || 0), 0.55 + Math.log1p(observationCount) * 0.06));
  const nextImportance = Math.min(0.55, Math.max(Number(existing.importance || 0.28), 0.28));
  await pool.query("UPDATE memories SET content=?,memory_type='SEMANTIC',importance=?,strength=?,confidence=?,emotional_intensity=?,location_id=UUID_TO_BIN(?),created_simulation_at=?,last_recalled_simulation_at=?,metadata=?,status='ACTIVE',forgotten_simulation_at=NULL,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?", [routineMemoryContent(metadata.actionType, metadata.location, observationCount), nextImportance, nextStrength, nextConfidence, Math.min(0.20, Math.max(0.08, Number(emotionalIntensity) || 0.08)), locationId || metadata?.location?.id || null, simulationAt, simulationAt, JSON.stringify(nextMetadata), existing.id, existing.version]);
  return existing.id;
}

async function createMemory({ simulationId, entityId, eventId = null, activityId = null, locationId = null, type = "EPISODIC", content, importance = 0.5, strength = 1, confidence = 0.8, emotionalIntensity = 0.2, simulationAt, metadata = null }) {
  metadata = compactMemoryMetadata(metadata);
  const memoryKind = metadata?.kind || null;
  if (memoryKind === "action_outcome" && !isSalientActionOutcome({ metadata, importance, emotionalIntensity })) {
    const routine = await upsertRoutineActionMemory({ simulationId, entityId, locationId, importance, strength, confidence, emotionalIntensity, simulationAt, metadata });
    if (routine && routine.isNew) {
      metadata = routine.metadata; content = routine.content; type = routine.type; importance = routine.importance; strength = routine.strength; confidence = routine.confidence; emotionalIntensity = routine.emotionalIntensity;
    } else if (routine) return routine;
  }
  if (memoryKind === "resource_failure") {
    const resource = metadata?.resource?.resource || metadata?.resource || null, resourceName = resource ? String(resource).trim().toLowerCase() : null, memoryLocationId = locationId || metadata?.locationId || metadata?.location?.id || null;
    if (resourceName && memoryLocationId) {
      const [existingRows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,version FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='resource_failure' AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.resource.resource')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.resource')))) = ? AND (JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.locationId')) = ? OR location_id=UUID_TO_BIN(?)) ORDER BY created_simulation_at DESC LIMIT 1`, [simulationId, entityId, resourceName, memoryLocationId, memoryLocationId]);
      if (existingRows.length) { const existing = existingRows[0]; await pool.query(`UPDATE memories SET content=?,importance=?,strength=?,confidence=?,emotional_intensity=?,source_event_id=UUID_TO_BIN(?),source_activity_id=UUID_TO_BIN(?),location_id=UUID_TO_BIN(?),created_simulation_at=?,metadata=?,status='ACTIVE',forgotten_simulation_at=NULL,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [content, importance, Math.max(0.99, Number(strength) || 0), confidence, emotionalIntensity, eventId, activityId, memoryLocationId, simulationAt, metadata ? JSON.stringify(metadata) : null, existing.id, existing.version]); return existing.id; }
    }
  }
  const id = uuid(); await pool.query(`INSERT INTO memories (id,simulation_id,entity_id,memory_type,content,importance,strength,confidence,emotional_intensity,source_event_id,source_activity_id,location_id,created_simulation_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, ?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,1)`, [id, simulationId, entityId, type, content, importance, strength, confidence, emotionalIntensity, eventId, activityId, locationId, simulationAt, metadata ? JSON.stringify(metadata) : null]); return id;
}

async function decayMemories(simulationId, simulationTime) {
  const nowMs = new Date(simulationTime).getTime(); const lastMs = lastDecayCheckBySimulation.get(simulationId); if (Number.isFinite(nowMs) && Number.isFinite(lastMs) && nowMs - lastMs < DECAY_CHECKPOINT_MINUTES * 60000) return; if (Number.isFinite(nowMs)) lastDecayCheckBySimulation.set(simulationId, nowMs);
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,strength,version,created_simulation_at AS createdSimulationAt,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND (forgotten_simulation_at IS NULL OR forgotten_simulation_at>?) AND TIMESTAMPDIFF(MINUTE,COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decayCheckpointAt')),created_simulation_at),?) >= ? ORDER BY importance DESC,strength ASC,created_simulation_at ASC LIMIT ?`, [simulationId, simulationTime, simulationTime, DECAY_CHECKPOINT_MINUTES, DECAY_BATCH_SIZE]);
  for (const memory of rows) { const metadata = normalizeJson(memory.metadata) || {}, checkpoint = metadata.decayCheckpointAt || memory.createdSimulationAt; const elapsedMinutes = Math.max(0, (new Date(simulationTime).getTime() - new Date(checkpoint).getTime()) / 60000); if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < DECAY_CHECKPOINT_MINUTES) continue; const next = Number(memory.strength) * Math.pow(DECAY_PER_HOUR_FACTOR, elapsedMinutes / 60); const nextMetadata = JSON.stringify({ ...metadata, decayCheckpointAt: simulationTime }); if (next < 0.05) await pool.query(`UPDATE memories SET strength=?,status='FORGOTTEN',forgotten_simulation_at=?,metadata=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next, simulationTime, nextMetadata, memory.id, memory.version]); else await pool.query(`UPDATE memories SET strength=?,metadata=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next, nextMetadata, memory.id, memory.version]); }
}

function memoryRelevance(memory, context = {}) {
  const metadata = normalizeJson(memory.metadata) || {}, now = new Date(assertSimulationTime(context?.simulationTime)).getTime(), created = new Date(memory.simulationAt || memory.createdSimulationAt || 0).getTime();
  const ageHours = Number.isFinite(now) && Number.isFinite(created) && now >= created ? (now - created) / 3600000 : 0, halfLife = Math.max(1, Number(context.recencyHalfLifeHours || 36)), recency = Math.exp(-ageHours / halfLife);
  const strength = clamp01(memory.strength, 0), importance = clamp01(memory.importance, 0), confidence = clamp01(memory.confidence, 0), locationId = context.locationId || null, locationType = normalizeText(context.locationType);
  const actionTypes = Array.isArray(context.candidateActionTypes) ? context.candidateActionTypes.map(normalizeText) : context.actionType ? [normalizeText(context.actionType)] : [];
  const goalIds = new Set((context.goalIds || []).map(String)), entityIds = new Set((context.entityIds || []).map(String).filter(Boolean)); if (context.targetEntityId) entityIds.add(String(context.targetEntityId));
  const memoryLocationId = metadata.locationId || metadata.location?.id || memory.locationId || null, memoryLocationType = normalizeText(metadata.location?.type || metadata.locationType || ""), locationExact = locationId && memoryLocationId === locationId ? 1 : 0, locationKind = locationType && memoryLocationType === locationType ? 1 : 0, memoryAction = normalizeText(metadata.actionType || metadata.decision?.actionType || ""), actionMatch = actionTypes.length && memoryAction ? (actionTypes.includes(memoryAction) ? 1 : 0) : 0, goalMatch = metadata.goalId && goalIds.has(String(metadata.goalId)) ? 1 : 0, targetMatch = metadata.targetEntityId && entityIds.has(String(metadata.targetEntityId)) ? 1 : 0;
  const observed = Array.isArray(metadata.observedPeople) ? metadata.observedPeople.map(String) : [], observedEntityMatch = observed.some(id => entityIds.has(id)) ? 1 : 0, relationshipEntityMatch = Array.isArray(metadata.relationshipRefs) && entityIds.size ? metadata.relationshipRefs.some(ref => entityIds.has(String(ref.id))) ? 1 : 0 : 0, entityRelevance = Math.max(targetMatch, observedEntityMatch, relationshipEntityMatch), textRelevance = context.queryText ? tokenOverlap(memory.content, context.queryText) : 0, outcomeBonus = context.preferredOutcome && normalizeOutcome(metadata.outcome) === normalizeOutcome(context.preferredOutcome) ? 0.05 : 0;
  return goalMatch * 0.18 + Math.max(locationExact * 0.75, locationKind * 0.25) * 0.16 + actionMatch * 0.18 + entityRelevance * 0.18 + recency * 0.14 + strength * 0.10 + importance * 0.03 + confidence * 0.01 + textRelevance * 0.08 + outcomeBonus;
}

async function deriveRecallContext(simulationId, entityId, baseContext = {}) {
  const context = { ...(baseContext || {}) };
  context.simulationTime = assertSimulationTime(context.simulationTime);
  if (context.simulationTime && context.goalIds && context.locationId && context.candidateActionTypes) return context;
  const [[goalRows], [locationRows], [actionRows]] = await Promise.all([
    pool.query(`SELECT BIN_TO_UUID(id) AS id FROM goals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status IN ('DRAFT','ACTIVE','PAUSED') ORDER BY priority DESC LIMIT 8`, [simulationId, entityId]),
    pool.query(`SELECT BIN_TO_UUID(elc.location_id) AS locationId,l.location_type AS locationType FROM entity_locations_current elc JOIN locations l ON l.entity_id=elc.location_id AND l.simulation_id=elc.simulation_id WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id=UUID_TO_BIN(?) LIMIT 1`, [simulationId, entityId]),
    pool.query(`SELECT action_type AS actionType FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY started_simulation_at DESC LIMIT 6`, [simulationId, entityId])
  ]);
  if (!context.goalIds) context.goalIds = goalRows.map(row => row.id);
  if (!context.locationId) context.locationId = locationRows[0]?.locationId || null;
  if (!context.locationType) context.locationType = locationRows[0]?.locationType || null;
  if (!context.candidateActionTypes) context.candidateActionTypes = actionRows.map(row => row.actionType).filter(Boolean);
  return context;
}

async function listMemories(simulationId, entityId, limit = 100, { includeForgotten = true, context = null } = {}) {
  const scanLimit = Math.min(Math.max(Number(limit) || 100, 1) * 5, 500), statusClause = includeForgotten ? "" : " AND status='ACTIVE'";
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,memory_type AS memoryType,content,importance,strength,confidence,emotional_intensity AS emotionalIntensity,created_simulation_at AS simulationAt,last_recalled_simulation_at AS lastRecalledAt,status,location_id AS locationId,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)${statusClause} ORDER BY created_simulation_at DESC LIMIT ?`, [simulationId, entityId, scanLimit]);
  const normalized = rows.map(row => ({ ...row, metadata: normalizeJson(row.metadata) }));
  if (!context) return normalized.slice(0, Math.min(Number(limit) || 100, 500));
  normalized.sort((a, b) => memoryRelevance(b, context) - memoryRelevance(a, context) || Number(b.strength || 0) - Number(a.strength || 0) || new Date(b.simulationAt).getTime() - new Date(a.simulationAt).getTime());
  return normalized.slice(0, Math.min(Number(limit) || 100, 500));
}

async function recallContexts(simulationId,entityIds=[],limit=8,contextsByEntity=new Map()){
  const ids=[...new Set((entityIds||[]).filter(Boolean).map(String))],result=new Map();if(!ids.length)return result;
  const placeholders=ids.map(()=> 'UUID_TO_BIN(?)').join(',');
  const scanPerEntity=Math.min(Math.max(Number(limit)||8,1)*5,40);
  const [rows]=await pool.query(`SELECT id,entityId,memoryType,content,importance,strength,confidence,emotionalIntensity,simulationAt,lastRecalledAt,status,locationId,metadata FROM (SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(entity_id) AS entityId,memory_type AS memoryType,content,importance,strength,confidence,emotional_intensity AS emotionalIntensity,created_simulation_at AS simulationAt,last_recalled_simulation_at AS lastRecalledAt,status,location_id AS locationId,metadata,ROW_NUMBER() OVER(PARTITION BY entity_id ORDER BY created_simulation_at DESC) AS rn FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id IN (${placeholders}) AND status='ACTIVE') ranked WHERE rn<=? ORDER BY entityId,simulationAt DESC`,[simulationId,...ids,scanPerEntity]);
  const selectedIds=[];
  const grouped=new Map(ids.map(id=>[id,[]]));
  for(const row of rows){const list=grouped.get(row.entityId);if(list)list.push({...row,metadata:normalizeJson(row.metadata)});}
  for(const id of ids){const base=contextsByEntity instanceof Map?contextsByEntity.get(id)||{}:(contextsByEntity&&contextsByEntity[id])||{},effectiveContext={...base,simulationTime:assertSimulationTime(base.simulationTime)};const memories=grouped.get(id)||[];memories.sort((a,b)=>memoryRelevance(b,effectiveContext)-memoryRelevance(a,effectiveContext)||Number(b.strength||0)-Number(a.strength||0)||new Date(b.simulationAt).getTime()-new Date(a.simulationAt).getTime());const selected=memories.slice(0,Math.min(Number(limit)||8,8));result.set(id,selected);for(const memory of selected)selectedIds.push(memory.id);}
  if(selectedIds.length){const selectedPlaceholders=selectedIds.map(()=> 'UUID_TO_BIN(?)').join(',');await pool.query(`UPDATE memories SET last_recalled_simulation_at=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND id IN (${selectedPlaceholders}) AND status='ACTIVE'`,[assertSimulationTime(contextsByEntity instanceof Map?contextsByEntity.values().next().value?.simulationTime:null),simulationId,...selectedIds]);}
  return result;
}
async function recallContext(simulationId, entityId, limit = 8, context = {}) {
  assertSimulationTime(context?.simulationTime);
  const effectiveContext = await deriveRecallContext(simulationId, entityId, context);
  const memories = await listMemories(simulationId, entityId, limit, { includeForgotten: false, context: effectiveContext });
  const recallAt = effectiveContext?.simulationTime || null;
  if (recallAt && memories.length) for (const memory of memories.slice(0, Math.min(8, memories.length))) await pool.query(`UPDATE memories SET last_recalled_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`, [recallAt, memory.id]);
  return memories;
}

module.exports = { createMemory, decayMemories, listMemories, recallContext, buildMemoryContext, buildActionMemory, buildFailureMemory, memoryRelevance, deriveRecallContext, compactMemoryMetadata, isSalientActionOutcome, routineLocationKey };