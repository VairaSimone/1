const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const crypto = require("crypto");

const MAX_MEMORY_POLICY_BIAS = 0.32;
const MEMORY_TYPES = new Set(["EPISODIC", "SEMANTIC", "PROCEDURAL"]);
let installed = false;

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalize(value) { return String(value || "").trim().toUpperCase(); }
function actionLabel(value) { return String(value || "action").toLowerCase().replaceAll("_", " "); }
function clamp(value, min = -1, max = 1) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0; }
function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function memoryMetadata(memory) { return parseJson(memory?.metadata, {}) || {}; }

function needReliefText(needChanges = []) {
  return (needChanges || [])
    .filter(change => Number(change.delta) < -0.03)
    .slice(0, 3)
    .map(change => `${String(change.code || "need").toLowerCase().replaceAll("_", " ")} fell to ${Number(change.new).toFixed(2)}`)
    .join(", ");
}

function humanizeActionMemory(args, originalContent) {
  const metadata = args.metadata || {};
  if (!['action_outcome', 'resource_failure'].includes(metadata.kind)) return originalContent;
  const action = actionLabel(metadata.actionType || args.actionType);
  const location = metadata.location?.label || metadata.location?.type || "the current place";
  const outcome = normalize(metadata.outcome || "SUCCESS");
  const reason = metadata.decision?.reason || metadata.cause || "my current needs and intentions";
  const cause = metadata.cause || metadata.failureReason || "the expected result was not obtained";
  const consequence = metadata.consequence || "the intended result was obtained";
  const learning = metadata.learning || "the result gave me information about this strategy";
  const alternative = metadata.strategyAlternative || metadata.alternative || null;
  const relief = needReliefText(metadata.needChanges || []);
  const target = metadata.targetName ? ` with ${metadata.targetName}` : metadata.targetEntityId ? ` with ${metadata.targetEntityId}` : "";
  if (outcome === "FAILURE") {
    return `I chose to ${action}${target} at ${location} because ${reason}. It failed: ${cause}. ${consequence}. I learned that ${learning}.${alternative ? ` Next time, I should ${alternative}.` : ""}`;
  }
  if (outcome === "PARTIAL") {
    return `I chose to ${action}${target} at ${location} because ${reason}. It only partly worked: ${consequence}. I learned that ${learning}.${alternative ? ` A better next step may be to ${alternative}.` : ""}`;
  }
  return `I chose to ${action}${target} at ${location} because ${reason}. It worked. ${relief ? `It changed my state: ${relief}. ` : ""}${learning}.`;
}

async function upsertConsolidatedMemory({ simulationId, entityId, simulationAt, locationId, kind, uniqueKey, type, content, importance, strength, confidence, emotionalIntensity, metadata }) {
  const lockKey="asami:memory:"+crypto.createHash("sha1").update([simulationId,entityId,kind,uniqueKey].join("|")).digest("hex");
  const conn=await pool.getConnection();
  let locked=false;
  try{
    const [lockRows]=await conn.query("SELECT GET_LOCK(?,5) AS acquired",[lockKey]);
    locked=Number(lockRows[0]?.acquired)===1;
    if(!locked)return null;
    const [existingRows]=await conn.query(
      `SELECT BIN_TO_UUID(id) AS id,version FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.uniqueKey'))=? ORDER BY created_simulation_at DESC LIMIT 1`,
      [simulationId,entityId,kind,uniqueKey]
    );
    if(existingRows.length){
      const existing=existingRows[0];
      await conn.query(
        `UPDATE memories SET content=?,memory_type=?,importance=?,strength=?,confidence=?,emotional_intensity=?,location_id=UUID_TO_BIN(?),created_simulation_at=?,metadata=?,forgotten_simulation_at=NULL,status='ACTIVE',version=version+1 WHERE id=UUID_TO_BIN(?) AND version=?`,
        [content,type,importance,strength,confidence,emotionalIntensity,locationId||null,simulationAt,JSON.stringify(metadata),existing.id,existing.version]
      );
      return existing.id;
    }
    const id=uuid();
    await conn.query(
      `INSERT INTO memories (id,simulation_id,entity_id,memory_type,content,importance,strength,confidence,emotional_intensity,source_event_id,source_activity_id,location_id,created_simulation_at,status,metadata,version) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,NULL,NULL,UUID_TO_BIN(?),?,'ACTIVE',?,1)`,
      [id,simulationId,entityId,type,content,importance,strength,confidence,emotionalIntensity,locationId||null,simulationAt,JSON.stringify(metadata)]
    );
    return id;
  }finally{
    try{if(locked)await conn.query("SELECT RELEASE_LOCK(?)",[lockKey]);}catch{}
    conn.release();
  }
}

async function consolidateActionMemories(args) {
  const metadata = args.metadata || {};
  const actionType = normalize(metadata.actionType || args.actionType);
  const locationId = metadata.locationId || metadata.location?.id || args.locationId || null;
  if (!actionType) return;
  const [rows] = await pool.query(
    `SELECT memory_type AS memoryType,content,importance,strength,confidence,created_simulation_at AS createdAt,metadata FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType'))=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind')) IN ('action_outcome','resource_failure') ORDER BY created_simulation_at DESC LIMIT 32`,
    [args.simulationId, args.entityId, actionType]
  );
  const observations = rows.map(row => ({ ...row, metadata: memoryMetadata(row) })).filter(row => {
    const rowLocation = row.metadata.locationId || row.metadata.location?.id || null;
    return !locationId || !rowLocation || String(rowLocation) === String(locationId);
  });
  if (observations.length < 3) return;
  const outcomes = observations.map(row => normalize(row.metadata.outcome)).filter(Boolean);
  const success = outcomes.filter(value => value === "SUCCESS").length;
  const partial = outcomes.filter(value => value === "PARTIAL").length;
  const failure = outcomes.filter(value => value === "FAILURE").length;
  const total = Math.max(1, success + partial + failure);
  const reliability = (success + partial * 0.5) / total;
  const location = observations.find(row => row.metadata.location?.label)?.metadata.location?.label || "this place";
  const locationType = observations.find(row => row.metadata.location?.type)?.metadata.location?.type || null;
  const semanticStatus = reliability >= 0.75 ? "RELIABLE" : reliability <= 0.35 ? "UNRELIABLE" : "MIXED";
  if (semanticStatus !== "MIXED" || failure >= 2) {
    const semanticContent = `I have learned that ${actionLabel(actionType)} at ${location} is ${semanticStatus === "RELIABLE" ? "usually effective" : semanticStatus === "UNRELIABLE" ? "often unreliable" : "inconsistent"}. I observed it ${total} times: ${success} successes, ${partial} partial results and ${failure} failures.`;
    await upsertConsolidatedMemory({
      simulationId: args.simulationId, entityId: args.entityId, simulationAt: args.simulationAt, locationId,
      kind: "semantic_pattern", uniqueKey: `${actionType}:${locationId || location}`,
      type: "SEMANTIC", content: semanticContent, importance: semanticStatus === "UNRELIABLE" ? 0.92 : 0.72,
      strength: Math.min(1, 0.55 + total / 20), confidence: Math.min(0.96, 0.55 + total / 20), emotionalIntensity: semanticStatus === "UNRELIABLE" ? 0.38 : 0.16,
      metadata: { kind: "semantic_pattern", schemaVersion: 1, uniqueKey: `${actionType}:${locationId || location}`, actionType, locationId, location: { label: location, type: locationType }, reliability, observations: total, success, partial, failure, status: semanticStatus, policyDirection: semanticStatus === "UNRELIABLE" ? "AVOID_OR_REASSESS" : semanticStatus === "RELIABLE" ? "PREFER_WHEN_APPROPRIATE" : "REASSESS_IF_REPEATED" }
    });
  }
  const alternatives = observations.map(row => row.metadata.strategyAlternative || row.metadata.alternative).filter(Boolean);
  if (failure >= 1 || alternatives.length) {
    const alternative = alternatives[0] || `reassess this location before repeating ${actionLabel(actionType)}`;
    const proceduralContent = `When I need to ${actionLabel(actionType)}${location ? ` at ${location}` : ""}, I should ${failure >= 2 ? "avoid repeating the same approach without checking what went wrong" : "consider the learned alternative"}. One useful alternative is to ${alternative}.`;
    await upsertConsolidatedMemory({
      simulationId: args.simulationId, entityId: args.entityId, simulationAt: args.simulationAt, locationId,
      kind: "procedural_strategy", uniqueKey: `${actionType}:${locationId || location}`,
      type: "PROCEDURAL", content: proceduralContent, importance: 0.86, strength: Math.min(1, 0.62 + failure * 0.08), confidence: Math.min(0.94, 0.60 + failure * 0.07), emotionalIntensity: 0.28,
      metadata: { kind: "procedural_strategy", schemaVersion: 1, uniqueKey: `${actionType}:${locationId || location}`, actionType, locationId, location: { label: location, type: locationType }, failureCount: failure, successCount: success, alternative, direction: "REASSESS_OR_CHANGE_STRATEGY" }
    });
  }

  if (actionType === "TALKING") {
    const targetIds = [...new Set(observations.map(row => row.metadata.targetEntityId).filter(Boolean))];
    for (const targetEntityId of targetIds.slice(0, 3)) await consolidateSocialMemory({ ...args, targetEntityId });
  }
}

async function consolidateSocialMemory({ simulationId, entityId, simulationAt, targetEntityId }) {
  const [rows] = await pool.query(`SELECT metadata,content FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.actionType'))='TALKING' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.targetEntityId'))=? ORDER BY created_simulation_at DESC LIMIT 20`, [simulationId, entityId, targetEntityId]);
  if (rows.length < 3) return;
  const parsed = rows.map(row => ({ ...row, metadata: memoryMetadata(row) }));
  const positive = parsed.filter(row => normalize(row.metadata.outcome) === "SUCCESS").length;
  const negative = parsed.filter(row => ["FAILURE", "PARTIAL"].includes(normalize(row.metadata.outcome))).length;
  const total = parsed.length;
  const [people] = await pool.query(`SELECT display_name AS name FROM entities WHERE id=UUID_TO_BIN(?) LIMIT 1`, [targetEntityId]);
  const targetName = people[0]?.name || targetEntityId;
  const quality = (positive - negative) / Math.max(1, total);
  const content = quality >= 0.35
    ? `I have noticed that conversations with ${targetName} usually go well. We have interacted ${total} times, and most experiences have been positive.`
    : quality <= -0.35
      ? `I have noticed that conversations with ${targetName} often leave tension or do not go as expected. I should pay attention to that pattern.`
      : `I have not yet formed a clear impression of ${targetName}; our conversations have produced mixed experiences.`;
  await upsertConsolidatedMemory({
    simulationId, entityId, simulationAt, locationId: null, kind: "social_pattern", uniqueKey: `TALKING:${targetEntityId}`, type: "SEMANTIC", content,
    importance: 0.84, strength: Math.min(1, 0.58 + total / 25), confidence: Math.min(0.94, 0.58 + total / 20), emotionalIntensity: Math.min(1, 0.2 + Math.abs(quality) * 0.45),
    metadata: { kind: "social_pattern", schemaVersion: 1, uniqueKey: `TALKING:${targetEntityId}`, actionType: "TALKING", targetEntityId, targetName, observations: total, positive, negative, relationshipValence: quality, direction: quality >= 0.35 ? "PREFER_SOCIAL_CONTACT" : quality <= -0.35 ? "BE_CAUTIOUS" : "REASSESS" }
  });
}

async function memoryPolicyBias(context) {
  const entityId = context?.entityId || null;
  if (!entityId) return { biases: {}, memories: [] };
  const [rows] = await pool.query(`SELECT memory_type AS memoryType,content,strength,importance,confidence,metadata,created_simulation_at AS createdAt FROM memories WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='ACTIVE' AND memory_type IN ('SEMANTIC','PROCEDURAL') ORDER BY created_simulation_at DESC LIMIT 80`, [context.simulationId, entityId]);
  const locationId = context.locationId || context.location?.locationId || null;
  const biases = {};
  const matched = [];
  for (const row of rows) {
    const metadata = memoryMetadata(row), action = normalize(metadata.actionType);
    if (!action) continue;
    const ageHours = Math.max(0, (new Date(context.simulationTime || Date.now()).getTime() - new Date(row.createdAt).getTime()) / 3600000);
    const recency = Number.isFinite(ageHours) ? Math.exp(-ageHours / 72) : 0.5;
    const locationExact = locationId && metadata.locationId && String(locationId) === String(metadata.locationId) ? 1 : 0;
    let valence = 0;
    if (normalize(metadata.direction) === "AVOID_OR_REASSESS" || normalize(metadata.direction) === "REASSESS_OR_CHANGE_STRATEGY") valence = -0.85;
    else if (normalize(metadata.direction) === "PREFER_WHEN_APPROPRIATE" || normalize(metadata.direction) === "PREFER_SOCIAL_CONTACT") valence = 0.55;
    else if (normalize(metadata.direction) === "BE_CAUTIOUS") valence = -0.35;
    else if (Number.isFinite(Number(metadata.reliability))) valence = clamp((Number(metadata.reliability) - 0.5) * 1.7, -1, 1);
    if (!valence) continue;
    const weight = (0.45 + 0.55 * locationExact) * recency * (0.45 + 0.35 * clamp01(row.strength) + 0.20 * clamp01(row.confidence));
    const delta = valence * weight * (row.memoryType === "PROCEDURAL" ? 0.30 : 0.22);
    biases[action] = clamp((biases[action] || 0) + delta, -MAX_MEMORY_POLICY_BIAS, MAX_MEMORY_POLICY_BIAS);
    matched.push({ actionType: action, memoryType: row.memoryType, delta, locationExact, content: row.content });
  }
  return { biases, memories: matched.slice(0, 20) };
}

async function persistDecisionCandidates(decisionId, chosenAction, candidates) {
  if (!decisionId || !Array.isArray(candidates) || !candidates.length) return;
  const [decisionRows] = await pool.query(`SELECT selected_option_id AS selectedOptionId FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1`, [decisionId]);
  const selectedOptionId = decisionRows[0]?.selectedOptionId || null;
  if (!selectedOptionId) return;
  const chosen = candidates.find(candidate => normalize(candidate.action) === normalize(chosenAction)) || candidates[0];
  await pool.query(
    `UPDATE decision_options SET option_code=?,description=?,action_definition=?,evaluation=?,expected_outcome=? WHERE id=UUID_TO_BIN(?)`,
    [chosen.action, `Autonomously considered ${chosen.action}`, JSON.stringify({ actionType: chosen.action, targetEntityId: chosen.targetEntityId || null, targetLocationId: chosen.targetLocationId || null, resourceIntent: chosen.resourceIntent || null }), JSON.stringify({ score: Number(chosen.score || 0), selected: true, rank: 1 }), JSON.stringify({ actionType: chosen.action }), selectedOptionId]
  );
  await pool.query(`DELETE FROM decision_options WHERE decision_id=UUID_TO_BIN(?) AND id<>UUID_TO_BIN(?)`, [decisionId, selectedOptionId]);
  const ordered = candidates.filter(candidate => normalize(candidate.action) !== normalize(chosen.action)).slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 3);
  const values = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    values.push([
      uuid(), decisionId, candidate.action, `Autonomously considered ${candidate.action}`,
      JSON.stringify({ actionType: candidate.action, targetEntityId: candidate.targetEntityId || null, targetLocationId: candidate.targetLocationId || null, resourceIntent: candidate.resourceIntent || null }),
      JSON.stringify({ score: Number(candidate.score || 0), selected: false, rank: index + 2 }),
      JSON.stringify({ actionType: candidate.action })
    ]);
  }
  for (const value of values) await pool.query(`INSERT INTO decision_options(id,decision_id,option_code,description,action_definition,evaluation,expected_outcome) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`, value);
}

function install() {
  if (installed) return;
  const memoryService = require("./memory-service");
  const originalCreateMemory = memoryService.createMemory;
  memoryService.createMemory = async function enhancedCreateMemory(args) {
    const incoming = { ...(args || {}) };
    const metadata = incoming.metadata && typeof incoming.metadata === "object" ? { ...incoming.metadata } : {};
    if (metadata.kind === "action_outcome" || metadata.kind === "resource_failure") {
      incoming.content = humanizeActionMemory(incoming, incoming.content);
      incoming.metadata = { ...metadata, schemaVersion: Math.max(3, Number(metadata.schemaVersion || 0)) };
    }
    const id = await originalCreateMemory(incoming);
    if (["action_outcome", "resource_failure"].includes(metadata.kind)) {
      Promise.resolve().then(() => consolidateActionMemories({ ...incoming, simulationAt: incoming.simulationAt, entityId: incoming.entityId, simulationId: incoming.simulationId })).catch(() => {});
    }
    return id;
  };

  const decisionService = require("./decision-service");
  const originalMakeDecision = decisionService.makeDecision;
  decisionService.makeDecision = async function enhancedMakeDecision(args) {
    const context = args?.context ? { ...args.context } : {};
    const entityId = args?.entityId || null;
    const policy = await memoryPolicyBias({ ...context, entityId });
    if (Array.isArray(context.candidates)) {
      context.candidates = context.candidates.map(candidate => ({ ...candidate, score: Number(candidate.score || 0) + Number(policy.biases[normalize(candidate.action)] || 0) }));
      context.memoryPolicy = policy;
    }
    const result = await originalMakeDecision({ ...args, context });
    if (result?.decisionId) await persistDecisionCandidates(result.decisionId, result.actionType, context.candidates);
    return result;
  };
  installed = true;
}

module.exports = { install, memoryPolicyBias, consolidateActionMemories, humanizeActionMemory, persistDecisionCandidates, MEMORY_TYPES };
