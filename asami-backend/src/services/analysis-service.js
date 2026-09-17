const { pool } = require("../db/pool");

function rangeWhere(alias, from, to, field) {
  const params = [];
  let where = "";
  if (from) { where += ` AND ${alias}.${field} >= ?`; params.push(from); }
  if (to) { where += ` AND ${alias}.${field} <= ?`; params.push(to); }
  return { where, params };
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rate(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

async function analyzeSimulation(simulationId, { from, to } = {}) {
  const [simRows] = await pool.query(`
    SELECT started_simulation_at AS startedAt,current_simulation_at AS currentAt
    FROM simulations WHERE id=UUID_TO_BIN(?) LIMIT 1
  `, [simulationId]);
  if (!simRows.length) throw Object.assign(new Error("Simulation not found"), { code: "NOT_FOUND", statusCode: 404 });

  const actualFrom = from || simRows[0].startedAt;
  const actualTo = to || simRows[0].currentAt;
  const bounds = { from: actualFrom, to: actualTo };

  const tickRange = rangeWhere("t", actualFrom, actualTo, "simulation_time");
  const actionRange = rangeWhere("a", actualFrom, actualTo, "started_simulation_at");
  const eventRange = rangeWhere("e", actualFrom, actualTo, "simulation_at");
  const decisionRange = rangeWhere("d", actualFrom, actualTo, "simulation_time");
  const memoryRange = rangeWhere("m", actualFrom, actualTo, "created_simulation_at");

  const [
    [ticks], [actions], [events], [decisions], [memories],
    [actionBreakdown], [eventBreakdown], [decisionBreakdown], [seriesRows],
    [temporalRows], [invalidRows], [durationRows], [memoryFailureRows], [causeRows]
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*) total,
      SUM(status='COMPLETED') completed,
      SUM(status='FAILED') failed,
      SUM(status='SKIPPED') skipped
      FROM simulation_ticks t WHERE t.simulation_id=UUID_TO_BIN(?)${tickRange.where}`, [simulationId, ...tickRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(status='COMPLETED') completed,
      SUM(status IN ('FAILED','CANCELLED','ERROR')) failed,
      AVG(CASE WHEN completed_simulation_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,started_simulation_at,completed_simulation_at) END) avgDurationSeconds,
      SUM(completed_simulation_at IS NOT NULL AND (completed_simulation_at < started_simulation_at OR TIMESTAMPDIFF(HOUR,started_simulation_at,completed_simulation_at) > 72)) suspiciousDuration
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}`, [simulationId, ...actionRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(COALESCE(importance,0) >= 0.7) important,
      AVG(importance) avgImportance,
      MAX(importance) maxImportance
      FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}`, [simulationId, ...eventRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(UPPER(COALESCE(status,'')) IN ('FAILED','ERROR','REJECTED')) failed
      FROM decisions d WHERE d.simulation_id=UUID_TO_BIN(?)${decisionRange.where}`, [simulationId, ...decisionRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome')),''))='failure') failures
      FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?)${memoryRange.where}`, [simulationId, ...memoryRange.params]),
    pool.query(`SELECT action_type label,COUNT(*) value FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where} GROUP BY action_type ORDER BY value DESC LIMIT 8`, [simulationId, ...actionRange.params]),
    pool.query(`SELECT et.code label,COUNT(*) value FROM events e JOIN event_types et ON et.id=e.event_type_id WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where} GROUP BY et.code ORDER BY value DESC LIMIT 8`, [simulationId, ...eventRange.params]),
    pool.query(`SELECT COALESCE(status,'UNKNOWN') label,COUNT(*) value FROM decisions d WHERE d.simulation_id=UUID_TO_BIN(?)${decisionRange.where} GROUP BY status ORDER BY value DESC LIMIT 8`, [simulationId, ...decisionRange.params]),
    pool.query(`SELECT bucket at,
      SUM(kind='EVENT') events,
      SUM(kind='ACTION') actions,
      0 failedTicks
      FROM (
        SELECT DATE_FORMAT(e.simulation_at,'%Y-%m-%d %H:00:00') bucket,'EVENT' kind FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}
        UNION ALL
        SELECT DATE_FORMAT(a.started_simulation_at,'%Y-%m-%d %H:00:00') bucket,'ACTION' kind FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}
      ) x GROUP BY bucket ORDER BY bucket`, [simulationId, ...eventRange.params, simulationId, ...actionRange.params]),
    pool.query(`SELECT
      SUM(completed_simulation_at IS NOT NULL AND completed_simulation_at < started_simulation_at) negativeDuration,
      SUM(started_simulation_at IS NOT NULL AND started_simulation_at < '${actualFrom}') outsideStart
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}`, [simulationId, ...actionRange.params]),
    pool.query(`SELECT
      SUM(COALESCE(importance,-1) < 0 OR COALESCE(importance,2) > 1) invalidEventImportance,
      SUM(simulation_at < '${actualFrom}' OR simulation_at > '${actualTo}') outsideEvents
      FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)`, [simulationId]),
    pool.query(`SELECT COUNT(*) suspicious FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}
      AND a.completed_simulation_at IS NOT NULL
      AND (a.completed_simulation_at < a.started_simulation_at OR TIMESTAMPDIFF(HOUR,a.started_simulation_at,a.completed_simulation_at) > 72)`, [simulationId, ...actionRange.params]),
    pool.query(`SELECT COUNT(*) failures FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?)${memoryRange.where}
      AND (LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'')) IN ('resource_failure','action_failure')
           OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.outcome')),''))='failure')`, [simulationId, ...memoryRange.params]),
    pool.query(`SELECT COUNT(*) withCause FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}
      AND EXISTS (SELECT 1 FROM event_causes ec WHERE ec.event_id=e.id AND ec.simulation_id=e.simulation_id)`, [simulationId, ...eventRange.params])
  ]);

  const tick = ticks[0] || {}, action = actions[0] || {}, event = events[0] || {}, decision = decisions[0] || {}, memory = memories[0] || {};
  const temporal = number(temporalRows[0]?.negativeDuration);
  const invalidImportance = number(invalidRows[0]?.invalidEventImportance);
  const suspiciousDuration = number(durationRows[0]?.suspicious);
  const failedTicks = number(tick.failed);

  const anomalyList = [];
  if (failedTicks > 0) anomalyList.push({ id: "failed-ticks", severity: failedTicks > 3 ? "CRITICAL" : "WARNING", title: "Tick falliti", detail: `${failedTicks} tick terminati con status FAILED nel periodo.`, count: failedTicks });
  const failedActions = number(action.failed);
  if (failedActions > 0) anomalyList.push({ id: "failed-actions", severity: failedActions > 3 ? "WARNING" : "INFO", title: "Azioni fallite", detail: `${failedActions} azioni risultano FAILED/CANCELLED/ERROR.`, count: failedActions });
  if (temporal > 0) anomalyList.push({ id: "negative-duration", severity: "CRITICAL", title: "Sequenza temporale impossibile", detail: "Almeno un'azione termina prima del proprio avvio.", count: temporal });
  if (suspiciousDuration > 0) anomalyList.push({ id: "suspicious-duration", severity: "WARNING", title: "Durate sospette", detail: "Sono presenti azioni con durata negativa o superiore a 72 ore simulate.", count: suspiciousDuration });
  if (invalidImportance > 0) anomalyList.push({ id: "invalid-importance", severity: "CRITICAL", title: "Importanza evento fuori scala", detail: "Sono stati rilevati valori di importance fuori dall'intervallo 0–1.", count: invalidImportance });
  const failedDecisionCount = number(decision.failed);
  if (failedDecisionCount > 0) anomalyList.push({ id: "decision-failures", severity: "WARNING", title: "Decisioni con esito problematico", detail: `${failedDecisionCount} decisioni hanno status FAILED/ERROR/REJECTED.`, count: failedDecisionCount });
  if (!anomalyList.length) anomalyList.push({ id: "clean", severity: "INFO", title: "Nessuna anomalia rilevata", detail: "I controlli automatici non hanno trovato inconsistenze note nel periodo.", count: 0 });

  const highlightEventLimit = 12;
  const [highlightRows] = await pool.query(`
    SELECT * FROM (
      SELECT e.simulation_at at,'EVENT' kind,BIN_TO_UUID(e.id) id,e.title title,
             COALESCE(e.description,e.type,'Evento registrato') description,
             CASE WHEN COALESCE(e.importance,0)>=0.9 THEN 'WARNING' ELSE 'INFO' END severity
      FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}
      UNION ALL
      SELECT a.started_simulation_at at,'ACTION' kind,BIN_TO_UUID(a.id) id,
             CONCAT(a.action_type,' · ',a.status) title,
             COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.result,'$.failureReason')),a.source_type,'Azione registrata') description,
             CASE WHEN a.status IN ('FAILED','CANCELLED','ERROR') THEN 'WARNING' ELSE 'INFO' END severity
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}
    ) x ORDER BY at DESC LIMIT ?`, [simulationId, ...eventRange.params, simulationId, ...actionRange.params, highlightEventLimit]);

  const series = seriesRows.map((row) => ({ at: row.at, events: number(row.events), actions: number(row.actions), failedTicks: 0 }));
  const highlights = highlightRows.map((row) => ({ at: row.at, kind: row.kind, id: row.id, title: String(row.title || "Activity"), description: String(row.description || ""), severity: row.severity }));

  return {
    range: bounds,
    kpis: {
      ticks: { total: number(tick.total), completed: number(tick.completed), failed: failedTicks, skipped: number(tick.skipped), completionRate: rate(number(tick.completed), number(tick.total)) },
      actions: { total: number(action.total), completed: number(action.completed), failed: failedActions, successRate: rate(number(action.completed), number(action.total)), avgDurationSeconds: action.avgDurationSeconds === null ? null : number(action.avgDurationSeconds), suspiciousDuration },
      events: { total: number(event.total), important: number(event.important), avgImportance: number(event.avgImportance), maxImportance: number(event.maxImportance), withCause: number(causeRows[0]?.withCause) },
      decisions: { total: number(decision.total), failed: failedDecisionCount },
      memories: { total: number(memory.total), failures: number(memoryFailureRows[0]?.failures) },
      integrity: { temporal: temporal + invalidImportance }
    },
    series,
    highlights,
    anomalies: anomalyList,
    breakdowns: { actions: actionBreakdown, events: eventBreakdown, decisions: decisionBreakdown }
  };
}

module.exports = { analyzeSimulation };
