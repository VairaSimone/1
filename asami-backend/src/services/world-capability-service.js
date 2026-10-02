const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const DEFAULTS = {
  BUY_FOOD: {
    name: "Buy food",
    category: "ECONOMY",
    needWeights: { HUNGER: 2.9 },
    gate: ["HUNGER", 0.25],
    durationMinutes: 25,
    effect: { type: "BUY_FOOD", good: "FOOD", quantity: 1 }
  },
  WORK_JOB: {
    name: "Work a local job",
    category: "WORK",
    needWeights: { ACHIEVEMENT: 1.8 },
    gate: ["ACHIEVEMENT", 0.22],
    durationMinutes: 120,
    effect: { type: "WORK_JOB" }
  },
  ATTEND_COMMUNITY: {
    name: "Join a community activity",
    category: "SOCIAL",
    needWeights: { BELONGING: 1.7, FUN: 0.7 },
    gate: ["BELONGING", 0.28],
    durationMinutes: 60,
    effect: { type: "SOCIAL_ACTIVITY" }
  },
  PRODUCE_GOODS: {
    name: "Produce goods",
    category: "PRODUCTION",
    needWeights: { ACHIEVEMENT: 1.5, CURIOSITY: 0.4 },
    gate: ["ACHIEVEMENT", 0.25],
    durationMinutes: 180,
    effect: { type: "PRODUCE_GOODS" }
  }
};

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDefinition(row) {
  const parameters = parseJson(row.parameters, {});
  const definition = parseJson(row.definition, {});
  const merged = {
    ...(DEFAULTS[normalize(row.code)] || {}),
    ...(definition && typeof definition === "object" ? definition : {}),
    ...(parameters && typeof parameters === "object" ? parameters : {})
  };
  return {
    id: row.id || null,
    code: normalize(row.code),
    name: row.name || merged.name || normalize(row.code),
    category: row.category || merged.category || "GENERAL",
    locationId: row.locationId || row.scopeLocationId || null,
    sourceEntityId: row.sourceEntityId || row.originEntityId || null,
    parameters: merged,
    active: Boolean(Number(row.active ?? 1))
  };
}

function genericCapability(code) {
  return {
    name: code.replaceAll("_", " ").toLowerCase(),
    category: "EMERGENT",
    needWeights: {},
    durationMinutes: 45,
    effects: []
  };
}

async function ensureCapability({ simulationId, locationId, sourceEntityId, activityCode, activityRow = null, simulationTime }) {
  const code = normalize(activityCode);
  if (!code || !locationId) return false;
  const existing = await pool.query(
    "SELECT id FROM world_capabilities WHERE simulation_id=UUID_TO_BIN(?) AND location_id=UUID_TO_BIN(?) AND code=? LIMIT 1",
    [simulationId, locationId, code]
  );
  if (existing[0].length) return false;

  const base = activityRow
    ? normalizeDefinition(activityRow)
    : {
        id: null,
        code,
        ...genericCapability(code),
        locationId,
        sourceEntityId: sourceEntityId || null,
        parameters: genericCapability(code),
        active: true
      };

  await pool.query(
    "INSERT INTO world_capabilities " +
    "(id,simulation_id,location_id,source_entity_id,code,name,category,parameters,active,created_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,1,?,1)",
    [
      uuid(),
      simulationId,
      locationId,
      sourceEntityId || null,
      code,
      base.name,
      base.category,
      JSON.stringify(base.parameters || {}),
      simulationTime
    ]
  );
  return true;
}

async function ensureCapabilitiesForEmergentStructures(simulationId, simulationTime) {
  const [structures] = await pool.query(
    "SELECT BIN_TO_UUID(es.entity_id) entityId,BIN_TO_UUID(es.scope_location_id) scopeLocationId,es.structure_type structureType,es.activities " +
    "FROM emergent_structures es WHERE es.simulation_id=UUID_TO_BIN(?)",
    [simulationId]
  );

  const [catalog] = await pool.query(
    "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,BIN_TO_UUID(origin_entity_id) originEntityId," +
    "kind,code,name,category,definition,status " +
    "FROM emergent_definition_catalog " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND kind='ACTIVITY' AND status='ACTIVE'",
    [simulationId]
  );

  const catalogByScope = new Map();
  const catalogByCode = new Map();
  for (const row of catalog) {
    const normalized = normalize(row.code);
    const scopeKey = String(row.scopeLocationId || "");
    if (!catalogByCode.has(normalized)) catalogByCode.set(normalized, row);
    if (scopeKey) {
      if (!catalogByScope.has(scopeKey)) catalogByScope.set(scopeKey, new Map());
      catalogByScope.get(scopeKey).set(normalized, row);
    }
  }

  let created = 0;

  for (const row of structures) {
    const activityCodes = parseJson(row.activities, [])
      .map(item => normalize(typeof item === "object" ? item.code : item))
      .filter(Boolean);

    const scoped = catalogByScope.get(String(row.entityId));
    for (const activityCode of activityCodes) {
      const activityRow = scoped?.get(activityCode) || catalogByCode.get(activityCode) || null;
      if (await ensureCapability({
        simulationId,
        locationId: row.entityId,
        sourceEntityId: row.entityId,
        activityCode,
        activityRow,
        simulationTime
      })) created += 1;
    }

    const definitionRow = await pool.query(
      "SELECT attributes FROM entities WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1",
      [row.entityId, simulationId]
    );
    const attributes = parseJson(definitionRow[0][0]?.attributes, {});
    const definition = attributes?.definition || {};
    const category = normalize(definition.category);
    const isMarket = row.structureType === "MARKET" || definition.market === true || category === "MARKET" || category === "COMMERCE";
    const hasWork = row.structureType === "WORKSHOP" ||
      Boolean(definition.production) ||
      (Array.isArray(definition.activities) && definition.activities.some(activity => {
        const c = normalize(activity?.category);
        return c === "WORK" || c === "PRODUCTION" || c === "CRAFT";
      }));

    if (isMarket && await ensureCapability({
      simulationId,
      locationId: row.entityId,
      sourceEntityId: row.entityId,
      activityCode: "BUY_FOOD",
      activityRow: {
        code: "BUY_FOOD",
        name: DEFAULTS.BUY_FOOD.name,
        category: DEFAULTS.BUY_FOOD.category,
        parameters: DEFAULTS.BUY_FOOD
      },
      simulationTime
    })) created += 1;

    if (hasWork && await ensureCapability({
      simulationId,
      locationId: row.entityId,
      sourceEntityId: row.entityId,
      activityCode: "WORK_JOB",
      activityRow: {
        code: "WORK_JOB",
        name: DEFAULTS.WORK_JOB.name,
        category: DEFAULTS.WORK_JOB.category,
        parameters: DEFAULTS.WORK_JOB
      },
      simulationTime
    })) created += 1;
  }

  for (const row of catalog) {
    if (!row.scopeLocationId) continue;
    const definition = normalizeDefinition(row);
    const activity = Array.isArray(definition.parameters.activities)
      ? definition.parameters.activities[0]
      : definition.parameters;
    if (!activity || !activity.code) continue;

    if (await ensureCapability({
      simulationId,
      locationId: row.scopeLocationId,
      sourceEntityId: row.originEntityId,
      activityCode: activity.code,
      activityRow: {
        ...row,
        code: activity.code,
        name: activity.name || row.name,
        category: activity.category || row.category,
        parameters: activity
      },
      simulationTime
    })) created += 1;
  }

  return { created };
}

async function loadActivityCatalog() {
  const [rows] = await pool.query(
    "SELECT BIN_TO_UUID(id) id,code,name,category,parameters,active FROM activity_types WHERE active=1 ORDER BY category,code"
  );
  return rows.map(normalizeDefinition);
}

async function loadCapabilitiesForEntities(simulationId, entityIds = []) {
  const ids = [...new Set(entityIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
  const [rows] = await pool.query(
    "SELECT BIN_TO_UUID(elc.entity_id) entityId,BIN_TO_UUID(wc.id) id,BIN_TO_UUID(wc.location_id) locationId," +
    "BIN_TO_UUID(wc.source_entity_id) sourceEntityId,wc.code,wc.name,wc.category,wc.parameters,wc.active " +
    "FROM entity_locations_current elc " +
    "JOIN world_capabilities wc ON wc.location_id=elc.location_id AND wc.simulation_id=elc.simulation_id " +
    "WHERE elc.simulation_id=UUID_TO_BIN(?) AND elc.entity_id IN (" + placeholders + ") AND wc.active=1",
    [simulationId, ...ids]
  );

  const result = new Map(ids.map(id => [id, []]));
  for (const row of rows) result.get(String(row.entityId))?.push(normalizeDefinition(row));
  return result;
}

function scoreDynamicActivity(activity, needs = [], traits = []) {
  const definition = normalizeDefinition(activity);
  const params = definition.parameters || {};
  const gate = Array.isArray(params.gate)
    ? params.gate
    : params.gate && typeof params.gate === "object"
      ? [params.gate.needCode, params.gate.min]
      : null;

  if (gate) {
    const value = Number(needs.find(n => normalize(n.code) === normalize(gate[0]))?.value || 0);
    if (value < Number(gate[1] || 0)) return 0;
  }

  let score = 0;
  const weights = params.needWeights && typeof params.needWeights === "object"
    ? params.needWeights
    : {};

  for (const [needCode, weight] of Object.entries(weights)) {
    score += Number(needs.find(n => normalize(n.code) === normalize(needCode))?.value || 0) * Number(weight || 0);
  }

  const traitBias = traits.reduce((sum, trait) => {
    const traitCode = normalize(trait.code);
    if (traitCode === "DISCIPLINE" && String(definition.category).toUpperCase() === "WORK") {
      return sum + (Number(trait.value) - 0.5) * 0.8;
    }
    if (traitCode === "SOCIABILITY" && String(definition.category).toUpperCase() === "SOCIAL") {
      return sum + (Number(trait.value) - 0.5) * 0.7;
    }
    return sum;
  }, 0);

  return Math.max(0, score + traitBias);
}

function dynamicCodes(activities = []) {
  return activities.map(activity => normalize(activity.code || activity)).filter(Boolean);
}

module.exports = {
  DEFAULTS,
  ensureCapabilitiesForEmergentStructures,
  loadCapabilitiesForEntities,
  loadActivityCatalog,
  scoreDynamicActivity,
  dynamicCodes,
  normalizeDefinition
};