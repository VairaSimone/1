const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

function normalizeJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function buildMemoryContext({ perception, decision, actionType, needChanges, simulationAt }) {
  const p = perception || {};
  const location = p.location || null;
  const nearby = Array.isArray(p.nearby) ? p.nearby : [];
  const recentEvents = Array.isArray(p.recentEvents) ? p.recentEvents : [];
  const relationships = Array.isArray(p.relationships) ? p.relationships : [];
  const needs = Array.isArray(needChanges) ? needChanges : [];

  const locationLabel = location?.addressData?.name || location?.addressData?.label || location?.locationType || location?.locationId || "unknown location";
  const observedPeople = nearby.slice(0, 5).map(person => person.displayName || person.entityId);
  const eventTypes = recentEvents.slice(0, 5).map(event => event.type || event.title).filter(Boolean);
  const relationshipRefs = relationships.slice(0, 5).map(r => ({
    id: r.id,
    trust: Number(r.trust || 0),
    affection: Number(r.affection || 0),
    closeness: Number(r.closeness || 0)
  }));

  return {
    actionType,
    simulationAt,
    location: {
      id: location?.locationId || null,
      type: location?.locationType || null,
      label: locationLabel
    },
    observedPeople,
    recentEventTypes: eventTypes,
    relationshipRefs,
    needChanges: needs.slice(0, 12),
    decision: {
      actionType: decision?.actionType || actionType,
      goalId: decision?.goalId || null,
      confidence: Number(decision?.confidence || 0),
      reason: decision?.reason || null
    }
  };
}

async function createMemory({
  simulationId,
  entityId,
  eventId = null,
  activityId = null,
  locationId = null,
  type = "EPISODIC",
  content,
  importance = 0.5,
  strength = 1,
  confidence = 0.8,
  emotionalIntensity = 0.2,
  simulationAt,
  metadata = null
}) {
  const id = uuid();

  await pool.query(`
    INSERT INTO memories
      (
        id,
        simulation_id,
        entity_id,
        memory_type,
        content,
        importance,
        strength,
        confidence,
        emotional_intensity,
        source_event_id,
        source_activity_id,
        location_id,
        created_simulation_at,
        status,
        metadata,
        version
      )
    VALUES (
      UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?,
      UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, 'ACTIVE', ?, 1
    )
  `, [
    id, simulationId, entityId, type, content, importance, strength, confidence,
    emotionalIntensity, eventId, activityId, locationId, simulationAt,
    metadata ? JSON.stringify(metadata) : null
  ]);

  return id;
}

async function decayMemories(simulationId, simulationTime) {
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,strength,importance,confidence,version
    FROM memories
    WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'
      AND (forgotten_simulation_at IS NULL OR forgotten_simulation_at>?)
    ORDER BY created_simulation_at DESC LIMIT 1000
  `,[simulationId,simulationTime]);
  for(const m of rows){
    const next=Number(m.strength)*0.9995;
    if(next<0.05){
      await pool.query(`UPDATE memories SET strength=?,status='FORGOTTEN',forgotten_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,
        [next,simulationTime,m.id,m.version]);
    }else{
      await pool.query(`UPDATE memories SET strength=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,[next,m.id,m.version]);
    }
    await pool.query(`
      INSERT INTO memory_state_history
      (id,memory_id,operation,old_strength,new_strength,old_importance,new_importance,old_confidence,new_confidence,simulation_time)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'WEAKENED',?,?,?,?,?,?,?)
    `,[uuid(),m.id,m.strength,next,m.importance,m.importance,m.confidence,m.confidence,simulationTime]);
  }
}

async function listMemories(simulationId,entityId,limit=100){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,
           memory_type AS memoryType,
           content,importance,strength,confidence,
           emotional_intensity AS emotionalIntensity,
           created_simulation_at AS simulationAt,
           last_recalled_simulation_at AS lastRecalledAt,
           status,metadata
    FROM memories
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
    ORDER BY importance DESC,strength DESC,created_simulation_at DESC LIMIT ?
  `,[simulationId,entityId,Math.min(limit,500)]);
  return rows.map(row => ({ ...row, metadata: normalizeJson(row.metadata) }));
}

async function recallContext(simulationId,entityId,limit=8){
  return listMemories(simulationId,entityId,limit);
}

module.exports={createMemory,decayMemories,listMemories,recallContext,buildMemoryContext};
