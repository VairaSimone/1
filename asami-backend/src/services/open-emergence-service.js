const crypto = require("crypto");
const { z } = require("zod");
const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent } = require("./event-service");
const {
  validateDefinition,
  registerDefinition,
  normalizeDefinition,
  code,
  KINDS
} = require("./emergent-definition-service");
const { ensureCapabilitiesForEmergentStructures } = require("./world-capability-service");
const { ensureCatalog } = require("./society-service");
const logger = require("../lib/logger");

const PERSON = "00000000-0000-4000-8000-000000000001";
const LOCATION = "00000000-0000-4000-8000-000000000003";
const PROPOSAL_COOLDOWN_HOURS = 24;
const MAX_AI_ACTIVITIES = 4;

const ProposalSchema = z.object({
  kind: z.string().min(1).max(24),
  code: z.string().min(3).max(80),
  name: z.string().min(3).max(160),
  category: z.string().min(1).max(64),
  purpose: z.string().min(3).max(600),
  market: z.boolean().optional(),
  production: z.boolean().optional(),
  activities: z.array(z.object({
    code: z.string().min(3).max(80),
    name: z.string().min(3).max(120),
    category: z.string().min(1).max(48),
    durationMinutes: z.number().min(5).max(720),
    needWeights: z.record(z.string(), z.number()).optional(),
    gate: z.object({ needCode: z.string(), min: z.number().min(0).max(1) }).nullable().optional(),
    effects: z.array(z.object({
      type: z.string(),
      needCode: z.string().optional(),
      resource: z.string().optional(),
      goodCode: z.string().optional(),
      delta: z.number().optional()
    }).passthrough()).max(4)
  })).max(MAX_AI_ACTIVITIES),
  products: z.array(z.object({
    code: z.string().min(3).max(64),
    name: z.string().min(3).max(120),
    category: z.string().min(1).max(48),
    unit: z.string().min(1).max(24),
    basePrice: z.number().positive().max(100)
  })).max(3).optional(),
  resourceCosts: z.record(z.string(), z.number()).optional(),
  targetNeeds: z.array(z.object({ code: z.string(), weight: z.number() })).max(8).optional(),
  formation: z.string().max(120).optional(),
  membership: z.string().max(120).optional()
});

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 8).toUpperCase();
}

function average(values) {
  const a = values.map(Number).filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

async function loadActors(simulationId) {
  const [rows] = await pool.query(
    "SELECT BIN_TO_UUID(e.id) entityId,e.display_name displayName,BIN_TO_UUID(elc.location_id) locationId " +
    "FROM entities e JOIN entity_types et ON et.id=e.entity_type_id " +
    "LEFT JOIN entity_locations_current elc ON elc.entity_id=e.id AND elc.simulation_id=e.simulation_id " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) AND et.id=UUID_TO_BIN(?) AND e.status='ACTIVE'",
    [simulationId, PERSON]
  );
  if (!rows.length) return [];

  const ids = rows.map(row => String(row.entityId));
  const placeholders = ids.map(() => "UUID_TO_BIN(?)").join(",");
  const [needs] = await pool.query(
    "SELECT BIN_TO_UUID(enc.entity_id) entityId,nd.code,enc.value,nd.default_value defaultValue " +
    "FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id " +
    "WHERE enc.entity_id IN (" + placeholders + ") AND nd.active=1",
    ids
  );
  const [traits] = await pool.query(
    "SELECT BIN_TO_UUID(etc.entity_id) entityId,td.code,etc.value " +
    "FROM entity_traits_current etc JOIN trait_definitions td ON td.id=etc.trait_id " +
    "WHERE etc.entity_id IN (" + placeholders + ") AND td.active=1",
    ids
  );

  const map = new Map(rows.map(row => [String(row.entityId), { ...row, needs: {}, needMeta: {}, traits: {} }]));
  for (const row of needs) {
    const actor = map.get(String(row.entityId));
    if (actor) { actor.needs[code(row.code)] = Number(row.value); actor.needMeta[code(row.code)] = { defaultValue: Number(row.defaultValue ?? 0.5) }; }
  }
  for (const row of traits) {
    const actor = map.get(String(row.entityId));
    if (actor) actor.traits[code(row.code)] = Number(row.value);
  }
  return Array.from(map.values());
}

async function loadLocations(simulationId) {
  const [rows] = await pool.query(
    "SELECT BIN_TO_UUID(e.id) locationId,e.display_name name,e.attributes,l.location_type locationType,l.latitude,l.longitude " +
    "FROM entities e JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id " +
    "WHERE e.simulation_id=UUID_TO_BIN(?) AND e.entity_type_id=UUID_TO_BIN(?) AND e.status='ACTIVE' " +
    "ORDER BY e.created_simulation_at",
    [simulationId, LOCATION]
  );
  return rows.map(row => ({ ...row, attributes: parseJson(row.attributes, {}) }));
}

function topNeedSignal(actors) {
  const allCodes = new Set();
  for (const actor of actors) {
    for (const need of Object.keys(actor.needs || {})) allCodes.add(need);
  }

  let best = null;
  for (const needCode of allCodes) {
    const values = actors.map(actor => Number(actor.needs?.[needCode] || 0));
    const defaultValue = average(actors.map(actor => Number(actor.needMeta?.[needCode]?.defaultValue ?? 0.5)));
    const direction = defaultValue > 0.5 ? "LOW" : "HIGH";
    const pressures = values.map(value => direction === "LOW" ? 1 - value : value);
    const pressure = average(pressures);
    const highCount = pressures.filter(value => value >= 0.62).length;
    const breadth = highCount / Math.max(1, actors.length);
    const score = clamp(pressure * 0.72 + breadth * 0.28);
    if (!best || score > best.score) {
      best = {
        needCode,
        pressure,
        observedValue: average(values),
        defaultValue,
        direction,
        highCount,
        breadth,
        score
      };
    }
  }
  return best;
}

function selectProposer(actors, signal) {
  return [...actors].sort((a, b) => {
    const ap = Number(a.needs?.[signal.needCode] || 0);
    const bp = Number(b.needs?.[signal.needCode] || 0);
    const ac = Number(a.traits?.CONFIDENCE || 0.5);
    const bc = Number(b.traits?.CONFIDENCE || 0.5);
    const aa = Number(a.traits?.ACHIEVEMENT || a.traits?.CONSCIENTIOUSNESS || 0.5);
    const ba = Number(b.traits?.ACHIEVEMENT || b.traits?.CONSCIENTIOUSNESS || 0.5);
    return (bp * 0.65 + bc * 0.2 + ba * 0.15) - (ap * 0.65 + ac * 0.2 + aa * 0.15);
  })[0] || null;
}

function deterministicFallbackDefinition(signal, proposer, simulationTime, { economicOpportunity = false } = {}) {
  const seed = hash(signal.needCode + "|" + proposer.entityId + "|" + simulationTime);
  const kinds = Array.from(KINDS);
  const kind = kinds[parseInt(seed.slice(0, 2), 16) % kinds.length];
  const baseCode = "EMERGENT_" + kind + "_" + signal.needCode + "_" + seed.slice(0, 6);
  const activityCode = kind === "ACTIVITY" ? baseCode : baseCode + "_ACT";
  const needLabel = signal.needCode.toLowerCase().replaceAll("_", " ");
  const needDelta = signal.direction === "LOW" ? 0.12 : -0.12;
  const foodCrisis = signal.needCode === "HUNGER" && signal.direction === "HIGH";
  const economicResponse = economicOpportunity && signal.needCode !== "THIRST";
  if (economicResponse) {
    const production = signal.needCode === "ACHIEVEMENT";
    return normalizeDefinition({
      kind: "STRUCTURE",
      code: baseCode + "_EXCHANGE",
      name: (proposer.displayName || "Locali") + " - local exchange",
      category: "COMMERCE",
      market: true,
      production,
      purpose: "A locally organized exchange created after recurring pressure revealed a need for durable material coordination.",
      products: [],
      targetNeeds: [{ code: signal.needCode, weight: 2 }],
      activities: [{
        code: production ? baseCode + "_MAKE_TOOLS" : baseCode + "_EXCHANGE",
        name: production ? "Produce useful tools" : "Exchange useful goods locally",
        category: production ? "PRODUCTION" : "COMMERCE",
        durationMinutes: production ? 120 : 30,
        needWeights: { [signal.needCode]: 1.5, ACHIEVEMENT: 0.5 },
        gate: { needCode: signal.needCode, min: 0.30 },
        effects: production
          ? [{ type: "PRODUCTION", goodCode: "TOOLS", quantity: 2, resourceInputs: { water: 1 }, inventoryInputs: {} }]
          : [{ type: "NEED_DELTA", needCode: signal.needCode, delta: needDelta }]
      }],
      formation: "BOTTOM_UP",
      membership: "VOLUNTARY",
      origin: "DETERMINISTIC_ECONOMIC_BRIDGE"
    });
  }
  return normalizeDefinition({
    kind: foodCrisis ? "STRUCTURE" : kind,
    code: foodCrisis ? baseCode + "_SUPPLY" : baseCode,
    name: foodCrisis ? (proposer.displayName || "Locali") + " - local food supply" : (proposer.displayName || "Locali") + " - " + needLabel + " initiative",
    category: foodCrisis ? "COMMERCE" : "EMERGENT",
    market: foodCrisis,
    production: foodCrisis,
    purpose: foodCrisis ? "A locally organized response to shared food scarcity." : "A new autonomous response to a shared " + needLabel + " pressure.",
    products: [],
    targetNeeds: [{ code: signal.needCode, weight: 2 }],
    activities: foodCrisis ? [{
      code: baseCode + "_GROW_FOOD",
      name: "Produce local food",
      category: "PRODUCTION",
      durationMinutes: 120,
      needWeights: { HUNGER: 2, ACHIEVEMENT: 0.5 },
      gate: { needCode: "HUNGER", min: 0.30 },
      effects: [{ type: "PRODUCTION", goodCode: "FOOD", quantity: 2, resourceInputs: { water: 1 }, inventoryInputs: {} }]
    }] : [{
      code: activityCode,
      name: "Practice " + needLabel + " locally",
      category: "EMERGENT",
      durationMinutes: 45,
      needWeights: { [signal.needCode]: 2 },
      gate: { needCode: signal.needCode, min: 0.30 },
      effects: [{ type: "NEED_DELTA", needCode: signal.needCode, delta: needDelta }]
    }],
    formation: "BOTTOM_UP",
    membership: "VOLUNTARY",
    origin: "DETERMINISTIC_FALLBACK"
  });
}
async function askGemini(gemini, { simulationTime, scope, signal, proposer, actors, economicOpportunity = false, similarProposalCount = 0, recurringPressureProposals = 0, recentLocalDefinitions = [] }) {
  if (!gemini || typeof gemini.generateJson !== "function") return null;
  const context = {
    simulationTime,
    location: {
      locationId: scope.locationId,
      name: scope.name,
      locationType: scope.locationType
    },
    sharedPressure: {
      needCode: signal.needCode,
      averageValue: Number(signal.observedValue.toFixed(4)),
      pressure: Number(signal.pressure.toFixed(4)),
      pressureDirection: signal.direction,
      highNeedAgents: signal.highCount,
      population: actors.length
    },
    proposer: {
      entityId: proposer.entityId,
      displayName: proposer.displayName,
      needs: Object.fromEntries(Object.entries(proposer.needs || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      traits: Object.fromEntries(Object.entries(proposer.traits || {}).sort((a, b) => b[1] - a[1]).slice(0, 6))
    },
    localActors: actors.slice(0, 18).map(actor => ({
      entityId: actor.entityId,
      displayName: actor.displayName,
      needs: Object.fromEntries(Object.entries(actor.needs || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)),
      traits: Object.fromEntries(Object.entries(actor.traits || {}).sort((a, b) => b[1] - a[1]).slice(0, 4))
    })),
    economicOpportunity,
    recurringSimilarProposals: Number(similarProposalCount || 0),
    recurringPressureProposals: Number(recurringPressureProposals || 0),
    recentLocalDefinitions
  };

  const prompt = [
    "You are the generative design layer inside an autonomous society simulation.",
    "One inhabitant is proposing a genuinely new social possibility in response to a shared local pressure.",
    "Invent a novel STRUCTURE, INSTITUTION, ACTIVITY, or SYSTEM. Do not assume a fixed project taxonomy.",
    "Treat existing local inventions as part of the society's history: do not recreate the same semantic solution. Extend, specialize, transform, or replace an existing solution when appropriate.",
    "If recurringSimilarProposals or recurringPressureProposals is greater than zero, prefer a genuinely different consequence or a concrete evolution of the existing local invention rather than another renamed copy.",
    "The definition is data, not code. It may only use safe effects: NEED_DELTA, RESOURCE_DELTA, INVENTORY_DELTA, PRODUCTION.",
    "When economicOpportunity is true, the proposal must create a durable material/economic capability (market, commerce, production, or work) caused by recurring local pressure; never invent money or free resources.",
    "Never emit SQL, code, commands, external URLs, invented entity IDs, arbitrary formulas, or effects outside the safe vocabulary.",
    "Activities are compositional: code, name, category, need weights, gate, duration and safe effect combinations may be novel.",
    "Make the proposal concrete and locally plausible from the people and resources shown.",
    "Return JSON only. Keep the proposal compact: max four activities and four effects per activity.",
    JSON.stringify(context)
  ].join("\\n");

  try {
    return await gemini.generateJson(prompt, ProposalSchema, {
      kind: "autonomy",
      thinkingLevel: "low",
      maxModels: 1,
      outputTokenCeilingOverride: 1200,
      timeoutMsOverride: 10000,
      deadlineAt: Date.now() + 10000
    });
  } catch (error) {
    logger.warn({
      simulationTime,
      proposerEntityId: proposer.entityId,
      error: String(error?.message || error)
    }, "open emergence Gemini proposal failed");
    return null;
  }
}

async function hasRecentProposal(simulationId, scopeLocationId, simulationTime) {
  const [rows] = await pool.query(
    "SELECT id FROM emergent_world_proposals " +
    "WHERE simulation_id=UUID_TO_BIN(?) AND " +
    "(scope_location_id=UUID_TO_BIN(?) OR scope_location_id IS NULL) " +
    "AND created_simulation_at>=DATE_SUB(?,INTERVAL " + PROPOSAL_COOLDOWN_HOURS + " HOUR) LIMIT 1",
    [simulationId, scopeLocationId, simulationTime]
  );
  return rows.length > 0;
}

function semanticDefinitionSignature(definition = {}) {
  const activities = Array.isArray(definition.activities) ? definition.activities : [];
  const effects = activities.flatMap(activity => Array.isArray(activity.effects) ? activity.effects : []);
  return JSON.stringify({
    targetNeeds: (definition.targetNeeds || []).map(item => code(item?.code)).filter(Boolean).sort(),
    market: Boolean(definition.market),
    production: Boolean(definition.production),
    category: normalize(definition.category),
    activityCategories: activities.map(activity => normalize(activity?.category)).filter(Boolean).sort(),
    effectTypes: effects.map(effect => normalize(effect?.type)).filter(Boolean).sort(),
    products: (definition.products || []).map(product => code(product?.code)).filter(Boolean).sort()
  });
}

function isMaterialEconomicDefinition(definition = {}) {
  const category = normalize(definition.category);
  const activities = Array.isArray(definition.activities) ? definition.activities : [];
  return Boolean(definition.market || definition.production)
    || ['MARKET','COMMERCE'].includes(category)
    || activities.some(activity => ['WORK','PRODUCTION','CRAFT','COMMERCE'].includes(normalize(activity?.category)));
}

async function countRecentPressureProposals(simulationId, scopeLocationId, needCode, simulationTime) {
  const [rows] = await pool.query(
    "SELECT definition FROM emergent_world_proposals WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND status='ACCEPTED' AND created_simulation_at>=DATE_SUB(?,INTERVAL 7 DAY) ORDER BY created_simulation_at DESC LIMIT 40",
    [simulationId, scopeLocationId, simulationTime]
  );
  const target = code(needCode);
  return rows.reduce((count, row) => {
    const definition = parseJson(row.definition, {});
    const targets = Array.isArray(definition.targetNeeds) ? definition.targetNeeds : [];
    return count + (targets.some(item => code(item?.code) === target) ? 1 : 0);
  }, 0);
}

async function countRecentSimilarProposals(simulationId, scopeLocationId, definition, simulationTime) {
  const [rows] = await pool.query(
    "SELECT definition FROM emergent_world_proposals WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND status='ACCEPTED' AND created_simulation_at>=DATE_SUB(?,INTERVAL 7 DAY) ORDER BY created_simulation_at DESC LIMIT 30",
    [simulationId, scopeLocationId, simulationTime]
  );
  const signature = semanticDefinitionSignature(definition);
  return rows.reduce((count, row) => count + (semanticDefinitionSignature(parseJson(row.definition, {})) === signature ? 1 : 0), 0);
}

function supportScore(definition, actors) {
  const targetNeeds = (definition.targetNeeds || []).filter(
    item => Number.isFinite(Number(item.weight)) && Number(item.weight) !== 0
  );
  const positiveWeights = targetNeeds.reduce(
    (sum, item) => sum + Math.abs(Number(item.weight)),
    0
  ) || 1;

  const activityEffects = definition.activities
    .flatMap(activity => activity.effects || [])
    .filter(effect => effect.type === "NEED_DELTA");

  const scores = actors.map(actor => {
    let utility = 0.46;
    let needFit = 0;

    for (const target of targetNeeds) {
      const targetCode = code(target.code);
      const value = Number(actor.needs?.[targetCode] || 0);
      const defaultValue = Number(actor.needMeta?.[targetCode]?.defaultValue ?? 0.5);
      const pressure = defaultValue > 0.5 ? 1 - value : value;
      needFit += pressure * Number(target.weight || 0);
    }

    utility += 0.24 * clamp(Math.abs(needFit) / positiveWeights);

    for (const effect of activityEffects) {
      const effectCode = code(effect.needCode);
      const current = Number(actor.needs?.[effectCode] || 0);
      const defaultValue = Number(actor.needMeta?.[effectCode]?.defaultValue ?? 0.5);
      const delta = Number(effect.delta || 0);
      const improvesPressure = defaultValue > 0.5 ? delta > 0 : delta < 0;

      if (improvesPressure) {
        utility += 0.16 * (defaultValue > 0.5 ? 1 - current : current) * Math.min(1, Math.abs(delta) / 0.2);
      } else if (delta !== 0) {
        utility -= 0.12 * Math.min(1, Math.abs(delta) / 0.2);
      }
    }

    const independence = Number(actor.traits?.INDEPENDENCE || 0.5);
    const empathy = Number(actor.traits?.EMPATHY || 0.5);
    const conscientiousness = Number(actor.traits?.CONSCIENTIOUSNESS || 0.5);
    if (normalize(definition.membership) === "VOLUNTARY") {
      utility += 0.05 * (independence - 0.5);
    }
    if (normalize(definition.membership).includes("SHARED")) {
      utility += 0.06 * (empathy - 0.5) + 0.04 * (conscientiousness - 0.5);
    }

    return clamp(utility);
  });

  return {
    score: average(scores),
    supporters: scores.filter(score => score >= 0.52).length,
    required: Math.max(3, Math.ceil(actors.length * 0.35)),
    perActor: scores
  };
}

async function persistProposal({ simulationId, simulationTime, proposer, scope, definition, validation, support }) {
  const id = uuid();
  const status = validation.valid && support.supporters >= support.required && support.score >= 0.52
    ? "ACCEPTED"
    : "REJECTED";

  await pool.query(
    "INSERT INTO emergent_world_proposals " +
    "(id,simulation_id,proposer_entity_id,scope_location_id,kind,code,title,rationale,definition,validation,support_score,required_support,status,created_simulation_at,decided_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,1)",
    [
      id,
      simulationId,
      proposer.entityId,
      scope.locationId,
      definition.kind,
      definition.code,
      definition.name,
      JSON.stringify({
        needCode: definition.targetNeeds?.[0]?.code || null,
        proposerNeeds: proposer.needs
      }),
      JSON.stringify(definition),
      JSON.stringify({ ...validation, support }),
      support.score,
      support.required,
      status,
      simulationTime,
      status === "REJECTED" ? simulationTime : null
    ]
  );
  return { id, status };
}

async function registerEmergentProducts(simulationId, simulationTime, definition) {
  for (const product of definition.products || []) {
    await pool.query(
      `INSERT INTO emergent_goods
        (id,simulation_id,code,name,category,unit,base_price,created_simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),unit=VALUES(unit),base_price=VALUES(base_price)`,
      [uuid(),simulationId,product.code,product.name,product.category,product.unit,product.basePrice,simulationTime]
    );
  }
}

async function createProjectCompatibilityRecord(simulationId, simulationTime, proposal, proposerEntityId) {
  const projectId = uuid();
  const definition = proposal.definition;
  await pool.query(
    "INSERT INTO emergent_projects " +
    "(id,simulation_id,proposer_entity_id,scope_location_id,project_type,issue_code,title,description,status,support_score,required_support,proposal,created_simulation_at,updated_simulation_at,completed_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?, ?,?,?,?,1)",
    [
      projectId,
      simulationId,
      proposerEntityId,
      proposal.scopeLocationId || null,
      definition.code,
      definition.targetNeeds?.[0]?.code || "EMERGENT",
      definition.name,
      definition.purpose,
      "COMPLETED",
      proposal.supportScore || 1,
      proposal.requiredSupport || 3,
      JSON.stringify(definition),
      simulationTime,
      simulationTime,
      simulationTime
    ]
  );
  return projectId;
}

async function createStructure(simulationId, simulationTime, proposal, scope, actors) {
  const definition = proposal.definition;
  await registerEmergentProducts(simulationId, simulationTime, definition);
  const entityId = uuid();
  const latitude = Number(scope.latitude || 0) + 0.0007;
  const longitude = Number(scope.longitude || 0) + 0.0007;
  const structureProjectId = await createProjectCompatibilityRecord(simulationId, simulationTime, {
    ...proposal,
    scopeLocationId: scope.locationId
  }, proposal.proposerEntityId);

  const attributes = {
    emergent: true,
    openEnded: true,
    definition,
    originProposalId: proposal.id,
    connections: [scope.locationId],
    resources: { water: 8, food: 0 }
  };

  await pool.query(
    "INSERT INTO entities " +
    "(id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'ACTIVE', ?, ?,1)",
    [entityId, simulationId, LOCATION, definition.name, definition.purpose, JSON.stringify(attributes), simulationTime]
  );

  await pool.query(
    "INSERT INTO locations(entity_id,simulation_id,location_type,latitude,longitude,address_data) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?)",
    [entityId, simulationId, "EMERGENT", latitude, longitude, JSON.stringify({
      emergent: true,
      openEnded: true,
      originProposalId: proposal.id,
      definitionCode: definition.code,
      connections: [scope.locationId]
    })]
  );

  const [originRows] = await pool.query(
    "SELECT address_data AS addressData FROM locations WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) LIMIT 1 FOR UPDATE",
    [scope.locationId, simulationId]
  );
  if (originRows.length) {
    const originAddress = parseJson(originRows[0].addressData, {});
    const connections = Array.isArray(originAddress.connections) ? originAddress.connections.map(String) : [];
    if (!connections.includes(String(entityId))) connections.push(String(entityId));
    await pool.query(
      "UPDATE locations SET address_data=? WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)",
      [JSON.stringify({ ...originAddress, connections }), scope.locationId, simulationId]
    );
  }

  const structureDefinitionId = await registerDefinition(simulationId, {
    kind: "STRUCTURE",
    definition,
    scopeLocationId: entityId,
    originEntityId: proposal.proposerEntityId,
    originProposalId: proposal.id,
    simulationTime
  });

  for (const activity of definition.activities) {
    await registerDefinition(simulationId, {
      kind: "ACTIVITY",
      definition: {
        ...activity,
        kind: "ACTIVITY",
        code: activity.code,
        activities: [activity]
      },
      scopeLocationId: entityId,
      originEntityId: proposal.proposerEntityId,
      originProposalId: proposal.id,
      simulationTime
    });
  }

  await pool.query(
    "INSERT INTO emergent_structures " +
    "(id,simulation_id,project_id,entity_id,structure_type,name,scope_location_id,activities,attributes,created_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,UUID_TO_BIN(?),?,?,?,1)",
    [
      uuid(),
      simulationId,
      structureProjectId,
      entityId,
      definition.code,
      definition.name,
      scope.locationId,
      JSON.stringify(definition.activities.map(activity => activity.code)),
      JSON.stringify({
        origin: "AGENT_PROPOSAL",
        definitionId: structureDefinitionId,
        proposalId: proposal.id,
        definitionCode: definition.code
      }),
      simulationTime
    ]
  );

  for (const actor of actors.slice(0, 12)) {
    await pool.query(
      "INSERT IGNORE INTO emergent_project_members " +
      "(project_id,simulation_id,entity_id,role,motivation,joined_simulation_at) " +
      "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'SUPPORTER',?,?)",
      [
        structureProjectId,
        simulationId,
        actor.entityId,
        JSON.stringify({ origin: "AGENT_PROPOSAL", supportScore: proposal.supportScore || 0 }),
        simulationTime
      ]
    );
  }

  await createEvent({
    simulationId,
    eventTypeCode: "SOCIAL",
    title: definition.name + " emerged",
    description: definition.purpose,
    simulationAt: simulationTime,
    importance: 0.78,
    metadata: {
      emergent: true,
      openEnded: true,
      kind: "DEFINITION_ACCEPTED",
      proposalId: proposal.id,
      definitionKind: definition.kind,
      definitionCode: definition.code,
      locationId: entityId,
      activities: definition.activities.map(activity => activity.code)
    },
    participants: actors.slice(0, 8).map(actor => ({ entityId: actor.entityId, role: "FOUNDING_MEMBER" }))
  });

  return { structureProjectId, structureDefinitionId, entityId };
}

async function createSystem(simulationId, simulationTime, proposal, scope, actors) {
  const definition = proposal.definition;
  await registerEmergentProducts(simulationId, simulationTime, definition);
  const systemId = uuid();
  const systemEntityId = uuid();

  await pool.query(
    "INSERT INTO entities " +
    "(id,simulation_id,entity_type_id,display_name,description,status,attributes,created_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?, 'ACTIVE', ?, ?,1)",
    [systemEntityId, simulationId, "00000000-0000-4000-8000-000000000005", definition.name, definition.purpose,
      JSON.stringify({ emergent: true, openEnded: true, definition, systemId }), simulationTime]
  );

  await pool.query(
    "INSERT INTO emergent_systems " +
    "(id,simulation_id,system_type,name,scope_location_id,stage,attributes,created_simulation_at,updated_simulation_at,version) " +
    "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,UUID_TO_BIN(?),'EMERGING',?,?,?,1)",
    [
      systemId,
      simulationId,
      definition.code,
      definition.name,
      scope.locationId,
      JSON.stringify({
        emergent: true,
        openEnded: true,
        kind: definition.kind,
        definition,
        systemEntityId
      }),
      simulationTime,
      simulationTime
    ]
  );

  const definitionId = await registerDefinition(simulationId, {
    kind: definition.kind,
    definition,
    scopeLocationId: scope.locationId,
    originEntityId: proposal.proposerEntityId,
    originProposalId: proposal.id,
    simulationTime
  });

  for (const activity of definition.activities) {
    await registerDefinition(simulationId, {
      kind: "ACTIVITY",
      definition: {
        ...activity,
        kind: "ACTIVITY",
        code: activity.code,
        activities: [activity]
      },
      scopeLocationId: scope.locationId,
      originEntityId: proposal.proposerEntityId,
      originProposalId: proposal.id,
      simulationTime
    });
  }

  for (const actor of actors.slice(0, 12)) {
    await pool.query(
      "INSERT IGNORE INTO emergent_system_members(system_id,simulation_id,entity_id,role,support_score,joined_simulation_at) " +
      "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'FOUNDING_MEMBER',?,?)",
      [systemId, simulationId, actor.entityId, 0.6, simulationTime]
    );
  }

  await createEvent({
    simulationId,
    eventTypeCode: "SOCIAL",
    title: definition.name + " formed",
    description: definition.purpose,
    simulationAt: simulationTime,
    importance: 0.76,
    metadata: {
      emergent: true,
      openEnded: true,
      kind: "SYSTEM_FORMED",
      systemId,
      systemEntityId,
      definitionKind: definition.kind,
      definitionCode: definition.code
    },
    participants: actors.slice(0, 8).map(actor => ({ entityId: actor.entityId, role: "FOUNDING_MEMBER" }))
  });

  return { systemId, systemEntityId, definitionId };
}

async function materializeProposal(simulationId, simulationTime, proposal, scope, actors) {
  if (proposal.definition.kind === "STRUCTURE") {
    return createStructure(simulationId, simulationTime, proposal, scope, actors);
  }
  if (proposal.definition.kind === "ACTIVITY") {
    await registerEmergentProducts(simulationId, simulationTime, proposal.definition);
    const definitionId = await registerDefinition(simulationId, {
      kind: "ACTIVITY",
      definition: proposal.definition,
      scopeLocationId: scope.locationId,
      originEntityId: proposal.proposerEntityId,
      originProposalId: proposal.id,
      simulationTime
    });
    await createEvent({
      simulationId,
      eventTypeCode: "SOCIAL",
      title: proposal.definition.name + " became part of local life",
      description: proposal.definition.purpose,
      simulationAt: simulationTime,
      importance: 0.58,
      metadata: {
        emergent: true,
        openEnded: true,
        kind: "ACTIVITY_EMERGED",
        proposalId: proposal.id,
        definitionId,
        definitionCode: proposal.definition.code,
        locationId: scope.locationId
      }
    });
    return { definitionId };
  }
  return createSystem(simulationId, simulationTime, proposal, scope, actors);
}

async function proposeForLocation(simulationId, simulationTime, scope, actors, gemini) {
  if (actors.length < 3) return null;
  const signal = topNeedSignal(actors);
  if (!signal || signal.score < 0.55 || signal.highCount < 3) return null;
  if (await hasRecentProposal(simulationId, scope.locationId, simulationTime)) return null;

  const proposer = selectProposer(actors, signal);
  if (!proposer) return null;

  const [[simulationRows], [economicRows]] = await Promise.all([
    pool.query("SELECT started_simulation_at startedAt FROM simulations WHERE id=UUID_TO_BIN(?) LIMIT 1", [simulationId]),
    pool.query("SELECT (SELECT COUNT(*) FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) AND status='ACTIVE') businessCount, (SELECT COUNT(*) FROM emergent_market_state WHERE simulation_id=UUID_TO_BIN(?)) marketCount", [simulationId, simulationId])
  ]);
  const startedAt = new Date(simulationRows[0]?.startedAt || simulationTime).getTime();
  const now = new Date(simulationTime).getTime();
  const simulationAgeHours = Number.isFinite(startedAt) && Number.isFinite(now)
    ? Math.max(0, (now - startedAt) / 3600000)
    : 0;
  const economicState = economicRows[0] || {};

  const similarityProbe = deterministicFallbackDefinition(signal, proposer, simulationTime);
  const [similarProposalCount, recurringPressureProposals] = await Promise.all([
    countRecentSimilarProposals(simulationId, scope.locationId, similarityProbe, simulationTime),
    countRecentPressureProposals(simulationId, scope.locationId, signal.needCode, simulationTime)
  ]);
  const economicOpportunity = simulationAgeHours >= 72
    && Number(economicState.businessCount || 0) === 0
    && Number(economicState.marketCount || 0) === 0
    && (similarProposalCount >= 2 || recurringPressureProposals >= 3);

  const [recentLocalDefinitions] = await pool.query(
    "SELECT kind,code,name,category,definition FROM emergent_definition_catalog WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY created_simulation_at DESC LIMIT 12",
    [simulationId, scope.locationId]
  );

  // Repeated pressure is part of the context, not an automatic veto.
  // Gemini gets the local history and may evolve the existing solution.
  const generated = await askGemini(gemini, {
    simulationTime,
    scope,
    signal,
    proposer,
    actors,
    economicOpportunity,
    similarProposalCount,
    recurringPressureProposals,
    recentLocalDefinitions: recentLocalDefinitions.map(row => ({
      kind: row.kind,
      code: row.code,
      name: row.name,
      category: row.category,
      definition: parseJson(row.definition, {})
    }))
  });

  let definition = generated
    ? normalizeDefinition(generated)
    : deterministicFallbackDefinition(signal, proposer, simulationTime, { economicOpportunity });

  if (economicOpportunity && !isMaterialEconomicDefinition(definition)) {
    definition = deterministicFallbackDefinition(signal, proposer, simulationTime, { economicOpportunity: true });
  }

  if (!economicOpportunity && similarProposalCount >= 1) {
    const generatedSignature = semanticDefinitionSignature(definition);
    const duplicateRows = await pool.query(
      "SELECT definition FROM emergent_world_proposals WHERE simulation_id=UUID_TO_BIN(?) AND scope_location_id=UUID_TO_BIN(?) AND status='ACCEPTED' AND created_simulation_at>=DATE_SUB(?,INTERVAL 7 DAY) ORDER BY created_simulation_at DESC LIMIT 30",
      [simulationId, scope.locationId, simulationTime]
    );
    const duplicate = duplicateRows[0].some(row => semanticDefinitionSignature(parseJson(row.definition, {})) === generatedSignature);
    if (duplicate) return null;
  }

  let validation = await validateDefinition(simulationId, definition, {
    scopeLocationId: scope.locationId,
    localResources: scope.attributes?.resources || {},
    proposerCount: actors.length
  });

  if (!validation.valid && generated) {
    definition = deterministicFallbackDefinition(signal, proposer, simulationTime, { economicOpportunity });
    validation = await validateDefinition(simulationId, definition, {
      scopeLocationId: scope.locationId,
      localResources: scope.attributes?.resources || {},
      proposerCount: actors.length
    });
  }

  if (!validation.valid) {
    logger.debug({
      simulationId,
      simulationTime,
      scopeLocationId: scope.locationId,
      errors: validation.errors
    }, "open-ended proposal rejected by deterministic validator");
    return null;
  }

  const support = supportScore(validation.definition, actors);
  const persisted = await persistProposal({
    simulationId,
    simulationTime,
    proposer,
    scope,
    definition: validation.definition,
    validation,
    support
  });

  const proposal = {
    ...persisted,
    definition: validation.definition,
    proposerEntityId: proposer.entityId,
    scopeLocationId: scope.locationId,
    supportScore: support.score,
    requiredSupport: support.required
  };

  if (proposal.status !== "ACCEPTED") {
    await createEvent({
      simulationId,
      eventTypeCode: "SOCIAL",
      title: validation.definition.name + " was proposed but did not form",
      description: "The proposal was feasible but insufficiently supported by nearby inhabitants.",
      simulationAt: simulationTime,
      importance: 0.42,
      metadata: {
        emergent: true,
        openEnded: true,
        kind: "DEFINITION_REJECTED",
        proposalId: persisted.id,
        definitionKind: validation.definition.kind,
        definitionCode: validation.definition.code,
        supportScore: support.score,
        requiredSupport: support.required
      }
    });
    return proposal;
  }

  const materialized = await materializeProposal(simulationId, simulationTime, proposal, scope, actors);
  return { ...proposal, materialized };
}
async function evolveEmergentSystems(simulationId, simulationTime) {
  const [systems] = await pool.query(
    "SELECT BIN_TO_UUID(id) id,system_type systemType,name,stage,attributes,created_simulation_at createdAt FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) AND stage<> 'ENDED' ORDER BY created_simulation_at ASC",
    [simulationId]
  );
  const now = new Date(simulationTime).getTime();
  let changed = 0;
  for (const system of systems) {
    const attrs = parseJson(system.attributes, {});
    const created = new Date(system.createdAt).getTime();
    const ageHours = Number.isFinite(created) && Number.isFinite(now) ? Math.max(0, (now-created)/3600000) : 0;
    const [memberRows] = await pool.query(
      "SELECT COUNT(*) count FROM emergent_system_members WHERE simulation_id=UUID_TO_BIN(?) AND system_id=UUID_TO_BIN(?)",
      [simulationId, system.id]
    );
    const members = Number(memberRows[0]?.count || 0);
    let hasActiveBusiness = false;
    if (attrs.systemEntityId) {
      const [businessRows] = await pool.query(
        "SELECT status FROM emergent_businesses WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1",
        [simulationId, attrs.systemEntityId]
      );
      hasActiveBusiness = businessRows[0]?.status === 'ACTIVE';
    }
    let next = String(system.stage || 'EMERGING').toUpperCase();
    if (next === 'EMERGING' && ageHours >= 12 && members >= 3) next = 'ACTIVE';
    else if (next === 'ACTIVE' && ageHours >= 72 && members >= 3) next = 'MATURE';
    else if (next === 'MATURE' && ageHours >= 168 && members < 2) next = 'DECLINING';
    else if (next === 'DECLINING' && members === 0 && !hasActiveBusiness) next = 'ENDED';
    if (next === String(system.stage || '').toUpperCase()) continue;
    await pool.query(
      "UPDATE emergent_systems SET stage=?,updated_simulation_at=?,version=version+1 WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND stage=?",
      [next, simulationTime, system.id, simulationId, system.stage]
    );
    await createEvent({
      simulationId,
      eventTypeCode: 'SOCIAL',
      title: system.name + ' is now ' + next.toLowerCase(),
      description: 'An emergent social system changed lifecycle stage after accumulating time, membership and observed conditions.',
      simulationAt: simulationTime,
      importance: next === 'ENDED' ? 0.72 : 0.61,
      metadata: { emergent:true, openEnded:true, kind:'SYSTEM_STAGE_CHANGED', systemId:system.id, systemType:system.systemType, from:system.stage, to:next, members, ageHours:Number(ageHours.toFixed(2)), hasActiveBusiness }
    });
    changed++;
  }
  return { changed };
}

async function evolveOpenEnded(simulationId, simulationTime, { gemini = null } = {}) {
  await ensureCatalog(simulationId, simulationTime);
  const systemLifecycle = await evolveEmergentSystems(simulationId, simulationTime);
  const [actors, locations] = await Promise.all([
    loadActors(simulationId),
    loadLocations(simulationId)
  ]);
  if (!actors.length || !locations.length) {
    return { skipped: true, reason: "NO_ACTORS_OR_LOCATIONS" };
  }

  const byLocation = new Map(locations.map(row => [String(row.locationId), row]));
  const local = new Map();

  for (const actor of actors) {
    if (!actor.locationId) continue;
    const key = String(actor.locationId);
    if (!local.has(key)) local.set(key, []);
    local.get(key).push(actor);
  }

  const proposals = [];
  for (const entry of local.entries()) {
    const locationId = entry[0];
    const localActors = entry[1];
    const scope = byLocation.get(locationId);
    if (!scope) continue;
    const result = await proposeForLocation(simulationId, simulationTime, scope, localActors, gemini);
    if (result) proposals.push(result);
  }

  const capabilities = await ensureCapabilitiesForEmergentStructures(simulationId, simulationTime);
  return { proposals, capabilities, systemLifecycle };
}

async function getOpenEndedSnapshot(simulationId) {
  const result = await Promise.all([
    pool.query(
      "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(scope_location_id) scopeLocationId," +
      "kind,code,title,rationale,definition,validation,support_score supportScore,required_support requiredSupport,status," +
      "created_simulation_at createdAt,decided_simulation_at decidedAt " +
      "FROM emergent_world_proposals WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 80",
      [simulationId]
    ),
    pool.query(
      "SELECT BIN_TO_UUID(id) id,kind,code,name,category,BIN_TO_UUID(scope_location_id) scopeLocationId," +
      "BIN_TO_UUID(origin_entity_id) originEntityId,definition,status,created_simulation_at createdAt " +
      "FROM emergent_definition_catalog WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 120",
      [simulationId]
    )
  ]);
  const proposals = result[0][0];
  const definitions = result[1][0];
  const decode = rows => rows.map(row => {
    for (const key of ["rationale", "definition", "validation"]) {
      if (row[key] !== undefined) row[key] = parseJson(row[key], row[key]);
    }
    return row;
  });
  return { proposals: decode(proposals), definitions: decode(definitions) };
}

module.exports = {
  evolveOpenEnded,
  getOpenEndedSnapshot,
  loadActors,
  loadLocations,
  topNeedSignal,
  deterministicFallbackDefinition,
  supportScore,
  semanticDefinitionSignature,
  isMaterialEconomicDefinition,
  evolveEmergentSystems,
  ProposalSchema
};