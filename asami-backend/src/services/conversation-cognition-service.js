const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

function round5(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100000) / 100000;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function clampDelta(value, maxAbs) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-maxAbs, Math.min(maxAbs, n));
}

function safeText(value, max = 500) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

async function applyNeedDeltas(entityId, simulationTime, deltas, causeEventId = null, causeActionId = null) {
  if (!Array.isArray(deltas) || !deltas.length) return [];
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(enc.need_id) AS needId, nd.code, enc.value, enc.version
    FROM entity_needs_current enc
    JOIN need_definitions nd ON nd.id=enc.need_id
    WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1
  `, [entityId]);
  const byCode = new Map(rows.map(row => [row.code, row]));
  const out = [];

  for (const item of deltas) {
    const row = byCode.get(String(item?.code || "").toUpperCase());
    if (!row) continue;
    const rawDelta = clampDelta(item.delta, 0.15);
    if (!rawDelta) continue;
    const oldValue = round5(row.value);
    const next = round5(clamp01(oldValue + rawDelta));
    const historyDelta = round5(next - oldValue);
    if (Math.abs(historyDelta) < 0.000001) continue;
    const [updated] = await pool.query(`
      UPDATE entity_needs_current
      SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND version=?
    `, [next, simulationTime, entityId, row.needId, row.version]);
    if (!updated.affectedRows) continue;
    await pool.query(`
      INSERT INTO entity_need_history
        (id,entity_id,need_id,old_value,new_value,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))
    `, [uuid(), entityId, row.needId, oldValue, next, historyDelta, simulationTime, causeEventId, causeActionId]);
    out.push({ code: row.code, old: oldValue, new: next, delta: historyDelta });
  }
  return out;
}

async function applyEmotionDeltas(entityId, simulationTime, deltas, causeEventId = null, causeActionId = null) {
  if (!Array.isArray(deltas) || !deltas.length) return [];
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(eec.emotion_id) AS emotionId, ed.code, eec.intensity, eec.version
    FROM entity_emotions_current eec
    JOIN emotion_definitions ed ON ed.id=eec.emotion_id
    WHERE eec.entity_id=UUID_TO_BIN(?) AND ed.active=1
  `, [entityId]);
  const byCode = new Map(rows.map(row => [row.code, row]));
  const out = [];

  for (const item of deltas) {
    const row = byCode.get(String(item?.code || "").toUpperCase());
    if (!row) continue;
    const rawDelta = clampDelta(item.delta, 0.12);
    if (!rawDelta) continue;
    const oldValue = round5(row.intensity);
    const next = round5(clamp01(oldValue + rawDelta));
    const historyDelta = round5(next - oldValue);
    if (Math.abs(historyDelta) < 0.000001) continue;
    const [updated] = await pool.query(`
      UPDATE entity_emotions_current
      SET intensity=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND emotion_id=UUID_TO_BIN(?) AND version=?
    `, [next, simulationTime, entityId, row.emotionId, row.version]);
    if (!updated.affectedRows) continue;
    await pool.query(`
      INSERT INTO entity_emotion_history
        (id,entity_id,emotion_id,old_intensity,new_intensity,delta,simulation_time,cause_event_id,cause_action_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?))
    `, [uuid(), entityId, row.emotionId, oldValue, next, historyDelta, simulationTime, causeEventId, causeActionId]);
    out.push({ code: row.code, old: oldValue, new: next, delta: historyDelta });
  }
  return out;
}

async function applyTraitDeltas(entityId, simulationTime, deltas, causeEventId = null, causeActionId = null) {
  if (!Array.isArray(deltas) || !deltas.length) return [];
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(etc.trait_id) AS traitId, td.code, etc.value, etc.version,
           td.development_weight AS developmentWeight
    FROM entity_traits_current etc
    JOIN trait_definitions td ON td.id=etc.trait_id
    WHERE etc.entity_id=UUID_TO_BIN(?) AND td.active=1
  `, [entityId]);
  const byCode = new Map(rows.map(row => [row.code, row]));
  const out = [];

  for (const item of deltas) {
    const row = byCode.get(String(item?.code || "").toUpperCase());
    if (!row) continue;
    // Chat can influence personality slowly, never enough to rewrite it in one conversation.
    const rawDelta = clampDelta(item.delta, 0.01);
    if (!rawDelta) continue;
    const oldValue = round5(row.value);
    const next = round5(clamp01(oldValue + rawDelta));
    const historyDelta = round5(next - oldValue);
    if (Math.abs(historyDelta) < 0.000001) continue;
    const [updated] = await pool.query(`
      UPDATE entity_traits_current
      SET value=?,updated_simulation_at=?,version=version+1
      WHERE entity_id=UUID_TO_BIN(?) AND trait_id=UUID_TO_BIN(?) AND version=?
    `, [next, simulationTime, entityId, row.traitId, row.version]);
    if (!updated.affectedRows) continue;
    await pool.query(`
      INSERT INTO entity_trait_history
        (id,entity_id,trait_id,old_value,new_value,delta,changed_simulation_at,cause_event_id,cause_action_id,change_reason)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `, [uuid(), entityId, row.traitId, oldValue, next, historyDelta, simulationTime, causeEventId, causeActionId, "conversation reinforcement"]);
    out.push({ code: row.code, old: oldValue, new: next, delta: historyDelta });
  }
  return out;
}

async function applyRelationshipDeltas({ simulationId, sourceEntityId, targetEntityId, simulationTime, deltas, sourceEventId = null }) {
  if (!targetEntityId || sourceEntityId === targetEntityId || !deltas) return null;
  const { upsertInteractionRelationship } = require("./relationship-service");
  const normalized = {};
  for (const key of [
    "trust","affection","respect","familiarity","attraction","conflict",
    "fear","admiration","jealousy","dependence","closeness","irritation"
  ]) normalized[key] = clampDelta(deltas[key], 0.03);
  return upsertInteractionRelationship({
    simulationId,
    sourceEntityId,
    targetEntityId,
    simulationAt: simulationTime,
    sourceEventId,
    deltas: normalized
  });
}

async function updateCommunicationStyle(entityId, proposed, simulationTime) {
  if (!proposed || typeof proposed !== "object") return null;
  const [rows] = await pool.query(`SELECT attributes FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`, [entityId]);
  if (!rows.length) return null;

  let attributes = rows[0].attributes || {};
  if (typeof attributes === "string") {
    try { attributes = JSON.parse(attributes); } catch { attributes = {}; }
  }
  const previous = attributes.communicationStyle && typeof attributes.communicationStyle === "object"
    ? attributes.communicationStyle
    : {};
  const next = {
    formality: clamp01(proposed.formality ?? previous.formality ?? 0.45),
    warmth: clamp01(proposed.warmth ?? previous.warmth ?? 0.6),
    directness: clamp01(proposed.directness ?? previous.directness ?? 0.55),
    verbosity: clamp01(proposed.verbosity ?? previous.verbosity ?? 0.45),
    humor: clamp01(proposed.humor ?? previous.humor ?? 0.25),
    emojiUse: clamp01(proposed.emojiUse ?? previous.emojiUse ?? 0.08),
    emotionalOpenness: clamp01(proposed.emotionalOpenness ?? previous.emotionalOpenness ?? 0.55),
    argumentativeDepth: clamp01(proposed.argumentativeDepth ?? previous.argumentativeDepth ?? 0.6),
    updatedSimulationAt: simulationTime
  };

  attributes.communicationStyle = next;
  await pool.query(`UPDATE entities SET attributes=?,version=version+1 WHERE id=UUID_TO_BIN(?)`, [JSON.stringify(attributes), entityId]);
  return next;
}

async function createGoalFromProposal({ simulationId, entityId, simulationTime, proposal }) {
  if (!proposal || typeof proposal !== "object") return null;
  const title = safeText(proposal.title, 120);
  const description = safeText(proposal.description, 500);
  if (!title) return null;
  const priority = Math.max(0.1, Math.min(1, Number(proposal.priority || 0.5)));
  const [existing] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,title,status FROM goals
    WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?)
      AND status IN ('DRAFT','ACTIVE','PAUSED')
    ORDER BY created_simulation_at DESC LIMIT 20
  `, [simulationId, entityId]);
  if (existing.some(goal => String(goal.title).toLowerCase() === title.toLowerCase())) return existing.find(goal => String(goal.title).toLowerCase() === title.toLowerCase()).id;

  const goalId = uuid();
  await pool.query(`
    INSERT INTO goals
      (id,simulation_id,entity_id,title,description,goal_type,priority,status,progress,created_simulation_at,motivation,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'PERSONAL', ?, 'ACTIVE', 0, ?, CAST(? AS JSON), 1)
  `, [
    goalId,
    simulationId,
    entityId,
    title,
    description || "A goal that emerged from a meaningful conversation.",
    priority,
    simulationTime,
    JSON.stringify({ source: "conversation", userInfluence: true, reason: safeText(proposal.reason, 300) })
  ]);
  return goalId;
}

module.exports = {
  applyNeedDeltas,
  applyEmotionDeltas,
  applyTraitDeltas,
  applyRelationshipDeltas,
  updateCommunicationStyle,
  createGoalFromProposal,
  clampDelta,
  safeText
};
