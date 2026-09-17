const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const SUCCESS_NEED_FEEDBACK = {
  DRINKING: { THIRST: 0.08 },
  EATING: { HUNGER: 0.05 },
  TALKING: { SOCIAL_NEED: 0.055, BELONGING: 0.045 },
  PLAYING: { FUN: 0.04 },
  READING: { CURIOSITY: 0.025 },
  EXPLORING: { CURIOSITY: 0.04 }
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

async function applyActionOutcomeNeedFeedback({ simulationId, entityId, actionId = null, actionType, simulationTime, outcome }) {
  if (String(outcome || "").toUpperCase() !== "SUCCESS") return [];
  const feedback = SUCCESS_NEED_FEEDBACK[String(actionType || "").toUpperCase()];
  if (!feedback) return [];

  const codes = Object.keys(feedback);
  const placeholders = codes.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT BIN_TO_UUID(enc.need_id) AS needId,nd.code,enc.value,enc.version
     FROM entity_needs_current enc
     JOIN need_definitions nd ON nd.id=enc.need_id
     WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1 AND nd.code IN (${placeholders})`,
    [entityId, ...codes]
  );

  const changes = [];
  for (const row of rows) {
    const relief = Math.max(0, Number(feedback[row.code]) || 0);
    if (!relief) continue;
    const oldValue = clamp(row.value);
    const nextValue = clamp(oldValue - relief);
    const delta = Number((nextValue - oldValue).toFixed(5));
    if (Math.abs(delta) < 0.000001) continue;

    const [updated] = await pool.query(
      `UPDATE entity_needs_current
       SET value=?,updated_simulation_at=?,version=version+1
       WHERE entity_id=UUID_TO_BIN(?) AND need_id=UUID_TO_BIN(?) AND version=?`,
      [nextValue, simulationTime, entityId, row.needId, row.version]
    );
    if (!updated.affectedRows) continue;

    await pool.query(
      `INSERT INTO entity_need_history
        (id,entity_id,need_id,old_value,new_value,delta,simulation_time,cause_event_id,cause_action_id)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,NULL,UUID_TO_BIN(?))`,
      [uuid(), entityId, row.needId, oldValue, nextValue, delta, simulationTime, actionId]
    );

    changes.push({ code: row.code, old: oldValue, new: nextValue, delta });
  }
  return changes;
}

module.exports = { applyActionOutcomeNeedFeedback, SUCCESS_NEED_FEEDBACK };
