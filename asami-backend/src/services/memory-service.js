const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const DECAY_BATCH_SIZE = 250;
const DECAY_CHECKPOINT_MINUTES = 360;
const DECAY_PER_HOUR_FACTOR = 0.997;
const lastDecayCheckBySimulation = new Map();

function normalizeJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function actionLabel(actionType) { return String(actionType || "ACTION").toLowerCase().replaceAll("_", " "); }
function normalizeOutcome(outcome) { const value = String(outcome || "SUCCESS").toUpperCase(); return ["SUCCESS", "PARTIAL", "FAILURE"].includes(value) ? value : "SUCCESS"; }

function buildMemoryContext({ perception, decision, actionType, needChanges, simulationAt, outcome = null, completion = null }) {
  const p = perception || {}, location = p.location || null, nearby = Array.isArray(p.nearby) ? p.nearby : [], recentEvents = Array.isArray(p.recentEvents) ? p.recentEvents : [], relationships = Array.isArray(p.relationships) ? p.relationships : [], needs = Array.isArray(needChanges) ? needChanges : [], result = completion || {};
  const normalizedOutcome = normalizeOutcome(outcome || result.outcome);
  const locationLabel = location?.addressData?.name || location?.addressData?.label || location?.locationType || location?.locationId || "unknown location";
  return {
    actionType, outcome: normalizedOutcome, simulationAt,
    location: { id: location?.locationId || null, type: location?.locationType || null, label: locationLabel },
    observedPeople: nearby.slice(0, 5).map(person => person.displayName || person.entityId).filter(Boolean),
    recentEventTypes: recentEvents.slice(0, 5).map(event => event.type || event.title).filter(Boolean),
    relationshipRefs: relationships.slice(0, 5).map(r => ({ id: r.id, trust: Number(r.trust || 0), affection: Number(r.affection || 0), closeness: Number(r.closeness || 0) })),
    needChanges: needs.slice(0, 12),
    decision: { actionType: decision?.actionType || actionType, goalId: decision?.goalId || null, confidence: Number(decision?.confidence || 0), reason: decision?.reason || null },
    result: { failureReason: result?.failureReason || null, resource: result?.resource || null, resourceLearning: result?.resourceLearning || null }
  };
}

function buildActionMemory({ actionType, outcome = "SUCCESS", perception = null, decision = null, needChanges = [], completion = null, simulationAt }) {
  const normalizedOutcome = normalizeOutcome(outcome);
  const context = buildMemoryContext({ perception, decision, actionType, needChanges, simulationAt, outcome: normalizedOutcome, completion });
  const location = context.location, result = completion || {}, resource = result.resource, resourceName = resource?.resource ? String(resource.resource).toLowerCase() : null;
  let cause, consequence, learning, alternative;
  if (normalizedOutcome === "FAILURE") {
    cause = result.failureReason || "the action could not be completed";
    consequence = result.goalBlocked ? `the current goal remains blocked (${result.goalBlocked})` : "the intended result was not obtained";
    learning = result.resourceLearning?.type === "RESOURCE_UNAVAILABLE" ? `${resourceName || "the required resource"} is unavailable at this location` : `this strategy did not work at ${location.label}`;
    alternative = result.strategyAlternative || (resourceName ? `try another location or a different way to obtain ${resourceName}` : "try another strategy or reassess the situation");
  } else if (normalizedOutcome === "PARTIAL") {
    cause = result.failureReason || "only part of the expected result was available";
    consequence = "the need or goal was only partially satisfied";
    learning = result.resourceLearning?.type === "RESOURCE_PARTIALLY_AVAILABLE" ? `${resourceName || "the required resource"} was only partially available here` : "a partial result may require a follow-up action";
    alternative = result.strategyAlternative || (resourceName ? `find a more reliable source of ${resourceName}` : "follow up with another action if the need remains");
  } else {
    cause = decision?.reason || "the action was selected to respond to the current state";
    consequence = "the intended result was obtained";
    learning = result.learning || `this action worked at ${location.label}`;
    alternative = result.strategyAlternative || null;
  }
  const subject = `I tried to ${actionLabel(actionType)} at ${location.label}.`, outcomeText = normalizedOutcome === "SUCCESS" ? "It succeeded." : normalizedOutcome === "PARTIAL" ? "It only partially succeeded." : "It failed.";
  const content = [subject, `Context: ${location.type ? `${location.type}, ` : ""}${location.label}.`, `Cause: ${cause}.`, `Outcome: ${outcomeText}`, `Consequence: ${consequence}.`, `Learning: ${learning}.`, alternative ? `Alternative strategy: ${alternative}.` : null].filter(Boolean).join(" ");
  return { content, context, importance: normalizedOutcome === "FAILURE" ? 0.88 : normalizedOutcome === "PARTIAL" ? 0.68 : 0.5, strength: normalizedOutcome === "FAILURE" ? 1 : normalizedOutcome === "PARTIAL" ? 0.92 : 0.86, confidence: normalizedOutcome === "FAILURE" ? 0.98 : 0.85, emotionalIntensity: normalizedOutcome === "FAILURE" ? 0.42 : normalizedOutcome === "PARTIAL" ? 0.32 : 0.24, metadata: { kind: "action_outcome", schemaVersion: 2, actionType, outcome: normalizedOutcome, cause, consequence, learning, strategyAlternative: alternative, location, resource: resource || null, failureReason: result.failureReason || null, needChanges: Array.isArray(needChanges) ? needChanges.slice(0, 12) : [], decision: decision ? { actionType: decision.actionType || actionType, goalId: decision.goalId || null, confidence: Number(decision.confidence || 0), reason: decision.reason || null } : null } };
}

function buildFailureMemory({ locationId, simulationTime, actionType, perception, decision, needChanges, physical, failureReason, resourceLearning, strategyAlternative = null }) {
  const resource = physical?.resource ? String(physical.resource).toLowerCase() : null;
  const resourceState = Number.isFinite(Number(physical?.remaining)) ? Number(physical.remaining) : null;
  const normalizedLearning = resourceLearning ? { ...resourceLearning, type: resourceLearning.type || "RESOURCE_UNAVAILABLE" } : null;
  const memory = buildActionMemory({ actionType, outcome: "FAILURE", perception, decision, needChanges, simulationAt: simulationTime, completion: { failureReason: failureReason || "ACTION_FAILED", resource: physical || null, resourceLearning: normalizedLearning, strategyAlternative: strategyAlternative || (resource ? `go to another location with ${resource} available` : "choose another strategy") } });
  memory.context.resource = { ...(memory.context.resource || {}), name: resource, remaining: resourceState };
  memory.metadata.resource = physical || null; memory.metadata.locationId = locationId || memory.metadata.location?.id || null; memory.metadata.failureReason = failureReason || "ACTION_FAILED"; memory.metadata.resourceLearning = normalizedLearning; memory.metadata.strategyAlternative = strategyAlternative || memory.metadata.strategyAlternative; memory.metadata.source = "action_completion"; memory.metadata.kind = "resource_failure";
  return memory;
}

async function createMemory({ simulationId, entityId, eventId = null, activityId = null, locationId = null, type = "EPISODIC", content, importance = 0.5, strength = 1, confidence = 0.8, emotionalIntensity = 0.2, simulationAt, metadata = null }) {
  const memoryKind = metadata?.kind || null;
  if (memoryKind === "resource_failure") {
    const resource = metadata?.resource?.resource || metadata?.resource || null, resourceName = resource ? String(resource).trim().toLowerCase() : null, memoryLocationId = locationId || metadata?.locationId || metadata?.location?.id || null;
    if (resourceName && memoryLocationId) {
      const [existingRows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,version FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='resource_failure' AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.resource.resource')),JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.resource')))) = ? AND (JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.locationId')) = ? OR location_id=UUID_TO_BIN(?)) ORDER BY created_simulation_at DESC LIMIT 1`, [simulationId, entityId, resourceName, memoryLocationId, memoryLocationId]);
      if (existingRows.length) {
        const existing = existingRows[0];
        await pool.query(`UPDATE memories SET content=?,importance=?,strength=?,confidence=?,emotional_intensity=?,source_event_id=UUID_TO_BIN(?),source_activity_id=UUID_TO_BIN(?),location_id=UUID_TO_BIN(?),created_simulation_at=?,metadata=?,status='ACTIVE',forgotten_simulation_at=NULL,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [content, importance, Math.max(0.99, Number(strength) || 0), confidence, emotionalIntensity, eventId, activityId, memoryLocationId, simulationAt, metadata ? JSON.stringify(metadata) : null, existing.id, existing.version]);
        return existing.id;
      }
    }
  }
  const id = uuid();
  await pool.query(`INSERT INTO memories (id,simulation_id,entity_id,memory_type,content,importance,strength,confidence,emotional_intensity,source_event_id,source_activity_id,location_id,created_simulation_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, ?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'ACTIVE',?,1)`, [id, simulationId, entityId, type, content, importance, strength, confidence, emotionalIntensity, eventId, activityId, locationId, simulationAt, metadata ? JSON.stringify(metadata) : null]);
  return id;
}

async function decayMemories(simulationId, simulationTime) {
  const nowMs = new Date(simulationTime).getTime();
  const lastMs = lastDecayCheckBySimulation.get(simulationId);
  if (Number.isFinite(nowMs) && Number.isFinite(lastMs) && nowMs - lastMs < DECAY_CHECKPOINT_MINUTES * 60000) return;
  if (Number.isFinite(nowMs)) lastDecayCheckBySimulation.set(simulationId, nowMs);
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,strength,version,created_simulation_at AS createdSimulationAt,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND (forgotten_simulation_at IS NULL OR forgotten_simulation_at>?) AND TIMESTAMPDIFF(MINUTE,COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.decayCheckpointAt')),created_simulation_at),?) >= ? ORDER BY importance DESC,strength ASC,created_simulation_at ASC LIMIT ?`, [simulationId, simulationTime, simulationTime, DECAY_CHECKPOINT_MINUTES, DECAY_BATCH_SIZE]);
  for (const memory of rows) {
    const metadata = normalizeJson(memory.metadata) || {}, checkpoint = metadata.decayCheckpointAt || memory.createdSimulationAt;
    const elapsedMinutes = Math.max(0, (new Date(simulationTime).getTime() - new Date(checkpoint).getTime()) / 60000);
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < DECAY_CHECKPOINT_MINUTES) continue;
    const next = Number(memory.strength) * Math.pow(DECAY_PER_HOUR_FACTOR, elapsedMinutes / 60);
    const nextMetadata = JSON.stringify({ ...metadata, decayCheckpointAt: simulationTime });
    if (next < 0.05) await pool.query(`UPDATE memories SET strength=?,status='FORGOTTEN',forgotten_simulation_at=?,metadata=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next, simulationTime, nextMetadata, memory.id, memory.version]);
    else await pool.query(`UPDATE memories SET strength=?,metadata=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`, [next, nextMetadata, memory.id, memory.version]);
  }
}

async function listMemories(simulationId,entityId,limit=100){const [rows]=await pool.query(`SELECT BIN_TO_UUID(id) AS id,memory_type AS memoryType,content,importance,strength,confidence,emotional_intensity AS emotionalIntensity,created_simulation_at AS simulationAt,last_recalled_simulation_at AS lastRecalledAt,status,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY importance DESC,strength DESC,created_simulation_at DESC LIMIT ?`,[simulationId,entityId,Math.min(limit,500)]);return rows.map(row=>({...row,metadata:normalizeJson(row.metadata)}));}
async function recallContext(simulationId,entityId,limit=8){return listMemories(simulationId,entityId,limit);}
module.exports={createMemory,decayMemories,listMemories,recallContext,buildMemoryContext,buildActionMemory,buildFailureMemory};
