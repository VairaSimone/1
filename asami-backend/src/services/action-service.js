const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { createEvent, addEffect } = require("./event-service");
const { processSocialInteraction } = require("./social-relationship-service");
const { resolveActionResource } = require("./physical-world-service");
const { createMemory } = require("./memory-service");
const { upsertKnowledge } = require("./personality-service");

const ACTION_DURATIONS_MINUTES = {
  SLEEPING: 480,
  RESTING: 60,
  EATING: 30,
  DRINKING: 10,
  TALKING: 20,
  PLAYING: 60,
  STUDYING: 90,
  READING: 45,
  WORKING: 240,
  EXPLORING: 60,
  WALKING: 30,
  WATCHING: 45
};

const skillByAction = {
  READING: "READING",
  STUDYING: "WRITING",
  TALKING: "COMMUNICATION",
  EXPLORING: "NAVIGATION",
  PLAYING: "SPORTS",
  EATING: "COOKING",
  WALKING: "SELF_CARE"
};

const MOVE_ACTIONS = new Set(["WALKING", "EXPLORING"]);
const WALKING_SPEED_KMH = 4.8;
const EXPLORING_SPEED_KMH = 3.8;
const ROAD_FACTOR = 1.18;

function getActionDurationMinutes(actionType) {
  return ACTION_DURATIONS_MINUTES[actionType] || 30;
}

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function haversineMeters(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

  const rad = Math.PI / 180;
  const radius = 6371000;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

async function currentLocation(entityId, simulationId) {
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(location_id) AS locationId
     FROM entity_locations_current
     WHERE entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)`,
    [entityId, simulationId]
  );
  return rows[0]?.locationId || null;
}

async function loadLocationGraph(simulationId) {
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(e.id) AS locationId,
            address_data AS addressData,
            latitude,
            longitude,
            location_type AS locationType
     FROM locations l
     JOIN entities e ON e.id=l.entity_id
     WHERE l.simulation_id=UUID_TO_BIN(?)
       AND e.simulation_id=UUID_TO_BIN(?)
       AND e.status='ACTIVE'`,
    [simulationId, simulationId]
  );

  return rows.map(row => ({
    locationId: row.locationId,
    data: parseJson(row.addressData),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    locationType: row.locationType
  }));
}

function shortestRoute(locations, originId, targetId) {
  if (!originId) return null;

  const byId = new Map(locations.map(location => [location.locationId, location]));
  const byCode = new Map(locations.map(location => [location.data?.worldCode, location]));
  const origin = byId.get(originId);
  if (!origin) return null;
  if (!targetId || targetId === originId) return { path: [originId], distanceMeters: 0 };
  if (!byId.has(targetId)) return null;

  const distances = new Map();
  const previous = new Map();
  const unvisited = new Set(locations.map(location => location.locationId));

  for (const id of unvisited) distances.set(id, Infinity);
  distances.set(originId, 0);

  while (unvisited.size) {
    let currentId = null;
    let currentDistance = Infinity;

    for (const id of unvisited) {
      const distance = distances.get(id);
      if (distance < currentDistance) {
        currentDistance = distance;
        currentId = id;
      }
    }

    if (currentId === null || currentDistance === Infinity) break;
    unvisited.delete(currentId);
    if (currentId === targetId) break;

    const current = byId.get(currentId);
    for (const code of Array.isArray(current?.data?.connections) ? current.data.connections : []) {
      const next = byCode.get(code);
      if (!next || !unvisited.has(next.locationId)) continue;
      const rawEdge = haversineMeters(current, next);
      if (!Number.isFinite(rawEdge)) continue;
      const edge = Math.max(5, rawEdge * ROAD_FACTOR);
      const candidate = currentDistance + edge;
      if (candidate < distances.get(next.locationId)) {
        distances.set(next.locationId, candidate);
        previous.set(next.locationId, currentId);
      }
    }
  }

  if (!Number.isFinite(distances.get(targetId))) return null;

  const path = [];
  let cursor = targetId;
  while (cursor) {
    path.unshift(cursor);
    if (cursor === originId) break;
    cursor = previous.get(cursor);
  }

  return path[0] === originId
    ? { path, distanceMeters: distances.get(targetId) }
    : null;
}

function nextHop(locations, originId, targetId = null) {
  if (targetId) return shortestRoute(locations, originId, targetId)?.path[1] || null;
  const byId = new Map(locations.map(location => [location.locationId, location]));
  const byCode = new Map(locations.map(location => [location.data?.worldCode, location]));
  const origin = byId.get(originId);
  if (!origin) return null;
  for (const code of Array.isArray(origin.data?.connections) ? origin.data.connections : []) {
    const next = byCode.get(code);
    if (next && next.locationId !== originId) return next.locationId;
  }
  return null;
}

async function chooseDestination(simulationId, entityId, originId, targetId = null) {
  if (!originId) return null;
  return nextHop(await loadLocationGraph(simulationId), originId, targetId);
}

async function routeDetails(simulationId, originId, targetId) {
  return shortestRoute(await loadLocationGraph(simulationId), originId, targetId);
}

async function getActiveRelationshipType(simulationId, sourceEntityId, targetEntityId) {
  const [rows] = await pool.query(
    `SELECT rt.code AS type
     FROM relationships r
     JOIN relationship_types rt ON rt.id=r.relationship_type_id
     WHERE r.simulation_id=UUID_TO_BIN(?)
       AND r.status='ACTIVE'
       AND ((r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?))
         OR (r.source_entity_id=UUID_TO_BIN(?) AND r.target_entity_id=UUID_TO_BIN(?)))
     ORDER BY CASE rt.code WHEN 'PARTNER' THEN 3 WHEN 'FRIEND' THEN 2 WHEN 'ACQUAINTANCE' THEN 1 ELSE 0 END DESC
     LIMIT 1`,
    [simulationId, sourceEntityId, targetEntityId, targetEntityId, sourceEntityId]
  );
  return rows[0]?.type || "ACQUAINTANCE";
}

async function getActiveAction(entityId, simulationId) {
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,
            action_type AS actionType,
            started_simulation_at AS startedSimulationAt,
            completed_simulation_at AS completedSimulationAt,
            BIN_TO_UUID(decision_id) AS decisionId,
            BIN_TO_UUID(source_intention_id) AS intentionId,
            target,
            parameters,
            result,
            version
     FROM actions
     WHERE entity_id=UUID_TO_BIN(?)
       AND simulation_id=UUID_TO_BIN(?)
       AND status='ACTIVE'
     ORDER BY started_simulation_at DESC
     LIMIT 1`,
    [entityId, simulationId]
  );

  const action = rows[0] || null;
  if (!action) return null;

  for (const key of ["parameters", "result"]) {
    if (Buffer.isBuffer(action[key])) action[key] = action[key].toString();
    if (typeof action[key] === "string") action[key] = parseJson(action[key], {});
  }

  if (Buffer.isBuffer(action.target)) action.target = action.target.toString();
  action.metadata = { ...(action.parameters || {}), ...(action.result || {}) };
  return action;
}

async function startMovement({
  simulationId,
  entityId,
  origin,
  destination,
  simulationTime,
  distanceMeters,
  speedKmh
}) {
  const [existing] = await pool.query(
    `SELECT id
     FROM movements
     WHERE simulation_id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND status IN ('PLANNED','ACTIVE')
     LIMIT 1`,
    [simulationId, entityId]
  );
  if (existing.length) return null;

  const safeDistance = Math.max(5, Number(distanceMeters) || 5);
  const safeSpeed = Math.max(1, Number(speedKmh) || WALKING_SPEED_KMH);
  const durationMinutes = Math.max(2, (safeDistance / 1000 / safeSpeed) * 60);
  const expectedArrival = new Date(
    new Date(simulationTime).getTime() + durationMinutes * 60000
  );
  const movementId = uuid();

  await pool.query(
    `INSERT INTO movements
      (id,simulation_id,entity_id,origin_location_id,destination_location_id,
       started_simulation_at,expected_arrival_simulation_at,status,reason,source_activity_id,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'ACTIVE','autonomous route',NULL,1)`,
    [movementId, simulationId, entityId, origin, destination, simulationTime, expectedArrival]
  );

  return {
    movementId,
    durationMinutes,
    expectedArrival,
    distanceMeters: safeDistance,
    speedKmh: safeSpeed
  };
}

async function completeMovement({ simulationId, entityId, destination, simulationTime }) {
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(id) AS id,
            BIN_TO_UUID(origin_location_id) AS originLocationId,
            version
     FROM movements
     WHERE simulation_id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND destination_location_id=UUID_TO_BIN(?)
       AND status='ACTIVE'
     ORDER BY started_simulation_at DESC
     LIMIT 1`,
    [simulationId, entityId, destination]
  );
  if (!rows.length) return false;

  const movement = rows[0];
  const [updated] = await pool.query(
    `UPDATE movements
     SET status='COMPLETED',actual_arrival_simulation_at=?,version=version+1
     WHERE id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?`,
    [simulationTime, movement.id, movement.version]
  );
  if (!updated.affectedRows) return false;

  await pool.query(
    `INSERT INTO entity_location_history
      (id,simulation_id,entity_id,location_id,entered_simulation_at,reason,source_event_id)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',NULL)`,
    [uuid(), simulationId, entityId, destination, simulationTime]
  );

  if (movement.originLocationId) {
    await pool.query(
      `UPDATE entity_location_history
       SET exited_simulation_at=?
       WHERE simulation_id=UUID_TO_BIN(?)
         AND entity_id=UUID_TO_BIN(?)
         AND location_id=UUID_TO_BIN(?)
         AND exited_simulation_at IS NULL
         AND entered_simulation_at<?`,
      [simulationTime, simulationId, entityId, movement.originLocationId, simulationTime]
    );
  }

  await pool.query(
    `INSERT INTO entity_locations_current
      (entity_id,simulation_id,location_id,since_simulation_at,reason,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',1)
     ON DUPLICATE KEY UPDATE
       location_id=VALUES(location_id),
       since_simulation_at=VALUES(since_simulation_at),
       reason=VALUES(reason),
       version=version+1`,
    [entityId, simulationId, destination, simulationTime]
  );

  return true;
}

async function startAction({
  simulationId,
  entityId,
  decisionId,
  intentionId = null,
  actionType,
  simulationTime,
  targetEntityId = null,
  targetLocationId = null,
  relationshipIntent = "NONE"
}) {
  let duration = getActionDurationMinutes(actionType);
  let move = null;
  let origin = null;
  let destination = null;

  if (MOVE_ACTIONS.has(actionType)) {
    origin = await currentLocation(entityId, simulationId);
    if (origin) {
      const route = targetLocationId
        ? await routeDetails(simulationId, origin, targetLocationId)
        : {
            path: [origin, await chooseDestination(simulationId, entityId, origin, null)],
            distanceMeters: 0
          };

      if (route?.path?.[1]) {
        destination = targetLocationId || route.path[1];

        if (!targetLocationId) {
          const locations = await loadLocationGraph(simulationId);
          const byId = new Map(locations.map(location => [location.locationId, location]));
          route.distanceMeters = Math.max(
            5,
            haversineMeters(byId.get(origin), byId.get(destination)) * ROAD_FACTOR
          );
        }

        if (!Number.isFinite(Number(route.distanceMeters))) {
          throw Object.assign(new Error("Movement route has invalid coordinates"), { code: "INVALID_MOVEMENT_ROUTE" });
        }

        const speed = actionType === "EXPLORING"
          ? EXPLORING_SPEED_KMH
          : WALKING_SPEED_KMH;
        move = await startMovement({
          simulationId,
          entityId,
          origin,
          destination,
          simulationTime,
          distanceMeters: route.distanceMeters,
          speedKmh: speed
        });
        if (move) duration = move.durationMinutes;
      }
    }
  }

  const actionId = uuid();
  const expectedCompletion = new Date(
    new Date(simulationTime).getTime() + duration * 60000
  );

  await pool.query(
    `INSERT INTO actions
      (id,simulation_id,entity_id,decision_id,action_type,source_type,source_intention_id,
       started_simulation_at,status,target,parameters,version)
     VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'AUTONOMOUS',UUID_TO_BIN(?),?,'ACTIVE',?,?,1)`,
    [
      actionId,
      simulationId,
      entityId,
      decisionId,
      actionType,
      intentionId,
      simulationTime,
      targetLocationId ? JSON.stringify({ locationId: targetLocationId }) : null,
      JSON.stringify({
        targetEntityId,
        targetLocationId,
        relationshipIntent,
        durationMinutes: duration,
        expectedCompletionSimulationAt: expectedCompletion.toISOString(),
        movement: move
          ? {
              movementId: move.movementId,
              originLocationId: origin,
              destinationLocationId: destination,
              distanceMeters: move.distanceMeters,
              speedKmh: move.speedKmh,
              expectedArrivalSimulationAt: move.expectedArrival.toISOString()
            }
          : null
      })
    ]
  );

  const eventCode = actionType === "TALKING" ? "SOCIAL" : "PERSONAL";
  const eventId = await createEvent({
    simulationId,
    eventTypeCode: eventCode,
    title: `Asami ${actionType.toLowerCase().replaceAll("_", " ")}`,
    description: `Autonomous action started: ${actionType}`,
    simulationAt: simulationTime,
    importance: 0.45,
    sourceActionId: actionId,
    participants: [{ entityId, role: "ACTOR" }],
    metadata: {
      actionType,
      targetEntityId,
      targetLocationId,
      relationshipIntent,
      durationMinutes: duration,
      status: "ACTIVE",
      movement: move
        ? {
            origin,
            destination,
            distanceMeters: move.distanceMeters,
            expectedArrival: move.expectedArrival.toISOString()
          }
        : null
    }
  });

  const initialResult = {
    eventId,
    actionType,
    durationMinutes: duration,
    targetEntityId,
    targetLocationId,
    relationshipIntent,
    movement: move
      ? {
          movementId: move.movementId,
          originLocationId: origin,
          destinationLocationId: destination,
          distanceMeters: move.distanceMeters,
          speedKmh: move.speedKmh,
          expectedArrivalSimulationAt: move.expectedArrival.toISOString()
        }
      : null
  };

  await pool.query(
    `UPDATE actions SET result=? WHERE id=UUID_TO_BIN(?)`,
    [JSON.stringify(initialResult), actionId]
  );

  return {
    actionId,
    eventId,
    actionType,
    durationMinutes: duration,
    relationshipIntent,
    expectedCompletionSimulationAt: expectedCompletion,
    movement: move
      ? {
          movementId: move.movementId,
          originLocationId: origin,
          destinationLocationId: destination,
          distanceMeters: move.distanceMeters,
          speedKmh: move.speedKmh,
          expectedArrivalSimulationAt: move.expectedArrival.toISOString()
        }
      : null
  };
}

async function ensureEventId({
  simulationId,
  entityId,
  actionId,
  eventId,
  actionType,
  simulationTime,
  targetEntityId = null,
  targetLocationId = null,
  relationshipIntent = "NONE"
}) {
  if (eventId) return eventId;
  return createEvent({
    simulationId,
    eventTypeCode: actionType === "TALKING" ? "SOCIAL" : "PERSONAL",
    title: `Asami ${String(actionType || "ACTION").toLowerCase().replaceAll("_", " ")}`,
    description: `Recovered autonomous action: ${actionType || "ACTION"}`,
    simulationAt: simulationTime,
    importance: 0.35,
    sourceActionId: actionId,
    participants: [{ entityId, role: "ACTOR" }],
    metadata: {
      actionType,
      targetEntityId,
      targetLocationId,
      relationshipIntent,
      recovered: true,
      status: "ACTIVE"
    }
  });
}

function classifyPhysicalOutcome(physical) {
  if (!physical || typeof physical !== "object" || !Object.prototype.hasOwnProperty.call(physical, "ok")) {
    return { outcome: "SUCCESS", success: true, failureReason: null };
  }

  if (physical.ok) {
    return { outcome: "SUCCESS", success: true, failureReason: null };
  }

  const consumed = Number(physical.consumed || 0);
  return {
    outcome: consumed > 0 ? "PARTIAL" : "FAILURE",
    success: false,
    failureReason: consumed > 0 ? "RESOURCE_PARTIALLY_AVAILABLE" : "RESOURCE_UNAVAILABLE"
  };
}

async function recordResourceFailureKnowledge({
  simulationId,
  entityId,
  locationId,
  simulationTime,
  physical
}) {
  if (!locationId || !physical?.resource || physical.ok) return null;

  const resource = String(physical.resource).trim().toLowerCase();
  const remaining = Number(physical.remaining);
  if (!resource || !Number.isFinite(remaining) || remaining > 0) return null;

  const knowledgePayload = {
    type: "RESOURCE_UNAVAILABLE",
    resource,
    locationId,
    simulationAt: simulationTime
  };

  const knowledgeId = await upsertKnowledge({
    simulationId,
    entityId,
    simulationTime,
    item: {
      knowledgeType: "WORLD_EXPERIENCE",
      content: JSON.stringify(knowledgePayload),
      subjectEntityId: entityId,
      objectEntityId: locationId,
      predicate: "RESOURCE_UNAVAILABLE",
      confidence: 0.98,
      importance: 0.85
    }
  });

  await createMemory({
    simulationId,
    entityId,
    eventId: null,
    locationId,
    type: "EPISODIC",
    content: `I tried to ${String(physical.actionType || "perform an action").toLowerCase()} here, but ${resource} was unavailable. I should consider another location or strategy next time.`,
    importance: 0.82,
    strength: 0.98,
    confidence: 0.98,
    emotionalIntensity: 0.35,
    simulationAt: simulationTime,
    metadata: {
      kind: "resource_failure",
      resource,
      locationId,
      remaining,
      learning: "RESOURCE_UNAVAILABLE"
    }
  });

  return { knowledgeId, resource, locationId, type: "RESOURCE_UNAVAILABLE" };
}

async function completeAction({
  simulationId,
  entityId,
  actionId,
  decisionId = null,
  eventId,
  intentionId = null,
  actionType,
  simulationTime,
  targetEntityId = null,
  targetLocationId = null,
  relationshipIntent = "NONE"
}) {
  const [activeRows] = await pool.query(
    `SELECT status,result,version
     FROM actions
     WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?)
     LIMIT 1`,
    [actionId, entityId, simulationId]
  );
  if (!activeRows.length) return { completed: false, outcome: "FAILURE", success: false, failureReason: "ACTION_NOT_FOUND" };
  if (activeRows[0].status === "COMPLETED") {
    const stored = parseJson(activeRows[0].result, {}) || {};
    return {
      completed: true,
      outcome: stored.outcome || "SUCCESS",
      success: stored.success !== false,
      failureReason: stored.failureReason || null,
      resource: stored.resource || null,
      resourceLearning: stored.resourceLearning || null,
      eventId: stored.eventId || eventId
    };
  }

  eventId = await ensureEventId({
    simulationId,
    entityId,
    actionId,
    eventId,
    actionType,
    simulationTime,
    targetEntityId,
    targetLocationId,
    relationshipIntent
  });

  const storedBefore = parseJson(activeRows[0].result, {}) || {};
  let physical;
  if (storedBefore.resourceFinalized) {
    physical = storedBefore.resource || { ok: true, consumed: 0, remaining: null, resource: null };
  } else {
    const physicalLocation = await currentLocation(entityId, simulationId);
    physical = await resolveActionResource({
      simulationId,
      locationId: physicalLocation,
      actionType,
      simulationTime
    });
    physical.actionType = actionType;

    const finalizedResult = { ...storedBefore, resourceFinalized: true, resource: physical };
    const [claimed] = await pool.query(
      `UPDATE actions SET result=?,version=version+1
       WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE' AND version=?`,
      [JSON.stringify(finalizedResult), actionId, entityId, simulationId, activeRows[0].version]
    );
    if (!claimed.affectedRows) {
      const [reloaded] = await pool.query(`SELECT status,result FROM actions WHERE id=UUID_TO_BIN(?) LIMIT 1`, [actionId]);
      const recovered = parseJson(reloaded[0]?.result, {}) || {};
      if (reloaded[0]?.status === "COMPLETED") {
        return {
          completed: true,
          outcome: recovered.outcome || "SUCCESS",
          success: recovered.success !== false,
          failureReason: recovered.failureReason || null,
          resource: recovered.resource || null,
          resourceLearning: recovered.resourceLearning || null,
          eventId: recovered.eventId || eventId
        };
      }
      if (!recovered.resourceFinalized) throw Object.assign(new Error("Concurrent action finalization conflict"), { code: "OPTIMISTIC_LOCK" });
      physical = recovered.resource || physical;
    }
  }

  const physicalLocation = await currentLocation(entityId, simulationId);
  const outcome = classifyPhysicalOutcome(physical);
  const learning = await recordResourceFailureKnowledge({
    simulationId,
    entityId,
    locationId: physicalLocation,
    simulationTime,
    physical
  });

  const result = {
    eventId,
    actionType,
    outcome: outcome.outcome,
    success: outcome.success,
    failureReason: outcome.failureReason,
    resource: physical,
    targetEntityId,
    targetLocationId,
    relationshipIntent,
    resourceLearning: learning,
    resourceFinalized: true
  };

  const [updated] = await pool.query(
    `UPDATE actions
     SET status='COMPLETED',completed_simulation_at=?,result=?,version=version+1
     WHERE id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND simulation_id=UUID_TO_BIN(?)
       AND status='ACTIVE'`,
    [simulationTime, JSON.stringify(result), actionId, entityId, simulationId]
  );
  if (!updated.affectedRows) {
    const [reloaded] = await pool.query(`SELECT status,result FROM actions WHERE id=UUID_TO_BIN(?) LIMIT 1`, [actionId]);
    const recovered = parseJson(reloaded[0]?.result, {}) || {};
    if (reloaded[0]?.status === "COMPLETED") return { completed: true, outcome: recovered.outcome || outcome.outcome, success: recovered.success !== false, failureReason: recovered.failureReason || outcome.failureReason, resource: recovered.resource || physical, resourceLearning: recovered.resourceLearning || learning, eventId: recovered.eventId || eventId };
    return { completed: false, outcome: "FAILURE", success: false, failureReason: "ACTION_STATE_CONFLICT" };
  }

  await addEffect({
    simulationId,
    eventId,
    effectType: "ACTION_COMPLETED",
    targetActionId: actionId,
    targetEntityId: entityId,
    afterState: {
      actionType,
      status: "COMPLETED",
      outcome: outcome.outcome,
      physicalResource: physical
    },
    magnitude: outcome.success ? 1 : 0,
    createdSimulationAt: simulationTime
  });

  if (MOVE_ACTIONS.has(actionType)) {
    const [rows] = await pool.query(
      `SELECT BIN_TO_UUID(destination_location_id) AS destination
       FROM movements
       WHERE simulation_id=UUID_TO_BIN(?)
         AND entity_id=UUID_TO_BIN(?)
         AND status='ACTIVE'
       ORDER BY started_simulation_at DESC
       LIMIT 1`,
      [simulationId, entityId]
    );
    const destination = rows[0]?.destination;
    if (destination) await completeMovement({ simulationId, entityId, destination, simulationTime });
  }

  if (actionType === "TALKING" && targetEntityId) {
    await processSocialInteraction({
      simulationId,
      sourceEntityId: entityId,
      targetEntityId,
      simulationAt: simulationTime,
      eventId,
      relationshipIntent,
      locationId: await currentLocation(entityId, simulationId)
    });
  }

  if (intentionId) {
    await pool.query(
      `UPDATE intentions
       SET status='COMPLETED',version=version+1
       WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
      [intentionId]
    );
  }

  if (decisionId) {
    await pool.query(
      `UPDATE decisions
       SET status='EXECUTED',actual_outcome=?
       WHERE id=UUID_TO_BIN(?) AND status IN ('EVALUATED','CREATED')`,
      [
        JSON.stringify({
          actionId,
          eventId,
          outcome: outcome.outcome,
          success: outcome.success,
          failureReason: outcome.failureReason,
          physicalResource: physical,
          relationshipIntent
        }),
        decisionId
      ]
    );
  }

  return {
    completed: true,
    outcome: outcome.outcome,
    success: outcome.success,
    failureReason: outcome.failureReason,
    resource: physical,
    resourceLearning: learning
  };
}

async function executeAction(args) {
  const started = await startAction(args);
  const completed = await completeAction({
    ...args,
    actionId: started.actionId,
    eventId: started.eventId,
    decisionId: args.decisionId
  });
  return {
    actionId: started.actionId,
    eventId: started.eventId,
    outcome: completed?.outcome || "SUCCESS"
  };
}

async function learnFromAction(entityId, actionType, simulationTime) {
  const skill = skillByAction[actionType];
  if (!skill) return;

  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(es.skill_id) AS skillId,
            es.proficiency,
            es.confidence,
            es.version
     FROM entity_skills es
     JOIN skill_definitions sd ON sd.id=es.skill_id
     WHERE es.entity_id=UUID_TO_BIN(?) AND sd.code=?
     LIMIT 1`,
    [entityId, skill]
  );
  if (!rows.length) return;

  const current = rows[0];
  const next = Math.min(1, Number(current.proficiency) + 0.004);
  const confidence = Math.min(1, Number(current.confidence) + 0.003);

  await pool.query(
    `UPDATE entity_skills
     SET proficiency=?,confidence=?,last_used_simulation_at=?,updated_simulation_at=?,version=version+1
     WHERE entity_id=UUID_TO_BIN(?)
       AND skill_id=UUID_TO_BIN(?)
       AND version=?`,
    [next, confidence, simulationTime, simulationTime, entityId, current.skillId, current.version]
  );
}

module.exports = {
  startAction,
  completeAction,
  executeAction,
  getActiveAction,
  learnFromAction,
  getActionDurationMinutes,
  currentLocation,
  chooseDestination,
  nextHop,
  routeDetails,
  haversineMeters,
  shortestRoute,
  startMovement,
  completeMovement,
  classifyPhysicalOutcome,
  recordResourceFailureKnowledge
};
