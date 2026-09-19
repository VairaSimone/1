const { pool } = require("../db/pool");
const actionService = require("./action-service");
const decisionService = require("./decision-service");
const analysisService = require("./analysis-service");
const { applyActionOutcomeNeedFeedback } = require("./behavior-feedback-service");

let installed = false;
const feedbackApplied = new Map();
const MAX_FEEDBACK_KEYS = 20000;
const FEEDBACK_KEY_TTL_MS = 12 * 60 * 60 * 1000;
const RESOURCE_TTL_MS = 180 * 60 * 1000;
const RESOURCE_REQUIREMENTS = { DRINKING: { resource: "water", amount: 1, need: "THIRST" }, EATING: { resource: "food", amount: 1, need: "HUNGER" } };

function parseJson(value, fallback = {}) { if (value === null || value === undefined) return fallback; if (typeof value === "object") return value; try { return JSON.parse(value); } catch { return fallback; } }
function normalize(value) { return String(value || "").trim().toUpperCase(); }
function needValue(needs, code) { return Number(needs?.find((need) => normalize(need.code) === code)?.value || 0); }
function nowMs(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.getTime() : Date.now(); }
function pruneFeedbackClaims(now = Date.now()) { for (const [actionId, claimedAt] of feedbackApplied) if (now - claimedAt > FEEDBACK_KEY_TTL_MS) feedbackApplied.delete(actionId); while (feedbackApplied.size > MAX_FEEDBACK_KEYS) { const oldest = feedbackApplied.keys().next().value; if (!oldest) break; feedbackApplied.delete(oldest); } }
function claimFeedback(actionId) { if (!actionId) return true; const now = Date.now(); pruneFeedbackClaims(now); if (feedbackApplied.has(actionId)) return false; feedbackApplied.set(actionId, now); return true; }

async function resolveBehaviorEntityId(simulationId, entityId) { if (entityId) return entityId; const [rows] = await pool.query(`SELECT BIN_TO_UUID(e.id) AS id FROM entities e JOIN entity_types et ON et.id=e.entity_type_id WHERE e.simulation_id=UUID_TO_BIN(?) AND et.code='PERSON' ORDER BY CASE WHEN LOWER(e.display_name)='asami' THEN 0 ELSE 1 END,e.created_simulation_at ASC LIMIT 1`, [simulationId]); return rows[0]?.id || null; }
async function enrichActiveAction(action, simulationId, entityId) { if (!action) return action; const [rows] = await pool.query(`SELECT BIN_TO_UUID(a.source_goal_id) AS goalId,BIN_TO_UUID(i.plan_id) AS planId FROM actions a LEFT JOIN intentions i ON i.id=a.source_intention_id WHERE a.id=UUID_TO_BIN(?) AND a.simulation_id=UUID_TO_BIN(?) AND a.entity_id=UUID_TO_BIN(?) LIMIT 1`, [action.id, simulationId, entityId]); const link = rows[0] || {}; action.metadata = { ...(action.metadata || {}), goalId: link.goalId || action.metadata?.goalId || null, planId: link.planId || action.metadata?.planId || null }; if (link.planId) { const [steps] = await pool.query(`SELECT BIN_TO_UUID(id) AS planStepId FROM plan_steps WHERE plan_id=UUID_TO_BIN(?) AND status='ACTIVE' ORDER BY sequence ASC LIMIT 1`, [link.planId]); action.metadata.planStepId = steps[0]?.planStepId || action.metadata.planStepId || null; } return action; }
async function loadUnavailableLocations(simulationId, entityId, simulationTime) { const [rows] = await pool.query(`SELECT BIN_TO_UUID(ki.object_entity_id) AS locationId,ki.content,ek.learned_simulation_at AS learnedAt FROM entity_knowledge ek JOIN knowledge_items ki ON ki.id=ek.knowledge_item_id WHERE ek.simulation_id=UUID_TO_BIN(?) AND ek.entity_id=UUID_TO_BIN(?) AND ek.status='ACTIVE' AND ki.knowledge_type='WORLD_EXPERIENCE' AND ki.predicate='RESOURCE_UNAVAILABLE' ORDER BY ek.learned_simulation_at DESC LIMIT 100`, [simulationId, entityId]); const cutoff = nowMs(simulationTime) - RESOURCE_TTL_MS, unavailable = { water: new Set(), food: new Set() }; for (const row of rows) { if (nowMs(row.learnedAt) < cutoff) continue; const payload = parseJson(row.content, null), resource = normalize(payload?.resource).toLowerCase(); if (resource === "water" || resource === "food") unavailable[resource].add(row.locationId); } return unavailable; }
async function loadResourceWorld(simulationId) { const [rows] = await pool.query(`SELECT BIN_TO_UUID(e.id) AS locationId,l.location_type AS locationType,l.latitude,l.longitude,l.address_data AS addressData,e.attributes FROM locations l JOIN entities e ON e.id=l.entity_id AND e.simulation_id=l.simulation_id WHERE l.simulation_id=UUID_TO_BIN(?) AND e.status='ACTIVE'`, [simulationId]); return rows.map((row) => { const attributes = parseJson(row.attributes, {}); return { locationId: row.locationId, locationType: row.locationType, latitude: Number(row.latitude), longitude: Number(row.longitude), data: parseJson(row.addressData, {}), resources: attributes.resources && typeof attributes.resources === "object" ? attributes.resources : {} }; }); }
function nearestResource(locations, originId, resource, excluded) { let best = null; for (const location of locations) { if (location.locationId === originId || excluded.has(location.locationId)) continue; if (Number(location.resources?.[resource] || 0) < 1) continue; const route = actionService.shortestRoute(locations, originId, location.locationId); if (!route || !Number.isFinite(Number(route.distanceMeters))) continue; const travelMinutes = Number(route.distanceMeters) / 1000 / 4.8 * 60; if (!best || travelMinutes < best.travelMinutes) best = { ...location, travelMinutes, distanceMeters: route.distanceMeters, routePath: route.path }; } return best; }
async function strengthenResourceReasoning(context, simulationId, entityId, simulationTime) { const currentLocationId = context.location?.locationId; if (!currentLocationId || !context.resourceContext) return context; const unavailable = await loadUnavailableLocations(simulationId, entityId, simulationTime), locations = await loadResourceWorld(simulationId); const nearestResources = { water: nearestResource(locations, currentLocationId, "water", unavailable.water), food: nearestResource(locations, currentLocationId, "food", unavailable.food) }; const localResources = context.resourceContext.localResources || {}, actions = { ...(context.resourceContext.actions || {}) }; for (const [action, requirement] of Object.entries(RESOURCE_REQUIREMENTS)) { const localAvailable = Number(localResources[requirement.resource] || 0); actions[action] = { ...(actions[action] || {}), resource: requirement.resource, required: requirement.amount, localAvailable, locallyAvailable: localAvailable >= requirement.amount, knownUnavailableHere: unavailable[requirement.resource].has(currentLocationId), nearestLocation: nearestResources[requirement.resource] ? { locationId: nearestResources[requirement.resource].locationId, locationType: nearestResources[requirement.resource].locationType, distanceMeters: nearestResources[requirement.resource].distanceMeters, travelMinutes: nearestResources[requirement.resource].travelMinutes } : null }; }
  const candidates = (context.candidates || []).map((candidate) => ({ ...candidate }));
  for (const [action, requirement] of Object.entries(RESOURCE_REQUIREMENTS)) { const candidate = candidates.find((item) => normalize(item.action) === action), walking = candidates.find((item) => normalize(item.action) === "WALKING"), localAvailable = Number(localResources[requirement.resource] || 0) >= requirement.amount, target = nearestResources[requirement.resource]; if (candidate && !localAvailable) candidate.score = 0; if (walking && !localAvailable && target) { const pressure = needValue(context.needs, requirement.need), urgency = Math.max(1.8, Math.min(3.8, 2.0 + pressure * 1.6)), currentScore = Number(walking.score || 0), travelPenalty = Math.min(0.8, target.travelMinutes / 60 * 0.5); walking.score = Math.max(currentScore, urgency - travelPenalty); walking.targetLocationId = target.locationId; walking.resourceIntent = { resource: requirement.resource, reason: "LEARNED_RESOURCE_AVOIDANCE", destinationLocationId: target.locationId, expectedTravelMinutes: target.travelMinutes }; } }
  context.resourceContext = { ...context.resourceContext, localResources, nearestResources, actions, knownUnavailableLocationIds: { water: [...unavailable.water], food: [...unavailable.food] } }; context.candidates = candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)); return context; }
async function loadRecentOutcomes(simulationId, entityId, simulationTime, limit = 24) { const [rows] = await pool.query(`SELECT action_type AS actionType,JSON_UNQUOTE(JSON_EXTRACT(result,'$.outcome')) AS outcome,JSON_UNQUOTE(JSON_EXTRACT(result,'$.targetLocationId')) AS targetLocationId,JSON_UNQUOTE(JSON_EXTRACT(result,'$.targetEntityId')) AS targetEntityId,completed_simulation_at AS at FROM actions WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND status='COMPLETED' AND completed_simulation_at IS NOT NULL AND completed_simulation_at<=? ORDER BY completed_simulation_at DESC LIMIT ?`, [simulationId, entityId, simulationTime, limit]); return rows.map((row) => ({ ...row, outcome: normalize(row.outcome) })); }
function applyFailurePenalty(candidates, recentOutcomes) { return candidates.map((candidate) => { const action = normalize(candidate.action), failures = recentOutcomes.filter((row) => normalize(row.actionType) === action && (row.outcome === "FAILURE" || row.outcome === "PARTIAL")); if (!failures.length) return candidate; let penalty = Math.min(1.5, 0.85 + (failures.length - 1) * 0.45); if (recentOutcomes[0] && normalize(recentOutcomes[0].actionType) === action && (recentOutcomes[0].outcome === "FAILURE" || recentOutcomes[0].outcome === "PARTIAL")) penalty += 0.45; return { ...candidate, score: Math.max(0, Number(candidate.score || 0) - Math.min(2.2, penalty)), failurePenalty: Math.min(2.2, penalty) }; }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0)); }
function createFailureLoopPattern(failures, adaptationRate) { if (!failures) return null; const severity = adaptationRate < 0.5 && failures >= 2 ? "WARNING" : "INFO"; return { id: "decision-consequence-adaptation", severity, title: "Ciclo decisione → conseguenza → adattamento", detail: `${failures} esiti problematici rilevati; ${Math.round(adaptationRate * 100)}% è stato seguito da un cambio di strategia entro 6 ore simulate.`, count: failures, evidence: { problematicDecisions: failures, adaptationRate } }; }
function computeAdaptation(rows) { const ordered = rows.slice().sort((a, b) => nowMs(a.at) - nowMs(b.at)), failures = ordered.filter((row) => row.outcome === "FAILURE" || row.outcome === "PARTIAL"); if (!failures.length) return { failures: 0, adapted: 0, rate: 0 }; let adapted = 0; for (const failure of failures) { const failureAt = nowMs(failure.at), next = ordered.find((row) => nowMs(row.at) > failureAt && nowMs(row.at) - failureAt <= 6 * 3600000); if (!next) continue; if (normalize(next.actionType) !== normalize(failure.actionType) || String(next.targetLocationId || "") !== String(failure.targetLocationId || "")) adapted += 1; } return { failures: failures.length, adapted, rate: adapted / failures.length }; }
async function patchAnalysisResult(result, simulationId, entityId, actualFrom, actualTo) { const effectiveEntityId = await resolveBehaviorEntityId(simulationId, entityId); const actionParams = [simulationId, actualFrom, actualTo], entityClause = effectiveEntityId ? " AND a.entity_id=UUID_TO_BIN(?)" : ""; if (effectiveEntityId) actionParams.push(effectiveEntityId); const [actions] = await pool.query(`SELECT action_type AS actionType,JSON_UNQUOTE(JSON_EXTRACT(result,'$.outcome')) AS outcome,JSON_UNQUOTE(JSON_EXTRACT(result,'$.targetLocationId')) AS targetLocationId,JSON_UNQUOTE(JSON_EXTRACT(result,'$.targetEntityId')) AS targetEntityId,completed_simulation_at AS at FROM actions a WHERE a.simulation_id=UUID_TO_BIN(?) AND a.started_simulation_at>=? AND a.started_simulation_at<=?${entityClause} ORDER BY completed_simulation_at ASC,started_simulation_at ASC`, actionParams); const normalizedActions = actions.map((row) => ({ ...row, outcome: normalize(row.outcome) })), successful = normalizedActions.filter((row) => row.outcome === "SUCCESS").length, problematic = normalizedActions.filter((row) => row.outcome === "FAILURE" || row.outcome === "PARTIAL").length, unsettled = normalizedActions.filter((row) => !row.outcome).length, technicalCompleted = normalizedActions.length - unsettled, settled = successful + problematic, adaptation = computeAdaptation(normalizedActions);
  const decisionParams = [simulationId, actualFrom, actualTo], decisionEntityClause = effectiveEntityId ? " AND d.entity_id=UUID_TO_BIN(?)" : ""; if (effectiveEntityId) decisionParams.push(effectiveEntityId); const [decisionRows] = await pool.query(`SELECT d.id,d.status,JSON_UNQUOTE(JSON_EXTRACT(d.actual_outcome,'$.outcome')) AS outcome,d.simulation_time AS at FROM decisions d WHERE d.simulation_id=UUID_TO_BIN(?) AND d.simulation_time>=? AND d.simulation_time<=?${decisionEntityClause} ORDER BY d.simulation_time ASC`, decisionParams); const executedDecisions = decisionRows.filter((row) => row.status === "EXECUTED").length, successfulDecisions = decisionRows.filter((row) => normalize(row.outcome) === "SUCCESS").length, problematicDecisions = decisionRows.filter((row) => normalize(row.outcome) === "FAILURE" || normalize(row.outcome) === "PARTIAL").length, decisionsWithOutcome = successfulDecisions + problematicDecisions;
  const memoryParams = [simulationId, actualFrom, actualTo], memoryEntityClause = effectiveEntityId ? " AND m.entity_id=UUID_TO_BIN(?)" : ""; if (effectiveEntityId) memoryParams.push(effectiveEntityId); const [learningRows] = await pool.query(`SELECT COUNT(*) AS total FROM memories m WHERE m.simulation_id=UUID_TO_BIN(?) AND m.created_simulation_at>=? AND m.created_simulation_at<=?${memoryEntityClause} AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind')),'')) IN ('resource_failure','action_failure','action_interruption')`, memoryParams); const learningSignals = Number(learningRows[0]?.total || 0);
  result.kpis.actions.completed = technicalCompleted; result.kpis.actions.successful = successful; result.kpis.actions.failed = problematic; result.kpis.actions.problematic = problematic; result.kpis.actions.unsettled = unsettled; result.kpis.actions.technicalCompletionRate = result.kpis.actions.total ? Math.round((technicalCompleted / result.kpis.actions.total) * 1000) / 10 : 0; result.kpis.actions.successRate = settled ? Math.round((successful / settled) * 1000) / 10 : 0; result.kpis.decisions.executed = executedDecisions; result.kpis.decisions.successful = successfulDecisions; result.kpis.decisions.failed = problematicDecisions; result.kpis.decisions.problematic = problematicDecisions; result.kpis.decisions.outcomeCoverage = decisionRows.length ? Math.round((decisionsWithOutcome / decisionRows.length) * 1000) / 10 : 0; result.kpis.decisions.adaptationRate = Math.round(adaptation.rate * 1000) / 10; result.kpis.decisions.learningSignals = learningSignals;
  if (problematic > 0) result.anomalies.push({ id: "actual-action-outcomes", severity: problematic >= 4 ? "WARNING" : "INFO", title: "Esiti azione problematici", detail: `${problematic} azioni hanno avuto outcome FAILURE o PARTIAL, indipendentemente dallo status tecnico.`, count: problematic, evidence: { successful, problematic, technicalCompleted, unsettled } }); if (problematicDecisions > 0) result.anomalies.push({ id: "actual-decision-outcomes", severity: problematicDecisions >= 4 ? "WARNING" : "INFO", title: "Decisioni con conseguenza problematica", detail: `${problematicDecisions} decisioni sono collegate a un esito FAILURE/PARTIAL reale.`, count: problematicDecisions, evidence: { executedDecisions, problematicDecisions, outcomeCoverage: result.kpis.decisions.outcomeCoverage } }); const loopPattern = createFailureLoopPattern(problematicDecisions || problematic, adaptation.rate); if (loopPattern) result.patterns.unshift(loopPattern); return result; }
function install() { if (installed) return; const originalGetActiveAction = actionService.getActiveAction; actionService.getActiveAction = async function patchedGetActiveAction(entityId, simulationId) { const action = await originalGetActiveAction(entityId, simulationId); return enrichActiveAction(action, simulationId, entityId); }; const originalCompleteAction = actionService.completeAction; actionService.completeAction = async function patchedCompleteAction(args = {}) { const result = await originalCompleteAction(args); if (result?.completed && result?.outcome && args?.actionId && claimFeedback(args.actionId)) { try { await applyActionOutcomeNeedFeedback({ entityId: args.entityId, actionId: args.actionId, actionType: args.actionType, simulationTime: args.simulationTime, outcome: result.outcome }); } catch { feedbackApplied.delete(args.actionId); } } if (result?.completed && args?.simulationId && args?.entityId) { try { const locationId = await actionService.currentLocation(args.entityId, args.simulationId); return { ...result, locationId }; } catch { return result; } } return result; }; const originalBuildDecisionContext = decisionService.buildDecisionContext; decisionService.buildDecisionContext = async function patchedBuildDecisionContext(simulationId, entityId, simulationTime) { let context = await originalBuildDecisionContext(simulationId, entityId, simulationTime); context.recentOutcomes = await loadRecentOutcomes(simulationId, entityId, simulationTime); context = await strengthenResourceReasoning(context, simulationId, entityId, simulationTime); context.candidates = applyFailurePenalty(context.candidates || [], context.recentOutcomes); return context; }; 
const originalMakeDecision = decisionService.makeDecision;
decisionService.makeDecision = async function patchedMakeDecision(args = {}) {
  const sourceContext = args.context || {};
  const context = {
    ...sourceContext,
    candidates: (sourceContext.candidates || []).map(candidate => ({ ...candidate }))
  };

  /*
   * Do not lower a real physiological value below the critical threshold to
   * make the decision engine forget an unresolved emergency. The central
   * decision service now enforces the actual recovery action.
   */
  const localResources = context.resourceContext?.localResources || {};
  const blockedResources = [];

  if (needValue(context.needs, "THIRST") >= 0.8 && Number(localResources.water || 0) < 1) {
    blockedResources.push("THIRST");
  }
  if (needValue(context.needs, "HUNGER") >= 0.8 && Number(localResources.food || 0) < 1) {
    blockedResources.push("HUNGER");
  }

  if (blockedResources.length) {
    if (context.activePlanStep) {
      const stepAction = normalize(
        context.activePlanStep.actionType || context.activePlanStep.result?.actionType
      );
      if (
        (stepAction === "DRINKING" && blockedResources.includes("THIRST")) ||
        (stepAction === "EATING" && blockedResources.includes("HUNGER"))
      ) {
        context.activePlanStep = null;
      }
    }

    const walking = context.candidates.find(
      candidate => normalize(candidate.action) === "WALKING"
    );

    for (const code of blockedResources) {
      const resource = code === "THIRST" ? "water" : "food";
      const directAction = code === "THIRST" ? "DRINKING" : "EATING";
      const nearest =
        context.resourceContext?.nearestResources?.[resource] ||
        context.resourceContext?.actions?.[directAction]?.nearestLocation ||
        null;

      if (walking && nearest?.locationId) {
        walking.targetLocationId = nearest.locationId;
        walking.resourceIntent = {
          ...(walking.resourceIntent || {}),
          resource,
          reason: "CRITICAL_NEED_RESOURCE_RECOVERY",
          destinationLocationId: nearest.locationId,
          expectedTravelMinutes: Number.isFinite(Number(nearest.travelMinutes))
            ? Number(nearest.travelMinutes)
            : null
        };
        walking.score = Math.max(
          Number(walking.score || 0),
          4.0 + blockedResources.length * 0.6
        );
      }
    }

    context.candidates.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }

  return originalMakeDecision({ ...args, context });
};
 const originalAnalyzeSimulation = analysisService.analyzeSimulation; analysisService.analyzeSimulation = async function patchedAnalyzeSimulation(simulationId, options = {}) { const result = await originalAnalyzeSimulation(simulationId, options); return patchAnalysisResult(result, simulationId, options.entityId, result.range.from, result.range.to); }; installed = true; }
module.exports = { install, claimFeedback, pruneFeedbackClaims };
