const { pool } = require("../db/pool");
const { STAGE_PROFILES, normalizeStageProfile } = require("./behavioral-policy-bootstrap");

let installed = false;

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
}

async function actionDurationScale(simulationId, entityId, simulationTime) {
  const [rows] = await pool.query(`
    SELECT p.birth_simulation_at AS birthSimulationAt,
           e.created_simulation_at AS createdSimulationAt
    FROM persons p
    JOIN entities e ON e.id=p.entity_id
    WHERE p.entity_id=UUID_TO_BIN(?) AND e.simulation_id=UUID_TO_BIN(?)
    LIMIT 1
  `, [entityId, simulationId]);
  if (!rows.length) return 1;

  const birthAt = rows[0].birthSimulationAt || rows[0].createdSimulationAt || simulationTime;
  const ageDays = Math.max(0, (new Date(simulationTime).getTime() - new Date(birthAt).getTime()) / 86400000);
  const [stages] = await pool.query(`
    SELECT code,configuration
    FROM development_stages
    WHERE active=1
      AND min_age_days<=?
      AND (max_age_days IS NULL OR max_age_days>?)
    ORDER BY min_age_days DESC
    LIMIT 1
  `, [ageDays, ageDays]);
  const profile = stages[0]
    ? normalizeStageProfile(stages[0].code, stages[0].configuration)
    : STAGE_PROFILES.ADULT;
  return Number.isFinite(Number(profile.actionDurationScale)) ? Number(profile.actionDurationScale) : 1;
}

function shouldScaleAction(actionType) {
  return !new Set(["WALKING", "EXPLORING"]).has(normalize(actionType));
}

function install() {
  if (installed) return;
  const actionService = require("./action-service");
  const originalStartAction = actionService.startAction;

  actionService.startAction = async function developmentalStartAction(args = {}) {
    const result = await originalStartAction(args);
    if (!result?.actionId || !shouldScaleAction(args.actionType)) return result;

    const scale = await actionDurationScale(args.simulationId, args.entityId, args.simulationTime);
    if (Math.abs(scale - 1) < 0.0001) return result;

    const [rows] = await pool.query(`
      SELECT parameters,result
      FROM actions
      WHERE id=UUID_TO_BIN(?)
      LIMIT 1
    `, [result.actionId]);
    if (!rows.length) return result;

    const parameters = parseJson(rows[0].parameters, {});
    const actionResult = parseJson(rows[0].result, {});
    const originalDuration = Number(result.durationMinutes || parameters.durationMinutes || 30);
    const scaledDuration = Math.max(5, originalDuration * scale);
    const expected = new Date(new Date(args.simulationTime).getTime() + scaledDuration * 60000).toISOString();

    parameters.durationMinutes = scaledDuration;
    parameters.expectedCompletionSimulationAt = expected;
    actionResult.durationMinutes = scaledDuration;
    actionResult.expectedCompletionSimulationAt = expected;
    actionResult.developmentDurationScale = scale;

    await pool.query(`
      UPDATE actions
      SET parameters=?,result=?
      WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'
    `, [JSON.stringify(parameters), JSON.stringify(actionResult), result.actionId]);

    return {
      ...result,
      durationMinutes: scaledDuration,
      expectedCompletionSimulationAt: new Date(new Date(args.simulationTime).getTime() + scaledDuration * 60000)
    };
  };

  installed = true;
}

module.exports = { install, actionDurationScale, shouldScaleAction };
