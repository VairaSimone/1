const { pool } = require("../db/pool");
const actionService = require("./action-service");

const MOVE_ACTIONS = new Set(["WALKING", "EXPLORING"]);
let installed = false;

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function loadLocations(simulationId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(e.id) AS locationId,
           e.attributes,
           l.location_type AS locationType,
           l.latitude,
           l.longitude,
           l.address_data AS addressData
    FROM locations l
    JOIN entities e ON e.id=l.entity_id AND e.simulation_id=l.simulation_id
    WHERE l.simulation_id=UUID_TO_BIN(?)
      AND e.status='ACTIVE'
  `, [simulationId]);
  return rows.map(row => ({
    locationId: row.locationId,
    locationType: row.locationType,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    data: parseJson(row.addressData, {})
  }));
}

async function getCurrentLocation(simulationId, entityId) {
  const [rows] = await pool.query(`
    SELECT BIN_TO_UUID(location_id) AS locationId
    FROM entity_locations_current
    WHERE simulation_id=UUID_TO_BIN(?)
      AND entity_id=UUID_TO_BIN(?)
    LIMIT 1
  `, [simulationId, entityId]);
  return rows[0]?.locationId || null;
}

async function resolveMovementTarget(args) {
  if (!MOVE_ACTIONS.has(String(args?.actionType || "").toUpperCase()) || !args?.targetLocationId) return null;
  const originId = await getCurrentLocation(args.simulationId, args.entityId);
  if (!originId || String(originId) === String(args.targetLocationId)) return null;
  const route = actionService.shortestRoute(await loadLocations(args.simulationId), originId, args.targetLocationId);
  if (!route?.path?.[1] || String(route.path[1]) === String(args.targetLocationId)) return null;
  return { nextHop: route.path[1], finalTarget: args.targetLocationId, routePath: route.path };
}

function install() {
  if (installed) return;
  const originalStartAction = actionService.startAction;
  if (typeof originalStartAction !== "function") throw new Error("action-service.startAction is unavailable");

  actionService.startAction = async function multiHopStartAction(args = {}) {
    const movement = await resolveMovementTarget(args);
    if (!movement) return originalStartAction(args);

    const result = await originalStartAction({ ...args, targetLocationId: movement.nextHop });
    if (result?.actionId) {
      await pool.query(`
        UPDATE actions
        SET parameters=JSON_SET(
          COALESCE(parameters, JSON_OBJECT()),
          '$.finalTargetLocationId', ?,
          '$.routePath', JSON_EXTRACT(?, '$')
        )
        WHERE id=UUID_TO_BIN(?)
      `, [movement.finalTarget, JSON.stringify(movement.routePath), result.actionId]);
    }
    return result;
  };

  installed = true;
}

module.exports = { install };