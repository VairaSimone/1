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

function pattern(id, severity, title, detail, count = 0, evidence = null) {
  return { id, severity, title, detail, count, evidence };
}

async function analyzeSimulation(simulationId, { from, to, entityId } = {}) {
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
  const entityClause = entityId ? " AND a.entity_id=UUID_TO_BIN(?)" : "";
  const entityParams = entityId ? [entityId] : [];
  const goalEntityClause = entityId ? " AND g.entity_id=UUID_TO_BIN(?)" : "";
  const goalEntityParams = entityId ? [entityId] : [];

  const [
    [ticks], [actions], [events], [decisions], [memories],
    [actionBreakdown], [eventBreakdown], [decisionBreakdown], [seriesRows],
    [temporalRows], [invalidRows], [memoryFailureRows],
    [stuckGoalRows], [repeatedActionRows], [stagnantNeedRows],
    [emotionEscalationRows], [decisionLoopRows], [failureModeRows]
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*) total,
      SUM(status='COMPLETED') completed,
      SUM(status='FAILED') failed,
      SUM(status='SKIPPED') skipped
      FROM simulation_ticks t WHERE t.simulation_id=UUID_TO_BIN(?)${tickRange.where}`, [simulationId, ...tickRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(status='COMPLETED') completed,
      SUM(status IN ('FAILED','CANCELLED')) failed,
      AVG(CASE WHEN completed_simulation_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,started_simulation_at,completed_simulation_at) END) avgDurationSeconds,
      SUM(completed_simulation_at IS NOT NULL AND (completed_simulation_at < started_simulation_at OR TIMESTAMPDIFF(HOUR,started_simulation_at,completed_simulation_at) > 72)) suspiciousDuration
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}`, [simulationId, ...actionRange.params, ...entityParams]),
    pool.query(`SELECT COUNT(*) total,
      SUM(COALESCE(importance,0) >= 0.7) important,
      AVG(importance) avgImportance,
      MAX(importance) maxImportance
      FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}`, [simulationId, ...eventRange.params]),
    pool.query(`SELECT COUNT(*) total,
      SUM(UPPER(COALESCE(status,''))='FAILED') failed
      FROM decisions d WHERE d.simulation_id=UUID_TO_BIN(?)${decisionRange.where}${entityId ? " AND d.entity_id=UUID_TO_BIN(?)" : ""}`, [simulationId, ...decisionRange.params, ...entityParams]),
    pool.query(`SELECT COUNT(*) total,
      SUM(LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.outcome')),''))='failure') failures
      FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?)${memoryRange.where}${entityId ? " AND m.entity_id=UUID_TO_BIN(?)" : ""}`, [simulationId, ...memoryRange.params, ...entityParams]),
    pool.query(`SELECT action_type label,COUNT(*) value FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause} GROUP BY action_type ORDER BY value DESC LIMIT 8`, [simulationId, ...actionRange.params, ...entityParams]),
    pool.query(`SELECT et.code label,COUNT(*) value FROM events e JOIN event_types et ON et.id=e.event_type_id WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where} GROUP BY et.code ORDER BY value DESC LIMIT 8`, [simulationId, ...eventRange.params]),
    pool.query(`SELECT COALESCE(status,'UNKNOWN') label,COUNT(*) value FROM decisions d WHERE d.simulation_id=UUID_TO_BIN(?)${decisionRange.where}${entityId ? " AND d.entity_id=UUID_TO_BIN(?)" : ""} GROUP BY status ORDER BY value DESC LIMIT 8`, [simulationId, ...decisionRange.params, ...entityParams]),
    pool.query(`SELECT bucket at,
      SUM(kind='EVENT') events,
      SUM(kind='ACTION') actions,
      SUM(kind='FAILED_TICK') failedTicks
      FROM (
        SELECT DATE_FORMAT(e.simulation_at,'%Y-%m-%d %H:00:00') bucket,'EVENT' kind FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}
        UNION ALL
        SELECT DATE_FORMAT(a.started_simulation_at,'%Y-%m-%d %H:00:00') bucket,'ACTION' kind FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}
        UNION ALL
        SELECT DATE_FORMAT(t.simulation_time,'%Y-%m-%d %H:00:00') bucket,'FAILED_TICK' kind FROM simulation_ticks t WHERE t.simulation_id=UUID_TO_BIN(?) AND t.status='FAILED'${tickRange.where}
      ) x GROUP BY bucket ORDER BY bucket`, [simulationId, ...eventRange.params, simulationId, ...actionRange.params, ...entityParams, simulationId, ...tickRange.params]),
    pool.query(`SELECT SUM(completed_simulation_at IS NOT NULL AND completed_simulation_at < started_simulation_at) negativeDuration
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}`, [simulationId, ...actionRange.params, ...entityParams]),
    pool.query(`SELECT SUM(COALESCE(importance,-1) < 0 OR COALESCE(importance,2) > 1) invalidEventImportance
      FROM events e WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}`, [simulationId, ...eventRange.params]),
    pool.query(`SELECT COUNT(*) failures FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?)${memoryRange.where}${entityId ? " AND m.entity_id=UUID_TO_BIN(?)" : ""}
      AND (LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'')) IN ('resource_failure','action_failure')
           OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.outcome')),''))='failure')`, [simulationId, ...memoryRange.params, ...entityParams]),

    pool.query(`SELECT BIN_TO_UUID(g.id) id,g.title,g.status,g.progress,g.created_simulation_at createdAt,
      TIMESTAMPDIFF(HOUR,g.created_simulation_at,?) ageHours,COUNT(a.id) attempts
      FROM goals g LEFT JOIN actions a ON a.simulation_id=g.simulation_id AND a.source_goal_id=g.id
      WHERE g.simulation_id=UUID_TO_BIN(?)${goalEntityClause}
        AND g.status IN ('ACTIVE','PAUSED')
        AND g.progress < 0.15
        AND g.created_simulation_at <= TIMESTAMPADD(HOUR,-12,?)
      GROUP BY g.id,g.title,g.status,g.progress,g.created_simulation_at
      HAVING attempts >= 3 OR ageHours >= 24
      ORDER BY attempts DESC,ageHours DESC LIMIT 12`, [actualTo, simulationId, ...goalEntityParams, actualTo]),

    pool.query(`SELECT a.action_type label,COUNT(*) attempts,
      SUM(a.status IN ('FAILED','CANCELLED','INTERRUPTED')) failed,
      COUNT(DISTINCT COALESCE(BIN_TO_UUID(a.source_goal_id),'NO_GOAL')) goalCount,
      MIN(a.started_simulation_at) firstAt,MAX(a.started_simulation_at) lastAt
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}
      GROUP BY a.action_type
      HAVING attempts >= 4
         AND TIMESTAMPDIFF(HOUR,MIN(a.started_simulation_at),MAX(a.started_simulation_at)) <= 12
      ORDER BY attempts DESC LIMIT 12`, [simulationId, ...actionRange.params, ...entityParams]),

    pool.query(`SELECT nd.code label,nd.name,
      COUNT(h.id) observations,
      SUM(h.delta < -0.02) improvingSteps,
      SUM(h.delta > 0.02) worseningSteps,
      SUM(h.delta) netDelta,
      AVG(h.delta) avgDelta
      FROM entity_need_history h
      JOIN need_definitions nd ON nd.id=h.need_id
      WHERE h.entity_id=UUID_TO_BIN(?) AND h.simulation_time>=? AND h.simulation_time<=?
      GROUP BY nd.id,nd.code,nd.name
      HAVING observations >= 5 AND (netDelta >= 0.08 OR improvingSteps=0)
      ORDER BY netDelta DESC LIMIT 12`, [entityId || "00000000-0000-0000-0000-000000000000", actualFrom, actualTo]),

    pool.query(`SELECT ed.code label,ed.name,
      COUNT(h.id) observations,
      SUM(h.delta > 0.05) sharpRises,
      SUM(h.delta < -0.05) sharpFalls,
      SUM(h.delta) netDelta,
      MAX(h.new_intensity) maxIntensity,
      AVG(h.delta) avgDelta
      FROM entity_emotion_history h
      JOIN emotion_definitions ed ON ed.id=h.emotion_id
      WHERE h.entity_id=UUID_TO_BIN(?) AND h.simulation_time>=? AND h.simulation_time<=?
      GROUP BY ed.id,ed.code,ed.name
      HAVING observations >= 5 AND (netDelta >= 0.25 OR maxIntensity >= 0.9 AND sharpRises >= 2)
      ORDER BY netDelta DESC,maxIntensity DESC LIMIT 12`, [entityId || "00000000-0000-0000-0000-000000000000", actualFrom, actualTo]),

    pool.query(`SELECT COALESCE(a.source_goal_id,a.decision_id) groupKey,a.action_type label,
      COUNT(*) attempts,SUM(a.status IN ('FAILED','CANCELLED','INTERRUPTED')) failed,
      COUNT(DISTINCT a.decision_id) distinctDecisions,
      MIN(a.started_simulation_at) firstAt,MAX(a.started_simulation_at) lastAt
      FROM actions a
      WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}
        AND a.decision_id IS NOT NULL
      GROUP BY groupKey,a.action_type
      HAVING attempts >= 5
         AND (failed >= 3 OR TIMESTAMPDIFF(HOUR,MIN(a.started_simulation_at),MAX(a.started_simulation_at)) <= 6)
      ORDER BY attempts DESC LIMIT 12`, [simulationId, ...actionRange.params, ...entityParams]),

    pool.query(`SELECT a.action_type label,COUNT(*) attempts,
      SUM(a.status IN ('FAILED','CANCELLED','INTERRUPTED')) failed,
      ROUND(100*SUM(a.status IN ('FAILED','CANCELLED','INTERRUPTED'))/COUNT(*),1) failureRate
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}
      GROUP BY a.action_type
      HAVING attempts >= 5 AND failureRate >= 60
      ORDER BY failureRate DESC,attempts DESC LIMIT 12`, [simulationId, ...actionRange.params, ...entityParams])
  ]);

  const tick = ticks[0] || {}, action = actions[0] || {}, event = events[0] || {}, decision = decisions[0] || {}, memory = memories[0] || {};
  const temporal = number(temporalRows[0]?.negativeDuration);
  const invalidImportance = number(invalidRows[0]?.invalidEventImportance);
  const suspiciousDuration = number(action.suspiciousDuration);
  const failedTicks = number(tick.failed);
  const failedActions = number(action.failed);
  const failedDecisionCount = number(decision.failed);

  const anomalyList = [];
  if (failedTicks > 0) anomalyList.push(pattern("failed-ticks", failedTicks > 3 ? "CRITICAL" : "WARNING", "Tick falliti", `${failedTicks} tick terminati con status FAILED nel periodo.`, failedTicks));
  if (failedActions > 0) anomalyList.push(pattern("failed-actions", failedActions > 3 ? "WARNING" : "INFO", "Azioni fallite", `${failedActions} azioni risultano FAILED/CANCELLED.`, failedActions));
  if (temporal > 0) anomalyList.push(pattern("negative-duration", "CRITICAL", "Sequenza temporale impossibile", "Almeno un'azione termina prima del proprio avvio.", temporal));
  if (suspiciousDuration > 0) anomalyList.push(pattern("suspicious-duration", "WARNING", "Durate sospette", "Sono presenti azioni con durata negativa o superiore a 72 ore simulate.", suspiciousDuration));
  if (invalidImportance > 0) anomalyList.push(pattern("invalid-importance", "CRITICAL", "Importanza evento fuori scala", "Sono stati rilevati valori di importance fuori dall'intervallo 0–1.", invalidImportance));
  if (failedDecisionCount > 0) anomalyList.push(pattern("decision-failures", "WARNING", "Decisioni fallite", `${failedDecisionCount} decisioni hanno status FAILED.`, failedDecisionCount));

  const patterns = [];
  for (const row of stuckGoalRows) {
    patterns.push(pattern(
      `stuck-goal-${row.id}`, row.attempts >= 6 || Number(row.ageHours) >= 48 ? "WARNING" : "INFO",
      `Goal potenzialmente bloccato: ${row.title}`,
      `Progress ${Math.round(number(row.progress) * 100)}%, ${row.attempts} tentativi, ${row.ageHours} ore dall'apertura.`,
      Number(row.attempts), { goalId: row.id, progress: number(row.progress), attempts: number(row.attempts), ageHours: number(row.ageHours) }
    ));
  }
  for (const row of repeatedActionRows) {
    const failureRate = rate(number(row.failed), number(row.attempts));
    patterns.push(pattern(
      `repeated-action-${row.label}`, failureRate >= 60 ? "WARNING" : "INFO",
      `Azione ripetuta: ${row.label}`,
      `${row.attempts} esecuzioni in ${Math.max(1, Math.round((new Date(row.lastAt) - new Date(row.firstAt)) / 3600000))} ore simulate${row.failed ? `, ${row.failed} non riuscite` : ""}.`,
      number(row.attempts), { actionType: row.label, attempts: number(row.attempts), failed: number(row.failed), failureRate }
    ));
  }
  for (const row of stagnantNeedRows) {
    patterns.push(pattern(
      `stagnant-need-${row.label}`, Number(row.netDelta) >= 0.2 ? "WARNING" : "INFO",
      `Bisogno non si riduce: ${row.name}`,
      `${row.observations} osservazioni, variazione netta ${number(row.netDelta).toFixed(3)}, ${row.improvingSteps} passaggi migliorativi.`,
      number(row.observations), { need: row.label, netDelta: number(row.netDelta), improvingSteps: number(row.improvingSteps), worseningSteps: number(row.worseningSteps) }
    ));
  }
  for (const row of emotionEscalationRows) {
    patterns.push(pattern(
      `emotion-escalation-${row.label}`, Number(row.netDelta) >= 0.4 || Number(row.maxIntensity) >= 0.95 ? "WARNING" : "INFO",
      `Crescita emotiva persistente: ${row.name}`,
      `${row.observations} variazioni, aumento netto ${number(row.netDelta).toFixed(3)}, picco ${Math.round(number(row.maxIntensity) * 100)}%.`,
      number(row.observations), { emotion: row.label, netDelta: number(row.netDelta), maxIntensity: number(row.maxIntensity), sharpRises: number(row.sharpRises) }
    ));
  }
  for (const row of decisionLoopRows) {
    const failureRate = rate(number(row.failed), number(row.attempts));
    patterns.push(pattern(
      `decision-loop-${String(row.groupKey)}-${row.label}`, failureRate >= 60 ? "WARNING" : "INFO",
      `Loop decisionale: ${row.label}`,
      `${row.attempts} azioni collegate a decisioni nella stessa sequenza${row.failed ? `, ${row.failed} fallimenti/interruzioni` : ""}.`,
      number(row.attempts), { actionType: row.label, attempts: number(row.attempts), failed: number(row.failed), distinctDecisions: number(row.distinctDecisions), failureRate }
    ));
  }
  for (const row of failureModeRows) {
    patterns.push(pattern(
      `failure-mode-${row.label}`, Number(row.failureRate) >= 80 ? "WARNING" : "INFO",
      `Pattern di fallimento: ${row.label}`,
      `${row.failed}/${row.attempts} esecuzioni non riuscite (${row.failureRate}%).`,
      number(row.failed), { actionType: row.label, attempts: number(row.attempts), failed: number(row.failed), failureRate: number(row.failureRate) }
    ));
  }

  if (patterns.some((x) => x.id.startsWith("stuck-goal-"))) {
    anomalyList.push(pattern("behavior-stuck-goal", "WARNING", "Goal potenzialmente bloccato", "Uno o più goal mostrano bassa progressione nonostante ripetuti tentativi.", patterns.filter((x) => x.id.startsWith("stuck-goal-")).length));
  }
  if (patterns.some((x) => x.id.startsWith("decision-loop-") || x.id.startsWith("repeated-action-"))) {
    anomalyList.push(pattern("behavior-loop", "WARNING", "Comportamento ripetitivo", "Sono presenti sequenze di azioni/decisioni ripetute nel breve periodo.", patterns.filter((x) => x.id.startsWith("decision-loop-") || x.id.startsWith("repeated-action-")).length));
  }
  if (patterns.some((x) => x.id.startsWith("stagnant-need-"))) {
    anomalyList.push(pattern("behavior-needs-stagnant", "WARNING", "Bisogni persistenti", "Alcuni bisogni non mostrano una riduzione sufficiente nel periodo analizzato.", patterns.filter((x) => x.id.startsWith("stagnant-need-")).length));
  }
  if (patterns.some((x) => x.id.startsWith("emotion-escalation-"))) {
    anomalyList.push(pattern("behavior-emotion-escalation", "WARNING", "Escalation emotiva", "Alcune emozioni mostrano crescita persistente o raggiungono intensità molto elevate.", patterns.filter((x) => x.id.startsWith("emotion-escalation-")).length));
  }

  if (!anomalyList.length) anomalyList.push(pattern("clean", "INFO", "Nessuna anomalia rilevata", "I controlli automatici non hanno trovato inconsistenze o pattern sospetti tra quelli monitorati.", 0));

  const [highlightRows] = await pool.query(`
    SELECT * FROM (
      SELECT e.simulation_at at,'EVENT' kind,BIN_TO_UUID(e.id) id,e.title title,
             COALESCE(e.description,et.code,'Evento registrato') description,
             CASE WHEN COALESCE(e.importance,0)>=0.9 THEN 'WARNING' ELSE 'INFO' END severity
      FROM events e JOIN event_types et ON et.id=e.event_type_id
      WHERE e.simulation_id=UUID_TO_BIN(?)${eventRange.where}
      UNION ALL
      SELECT a.started_simulation_at at,'ACTION' kind,BIN_TO_UUID(a.id) id,
             CONCAT(a.action_type,' · ',a.status) title,
             COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.result,'$.failureReason')),a.source_type,'Azione registrata') description,
             CASE WHEN a.status IN ('FAILED','CANCELLED') THEN 'WARNING' ELSE 'INFO' END severity
      FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?)${actionRange.where}${entityClause}
    ) x ORDER BY at DESC LIMIT 12`, [simulationId, ...eventRange.params, simulationId, ...actionRange.params, ...entityParams]);

  return {
    range: bounds,
    kpis: {
      ticks: { total: number(tick.total), completed: number(tick.completed), failed: failedTicks, skipped: number(tick.skipped), completionRate: rate(number(tick.completed), number(tick.total)) },
      actions: { total: number(action.total), completed: number(action.completed), failed: failedActions, successRate: rate(number(action.completed), number(action.total)), avgDurationSeconds: action.avgDurationSeconds === null ? null : number(action.avgDurationSeconds), suspiciousDuration },
      events: { total: number(event.total), important: number(event.important), avgImportance: number(event.avgImportance), maxImportance: number(event.maxImportance) },
      decisions: { total: number(decision.total), failed: failedDecisionCount },
      memories: { total: number(memory.total), failures: number(memoryFailureRows[0]?.failures) },
      integrity: { temporal: temporal + invalidImportance }
    },
    series: seriesRows.map((row) => ({ at: row.at, events: number(row.events), actions: number(row.actions), failedTicks: number(row.failedTicks) })),
    highlights: highlightRows.map((row) => ({ at: row.at, kind: row.kind, id: row.id, title: String(row.title || "Activity"), description: String(row.description || ""), severity: row.severity })),
    anomalies: anomalyList,
    patterns: patterns.slice(0, 40),
    breakdowns: { actions: actionBreakdown.map((row) => ({ label: String(row.label || "UNKNOWN"), value: number(row.value) })), events: eventBreakdown.map((row) => ({ label: String(row.label || "UNKNOWN"), value: number(row.value) })), decisions: decisionBreakdown.map((row) => ({ label: String(row.label || "UNKNOWN"), value: number(row.value) })) }
  };
}

module.exports = { analyzeSimulation };
