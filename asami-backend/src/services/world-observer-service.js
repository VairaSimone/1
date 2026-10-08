const { pool } = require("../db/pool");
const { env } = require("../config/env");
const { WEATHER, WEATHER_DURATIONS_HOURS, BASE_BY_TYPE } = require("./environment-service");

const DEFAULT_EVENT_LIMIT = 12;
const MAX_ACTORS = 100;

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function simulationPhase(simulationTime, timeZone="Europe/Rome") {
  const date=simulationTime instanceof Date ? simulationTime : new Date(simulationTime);
  if(!Number.isFinite(date.getTime())) return { phase:"night", localHour:0, timeZone };
  const formatter=new Intl.DateTimeFormat("en-US",{timeZone,hour:"2-digit",hourCycle:"h23"});
  const localHour=Number(formatter.format(date));
  const phase=localHour<6||localHour>=21
    ? "night"
    : localHour<9
      ? "morning"
      : localHour<18
        ? "day"
        : "evening";
  return { phase, localHour, timeZone };
}

function replayWindowDays() {
  return Math.max(
    1,
    Math.min(
      Number(env.RETENTION_ACTION_DAYS) || 7,
      Number(env.RETENTION_EVENT_DAYS) || 7
    )
  );
}

function validateAndClampSimulationTime(requestedAt, simulation, minimumReplayMs=null) {
  const start = new Date(simulation.started_simulation_at).getTime();
  const current = new Date(simulation.current_simulation_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) {
    throw Object.assign(new Error("Simulation clock contains an invalid timestamp"), { code: "INVALID_SIMULATION_CLOCK", statusCode: 500 });
  }

  if (!requestedAt) return new Date(current);
  const parsed = new Date(requestedAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw Object.assign(new Error("Query parameter 'at' must be a valid ISO timestamp"), { code: "INVALID_WORLD_TIME", statusCode: 400 });
  }

  const replayFloor=Number.isFinite(Number(minimumReplayMs))
    ?Math.max(start,Math.min(current,Number(minimumReplayMs)))
    :start;
  const clamped = Math.max(replayFloor, Math.min(current, parsed.getTime()));
  return new Date(clamped);
}

function actorPosition(actor, locationsById, atMs) {
  const location = actor.locationId ? locationsById.get(String(actor.locationId)) : null;
  const movement = actor.movement;

  if (!movement) {
    return {
      locationId: location?.locationId || null,
      x: location?.longitude ?? null,
      y: location?.latitude ?? null,
      moving: false,
      movement: null
    };
  }

  const origin = locationsById.get(String(movement.originLocationId));
  const destination = locationsById.get(String(movement.destinationLocationId));
  if (!origin || !destination) {
    return {
      locationId: location?.locationId || movement.originLocationId || null,
      x: location?.longitude ?? null,
      y: location?.latitude ?? null,
      moving: true,
      movement: { ...movement, progress: 0, degraded: true }
    };
  }

  const startMs = new Date(movement.startedSimulationAt).getTime();
  const endMs = new Date(movement.arrivalSimulationAt).getTime();
  const durationMs = endMs - startMs;
  const progress = durationMs > 0 ? clamp((atMs - startMs) / durationMs) : 1;

  return {
    locationId: origin.locationId,
    x: Number(origin.longitude) + (Number(destination.longitude) - Number(origin.longitude)) * progress,
    y: Number(origin.latitude) + (Number(destination.latitude) - Number(origin.latitude)) * progress,
    moving: true,
    movement: {
      ...movement,
      progress: Number(progress.toFixed(4)),
      originName: origin.name,
      destinationName: destination.name
    }
  };
}

async function getWorldSnapshot(simulationId, requestedAt = null) {
  const [simulationRows] = await pool.query(
    `SELECT started_simulation_at,current_simulation_at,status,version
     FROM simulations
     WHERE id=UUID_TO_BIN(?)
     LIMIT 1`,
    [simulationId]
  );
  const simulation = simulationRows[0];
  if (!simulation) return null;

  const replayDays=replayWindowDays();
  const simulationStartMs=new Date(simulation.started_simulation_at).getTime();
  const simulationCurrentMs=new Date(simulation.current_simulation_at).getTime();
  const replayFloorMs=Math.max(simulationStartMs,simulationCurrentMs-replayDays*86400000);
  const requestedParsed=requestedAt?new Date(requestedAt).getTime():simulationCurrentMs;
  const at = validateAndClampSimulationTime(requestedAt, simulation, replayFloorMs);
  const atIso = at.toISOString();
  const replayClamped=Boolean(requestedAt && Number.isFinite(requestedParsed) && requestedParsed<replayFloorMs);
  const phaseState=simulationPhase(at);

  const [locationRows, actorRows, actionRows, movementRows, eventRows, goalRowsPromise, weatherRows] = await Promise.all([
    pool.query(
      `SELECT BIN_TO_UUID(e.id) AS locationId,
              e.display_name AS name,
              e.description,
              e.attributes,
              l.location_type AS locationType,
              l.latitude,
              l.longitude,
              l.address_data AS addressData
       FROM entities e
       JOIN locations l ON l.entity_id=e.id AND l.simulation_id=e.simulation_id
       WHERE e.simulation_id=UUID_TO_BIN(?)
         AND e.status='ACTIVE'
         AND e.created_simulation_at <= ?
         AND l.simulation_id=UUID_TO_BIN(?)
       ORDER BY e.created_simulation_at ASC`,
      [simulationId, atIso, simulationId]
    ),
    pool.query(
      `SELECT BIN_TO_UUID(e.id) AS id,
              e.display_name AS displayName,
              e.description,
              e.status,
              e.attributes,
              et.code AS entityType,
              (
                SELECT BIN_TO_UUID(h.location_id)
                FROM entity_location_history h
                WHERE h.simulation_id=e.simulation_id
                  AND h.entity_id=e.id
                  AND h.entered_simulation_at <= ?
                  AND (h.exited_simulation_at IS NULL OR h.exited_simulation_at > ?)
                ORDER BY h.entered_simulation_at DESC
                LIMIT 1
              ) AS locationId
       FROM entities e
       JOIN entity_types et ON et.id=e.entity_type_id
       WHERE e.simulation_id=UUID_TO_BIN(?)
         AND et.category='ACTOR'
         AND et.code='PERSON'
         AND e.status NOT IN ('INACTIVE','DEAD')
         AND e.display_name<>'Observer'
         AND e.created_simulation_at <= ?
       ORDER BY CASE WHEN LOWER(e.display_name)='asami' THEN 0 ELSE 1 END,
                e.created_simulation_at
       LIMIT ?`,
      [atIso, atIso, simulationId, atIso, MAX_ACTORS]
    ),
    pool.query(
      `SELECT BIN_TO_UUID(a.id) AS id,
              BIN_TO_UUID(a.entity_id) AS entityId,
              a.action_type AS actionType,
              a.status,
              a.started_simulation_at AS startedAt,
              a.completed_simulation_at AS completedAt,
              a.target,
              a.parameters,
              a.result
       FROM actions a
       WHERE a.simulation_id=UUID_TO_BIN(?)
         AND a.started_simulation_at <= ?
         AND (a.completed_simulation_at IS NULL OR a.completed_simulation_at > ?)
       ORDER BY a.started_simulation_at DESC`,
      [simulationId, atIso, atIso]
    ),
    pool.query(
      `SELECT BIN_TO_UUID(m.id) AS id,
              BIN_TO_UUID(m.entity_id) AS entityId,
              BIN_TO_UUID(m.origin_location_id) AS originLocationId,
              BIN_TO_UUID(m.destination_location_id) AS destinationLocationId,
              m.started_simulation_at AS startedSimulationAt,
              m.expected_arrival_simulation_at AS expectedArrivalSimulationAt,
              m.actual_arrival_simulation_at AS actualArrivalSimulationAt,
              m.status,
              m.reason
       FROM movements m
       WHERE m.simulation_id=UUID_TO_BIN(?)
         AND m.started_simulation_at <= ?
         AND COALESCE(m.actual_arrival_simulation_at,m.expected_arrival_simulation_at) > ?
       ORDER BY m.started_simulation_at DESC`,
      [simulationId, atIso, atIso]
    ),
    pool.query(
      `SELECT BIN_TO_UUID(e.id) AS id,
              et.code AS type,
              et.category,
              e.title,
              e.description,
              e.simulation_at AS simulationAt,
              e.importance,
              e.status,
              e.metadata
       FROM events e
       JOIN event_types et ON et.id=e.event_type_id
       WHERE e.simulation_id=UUID_TO_BIN(?)
         AND e.simulation_at <= ?
         AND e.status<>'CANCELLED'
       ORDER BY e.simulation_at DESC
       LIMIT ?`,
      [simulationId, atIso, DEFAULT_EVENT_LIMIT]
    ),
    pool.query(
      `SELECT BIN_TO_UUID(g.entity_id) AS entityId,
              BIN_TO_UUID(g.id) AS goalId,
              g.title AS goalTitle,
              g.goal_type AS goalType,
              g.priority,
              g.progress,
              g.status,
              BIN_TO_UUID(p.id) AS planId,
              ps.title AS stepTitle,
              ps.result AS stepResult
       FROM goals g
       LEFT JOIN plans p
         ON p.goal_id=g.id
        AND p.simulation_id=g.simulation_id
        AND p.entity_id=g.entity_id
        AND p.status IN ('ACTIVE','PAUSED','BLOCKED')
       LEFT JOIN plan_steps ps
         ON ps.plan_id=p.id
        AND ps.status IN ('ACTIVE','PENDING')
       WHERE g.simulation_id=UUID_TO_BIN(?)
         AND g.status IN ('ACTIVE','PAUSED','BLOCKED')
         AND g.created_simulation_at <= ?
       ORDER BY g.entity_id,
                CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END,
                g.priority DESC,g.created_simulation_at ASC,
                ps.sequence ASC`,
      [simulationId,atIso]
    ),    pool.query(
      `SELECT
          JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.locationId')) AS locationId,
          JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.eventCode')) AS eventCode,
          e.simulation_at AS simulationAt
       FROM events e
       WHERE e.simulation_id=UUID_TO_BIN(?)
         AND e.simulation_at <= ?
         AND e.status<>'CANCELLED'
         AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.environmental'))='true'
         AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.eventCode')) IN ('RAIN','STORM')
         AND JSON_EXTRACT(e.metadata,'$.locationId') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM events newer
           WHERE newer.simulation_id=e.simulation_id
             AND newer.status<>'CANCELLED'
             AND JSON_UNQUOTE(JSON_EXTRACT(newer.metadata,'$.environmental'))='true'
             AND JSON_UNQUOTE(JSON_EXTRACT(newer.metadata,'$.eventCode')) IN ('RAIN','STORM')
             AND JSON_UNQUOTE(JSON_EXTRACT(newer.metadata,'$.locationId'))=JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.locationId'))
             AND (
               newer.simulation_at > e.simulation_at
               OR (newer.simulation_at=e.simulation_at AND newer.real_created_at > e.real_created_at)
             )
         )
       ORDER BY e.simulation_at DESC`,
      [simulationId, atIso]
    )
  ]);

  const [locations] = locationRows;
  const [actors] = actorRows;
  const [goalRows] = goalRowsPromise;
  const [weatherEvents] = weatherRows;
  const [actions] = actionRows;
  const [movements] = movementRows;
  const [events] = eventRows;

  const locationsById = new Map();
  const locationsByCode = new Map();
  const latestWeatherByLocation = new Map();

  for (const row of weatherEvents) {
    const locationId = String(row.locationId || "");
    const eventCode = normalizeCode(row.eventCode);
    const simulationMs = new Date(row.simulationAt).getTime();
    if (!locationId || !WEATHER[eventCode] || !Number.isFinite(simulationMs)) continue;
    latestWeatherByLocation.set(locationId, { eventCode, simulationAt: simulationMs });
  }

  const replayHour = phaseState.localHour;
  const daylight = replayHour < 6 ? .08 : replayHour < 8 ? .35 : replayHour < 18 ? 1 : replayHour < 21 ? .45 : .12;
  const clampEnvironment = (value) => Math.max(0, Math.min(1, Number(value) || 0));

  for (const row of locations) {
    const attributes = parseJson(row.attributes, {});
    const addressData = parseJson(row.addressData, {});
    const code = normalizeCode(attributes.worldCode || addressData.worldCode || row.locationType);
    const currentEnvironment = attributes.environment && typeof attributes.environment === "object" ? attributes.environment : {};
    const weatherEvent = latestWeatherByLocation.get(String(row.locationId));
    const weatherAgeHours = weatherEvent ? Math.max(0, (at.getTime() - weatherEvent.simulationAt) / 3600000) : Infinity;
    const durationHours = weatherEvent ? WEATHER_DURATIONS_HOURS[weatherEvent.eventCode] : null;
    const weatherCode = weatherEvent && durationHours !== undefined && weatherAgeHours < durationHours ? weatherEvent.eventCode : "CLEAR";
    const weatherPreset = WEATHER[weatherCode] || WEATHER.CLEAR;
    const baseEnvironment = BASE_BY_TYPE[row.locationType] || BASE_BY_TYPE.SQUARE;
    const replayEnvironment = {
      ...currentEnvironment,
      weather: weatherCode,
      temperature: weatherPreset.temperature,
      humidity: weatherPreset.humidity,
      visibility: weatherPreset.visibility,
      noise: clampEnvironment(baseEnvironment.noise + (weatherCode === "RAIN" ? .08 : weatherCode === "STORM" ? .2 : 0)),
      activity: clampEnvironment(baseEnvironment.activity * (.45 + daylight * .55) - (replayHour < 6 || replayHour > 21 ? .12 : 0)),
      daylight,
      updatedAt: atIso,
      replaySource: "environmental-events"
    };

    const location = {
      locationId: row.locationId,
      code,
      name: row.name,
      description: row.description || null,
      locationType: row.locationType,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      addressData,
      objects: Array.isArray(attributes.objects) ? attributes.objects : [],
      resources: attributes.resources && typeof attributes.resources === "object" ? attributes.resources : {},
      environment: replayEnvironment,
      connections: Array.isArray(attributes.connections)
        ? attributes.connections.map((value) => String(value))
        : Array.isArray(addressData.connections) ? addressData.connections.map((value) => String(value)) : []
    };
    locationsById.set(String(location.locationId), location);
    if (code) locationsByCode.set(code, location);
  }

  for (const location of locationsById.values()) {
    location.connectionIds = location.connections
      .map((value) => locationsById.get(String(value)) || locationsByCode.get(normalizeCode(value)))
      .filter(Boolean)
      .map((target) => target.locationId);
    delete location.connections;
  }

  const actionByEntity = new Map();
  for (const row of actions) {
    if (!actionByEntity.has(String(row.entityId))) {
      actionByEntity.set(String(row.entityId), row);
    }
  }

  const movementByEntity = new Map();
  for (const row of movements) {
    if (!movementByEntity.has(String(row.entityId))) {
      const arrival = row.actualArrivalSimulationAt || row.expectedArrivalSimulationAt;
      movementByEntity.set(String(row.entityId), {
        id: row.id,
        originLocationId: row.originLocationId,
        destinationLocationId: row.destinationLocationId,
        startedSimulationAt: iso(row.startedSimulationAt),
        expectedArrivalSimulationAt: iso(row.expectedArrivalSimulationAt),
        actualArrivalSimulationAt: row.actualArrivalSimulationAt ? iso(row.actualArrivalSimulationAt) : null,
        arrivalSimulationAt: iso(arrival),
        status: row.status,
        reason: row.reason || null
      });
    }
  }

  const actorPayload = actors.map((row) => {
    const actionRow = actionByEntity.get(String(row.id));
    const movement = movementByEntity.get(String(row.id)) || null;
    const position = actorPosition(
      { locationId: row.locationId, movement },
      locationsById,
      at.getTime()
    );

    let targetLocationId = null;
    let targetEntityId = null;
    let actionParameters = parseJson(actionRow?.parameters, {});
    const goalRow = at.getTime() === simulationCurrentMs
      ? goalRows.find(candidate => String(candidate.entityId) === String(row.id)) || null
      : null;
    let actionTarget = parseJson(actionRow?.target, null);
    if (!actionTarget && actionRow?.target) actionTarget = actionRow.target;
    targetLocationId = actionParameters.targetLocationId || actionTarget?.locationId || null;
    targetEntityId = actionParameters.targetEntityId || null;

    return {
      id: row.id,
      displayName: row.displayName,
      description: row.description || null,
      status: row.status,
      entityType: row.entityType,
      isAsami: normalizeCode(row.displayName) === "ASAMI",
      locationId: position.locationId,
      latitude: position.y,
      longitude: position.x,
      moving: position.moving,
      movement: position.movement,
      goal: goalRow ? {
        goalId: goalRow.goalId,
        title: goalRow.goalTitle,
        goalType: goalRow.goalType,
        priority: Number(goalRow.priority || 0),
        progress: Number(goalRow.progress || 0),
        status: goalRow.status,
        planId: goalRow.planId || null,
        stepTitle: goalRow.stepTitle || null,
        stepActionType: parseJson(goalRow.stepResult, {})?.actionType || null
      } : null,
      action: actionRow ? {
        id: actionRow.id,
        actionType: actionRow.actionType,
        status: actionRow.status,
        startedAt: iso(actionRow.startedAt),
        completedAt: actionRow.completedAt ? iso(actionRow.completedAt) : null,
        targetLocationId,
        targetEntityId
      } : null
    };
  });

  const recentEvents = events.map((row) => {
    const metadata = parseJson(row.metadata, {});
    return {
      id: row.id,
      type: row.type,
      category: row.category,
      title: row.title,
      description: row.description || null,
      simulationAt: iso(row.simulationAt),
      importance: Number(row.importance || 0),
      status: row.status,
      locationId: metadata.locationId ? String(metadata.locationId) : null,
      eventCode: metadata.eventCode ? String(metadata.eventCode) : null,
      environmental: Boolean(metadata.environmental),
      metadata
    };
  });

  return {
    simulationAt: atIso,
    phase: phaseState.phase,
    localHour: phaseState.localHour,
    timeZone: phaseState.timeZone,
    requestedAt: requestedAt || null,
    isLive: at.getTime() === new Date(simulation.current_simulation_at).getTime(),
    simulation: {
      status: simulation.status,
      startedSimulationAt: iso(simulation.started_simulation_at),
      currentSimulationAt: iso(simulation.current_simulation_at),
      version: Number(simulation.version || 0)
    },
    locations: [...locationsById.values()],
    actors: actorPayload,
    recentEvents,
    meta: {
      locationCount: locationsById.size,
      actorCount: actorPayload.length,
      eventCount: recentEvents.length,
      replayWindowDays: replayDays,
      replayWindowStart: new Date(replayFloorMs).toISOString(),
      replayClamped,
      reconstructionWindow: "ACTION_EVENT_RETENTION"
    }
  };
}

module.exports = { getWorldSnapshot, replayWindowDays, simulationPhase };
