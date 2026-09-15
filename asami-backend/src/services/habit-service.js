const { pool } = require('../db/pool');
const { uuid } = require('../lib/ids');

function normalizeKey(value, max = 100) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, max);
}

async function recordHabitEvidence({ entityId, simulationTime, actionType }) {
  const action = normalizeKey(actionType);
  if (!action) return null;

  const [rows] = await pool.query(`
    SELECT started_simulation_at AS startedAt
    FROM actions
    WHERE entity_id=UUID_TO_BIN(?)
      AND action_type=?
      AND status='COMPLETED'
    ORDER BY started_simulation_at DESC
    LIMIT 12
  `, [entityId, action]);

  if (rows.length < 6) return null;

  const distinctDays = new Set(
    rows.map(r => new Date(r.startedAt).toISOString().slice(0, 10))
  ).size;
  if (distinctDays < 3) return null;

  const hours = rows.map(r => new Date(r.startedAt).getUTCHours());
  const meanHour = hours.reduce((sum, hour) => sum + hour, 0) / hours.length;
  const variance = hours.reduce((sum, hour) => sum + Math.pow(hour - meanHour, 2), 0) / hours.length;
  if (variance > 16) return null;

  const name = `${action.replaceAll('_', ' ').toLowerCase()} routine`;
  const frequency = `repeated ${rows.length} times across ${distinctDays} days`;
  const triggerDefinition = {
    type: 'TIME_WINDOW',
    hour: Math.round(meanHour) % 24,
    toleranceHours: 2
  };
  const actionDefinition = { actionType: action };

  const [existing] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id,strength,version
    FROM habits
    WHERE entity_id=UUID_TO_BIN(?)
      AND name=?
      AND status IN ('ACTIVE','WEAKENING')
    LIMIT 1
  `, [entityId, name]);

  if (!existing.length) {
    const id = uuid();
    await pool.query(`
      INSERT INTO habits
        (id,entity_id,name,description,strength,frequency,trigger_definition,action_definition,status,created_simulation_at,updated_simulation_at,version)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?, 'ACTIVE',?,?,1)
    `, [
      id,
      entityId,
      name,
      `A behavior that repeatedly appears around ${Math.round(meanHour)}:00.`,
      Math.min(0.75, 0.25 + rows.length * 0.04),
      frequency,
      JSON.stringify(triggerDefinition),
      JSON.stringify(actionDefinition),
      simulationTime,
      simulationTime
    ]);
    return id;
  }

  const habit = existing[0];
  const nextStrength = Math.min(1, Number(habit.strength) + 0.015);
  const [updated] = await pool.query(`
    UPDATE habits
    SET strength=?,frequency=?,trigger_definition=?,action_definition=?,updated_simulation_at=?,version=version+1
    WHERE id=UUID_TO_BIN(?) AND version=?
  `, [
    nextStrength,
    frequency,
    JSON.stringify(triggerDefinition),
    JSON.stringify(actionDefinition),
    simulationTime,
    habit.id,
    habit.version
  ]);

  return updated.affectedRows ? habit.id : null;
}

module.exports = { recordHabitEvidence };
