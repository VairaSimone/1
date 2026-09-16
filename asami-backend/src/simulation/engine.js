const logger = require("../lib/logger");
const { env } = require("../config/env");
const { pool } = require("../db/pool");
const simRepo = require("../repositories/simulation-repo");
const entityRepo = require("../repositories/entity-repo");
const { ensureEntityState, updateNeeds, applyEmotions, developTraits, readNeeds } = require("../services/state-service");
const { findAutonomousActors, actForEntity, completeGoalForAction } = require("../services/autonomy-service");
const { perceive } = require("../services/perception-service");
const { startAction, completeAction, getActiveAction, learnFromAction } = require("../services/action-service");
const { createMemory, decayMemories, buildActionMemory, buildFailureMemory } = require("../services/memory-service");
const { generateWorldEvents } = require("../services/world-service");
const { ensureWorld, evolveRelationships } = require("../services/world-population-service");
const { seedPhysicalWorld } = require("../services/physical-world-service");
const { updateDevelopment } = require("../services/development-service");
const { initiateConversation } = require("../services/chat-service");
const { recordHabitEvidence } = require("../services/habit-service");
const { updateMentalState } = require("../services/personality-service");
const { recordSignificantExperience } = require("../services/experience-learning-service");

const INTERRUPTIBLE_ACTIONS = new Set(["SLEEPING", "WORKING", "STUDYING"]);
const INTERRUPTION_NEED_THRESHOLDS = {
  THIRST: 0.8,
  HUNGER: 0.8,
  SLEEPINESS: 0.85,
  ENERGY: 0.15,
  SAFETY: 0.2
};
const COMPATIBLE_INTERRUPTION_ACTIONS = {
  THIRST: new Set(["DRINKING"]),
  HUNGER: new Set(["EATING"]),
  SLEEPINESS: new Set(["SLEEPING"]),
  ENERGY: new Set(["SLEEPING", "RESTING"]),
  SAFETY: new Set([])
};
const CRITICAL_EVENT_PATTERNS = /DANGER|EMERGENCY|ACCIDENT|THREAT|CRISIS|EVACUATION|ATTACK|FIRE/i;

function getCriticalInterruptionNeed(activeActionType, needs = []) {
  if (!INTERRUPTIBLE_ACTIONS.has(String(activeActionType || "").toUpperCase())) return null;
  let selected = null;
  for (const need of needs) {
    const code = String(need.code || "").toUpperCase();
    const value = Number(need.value);
    const threshold = INTERRUPTION_NEED_THRESHOLDS[code];
    if (!Number.isFinite(value) || threshold === undefined || value < threshold) continue;
    if (COMPATIBLE_INTERRUPTION_ACTIONS[code]?.has(String(activeActionType).toUpperCase())) continue;
    const urgency = code === "SAFETY" || code === "ENERGY" ? 1 + (threshold - value) : value;
    const candidate = { code, value, threshold, urgency };
    if (!selected || candidate.urgency > selected.urgency) selected = candidate;
  }
  return selected;
}

function getCriticalInterruptionEvent(perception) {
  const events = Array.isArray(perception?.recentEvents) ? perception.recentEvents : [];
  for (const event of events) {
    const type = String(event?.type || "");
    const title = String(event?.title || "");
    const description = String(event?.description || "");
    const importance = Number(event?.importance);
    if ((Number.isFinite(importance) && importance >= 0.9) || CRITICAL_EVENT_PATTERNS.test(`${type} ${title} ${description}`)) {
      return { id: event?.id || null, type, title, importance: Number.isFinite(importance) ? importance : null };
    }
  }
  return null;
}

function getInterruptionReason(activeActionType, needs, perception) {
  const need = getCriticalInterruptionNeed(activeActionType, needs);
  if (need) return { type: "CRITICAL_NEED", code: need.code, value: need.value, threshold: need.threshold, message: `${need.code} reached a critical level (${need.value.toFixed(3)})` };
  const event = getCriticalInterruptionEvent(perception);
  if (event) return { type: "CRITICAL_EVENT", eventId: event.id, eventType: event.type, message: `critical world event detected${event.title ? `: ${event.title}` : ""}` };
  return null;
}

async function interruptActiveAction({ simulationId, entityId, active, simulationTime, interruption }) {
  const actionId = active.id;
  const actionType = String(active.actionType || "ACTION").toUpperCase();
  const eventId = active.metadata?.eventId || null;
  const result = {
    eventId,
    actionType,
    outcome: "PARTIAL",
    success: false,
    failureReason: "ACTION_INTERRUPTED",
    interrupted: true,
    interruption,
    targetEntityId: active.metadata?.targetEntityId || null,
    targetLocationId: active.metadata?.targetLocationId || null,
    relationshipIntent: active.metadata?.relationshipIntent || "NONE"
  };

  const [updated] = await pool.query(
    `UPDATE actions
     SET status='COMPLETED',completed_simulation_at=?,result=?
     WHERE id=UUID_TO_BIN(?)
       AND entity_id=UUID_TO_BIN(?)
       AND simulation_id=UUID_TO_BIN(?)
       AND status='ACTIVE'`,
    [simulationTime, JSON.stringify(result), actionId, entityId, simulationId]
  );
  if (!updated.affectedRows) return false;

  const movementId = active.metadata?.movement?.movementId || null;
  if (movementId) {
    await pool.query(
      `UPDATE movements
       SET status='COMPLETED',actual_arrival_simulation_at=?,reason='autonomous route interrupted by critical state',version=version+1
       WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
      [simulationTime, movementId]
    );
  }

  if (active.intentionId) {
    await pool.query(
      `UPDATE intentions SET status='COMPLETED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`,
      [active.intentionId]
    );
  }

  if (active.decisionId) {
    await pool.query(
      `UPDATE decisions SET status='EXECUTED',actual_outcome=? WHERE id=UUID_TO_BIN(?) AND status IN ('EVALUATED','CREATED')`,
      [JSON.stringify({ actionId, eventId, outcome: "PARTIAL", success: false, failureReason: "ACTION_INTERRUPTED", interrupted: true, interruption }), active.decisionId]
    );
  }

  await createMemory({
    simulationId,
    entityId,
    eventId,
    type: "EPISODIC",
    content: `I stopped ${actionType.toLowerCase().replaceAll("_", " ")} because ${interruption.message}. I need to reconsider what to do next.`,
    importance: interruption.type === "CRITICAL_EVENT" ? 0.72 : 0.58,
    strength: interruption.type === "CRITICAL_EVENT" ? 0.78 : 0.58,
    confidence: 0.9,
    emotionalIntensity: 0.34,
    simulationAt: simulationTime,
    metadata: {
      kind: "action_interruption",
      actionType,
      interrupted: true,
      interruption,
      actionId,
      eventId,
      goalId: active.metadata?.goalId || null,
      planId: active.metadata?.planId || null,
      planStepId: active.metadata?.planStepId || null
    }
  });

  return true;
}

class SimulationEngine {
  constructor({ gemini, hub }) { this.gemini = gemini; this.hub = hub; this.running = new Set(); this.interval = null; this.tickCounter = new Map(); this.worldMaintenanceAt = new Map(); }
  async start() { if (this.interval) return; this.interval = setInterval(() => this.pulse().catch(err => logger.error(logger.contextError({ phase: "pulse" }, err, "engine pulse failed"))), env.ENGINE_INTERVAL_MS); await this.pulse(); }
  async stop({ drainTimeoutMs = 5000 } = {}) { if (this.interval) { clearInterval(this.interval); this.interval = null; } const deadline = Date.now() + Math.max(0, Number(drainTimeoutMs) || 5000); while (this.running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); if (this.running.size) logger.warn({ activeSimulations: this.running.size }, "engine shutdown timeout reached; stopping with active simulations"); }
  async pulse() { const simulations = await simRepo.listSimulations(); for (const sim of simulations) { if (sim.status !== "RUNNING" || this.running.has(sim.id)) continue; this.running.add(sim.id); this.runSimulation(sim).catch(err => logger.error(logger.contextError({ simulationId: sim.id, phase: "simulation" }, err, "simulation failed"))).finally(() => this.running.delete(sim.id)); } }
  async runSimulation(sim) {
    const context = { simulationId: sim.id, simulationVersion: sim.version, simulationTime: sim.currentSimulationAt || null };
    let tickId = null, phase = "clock", entityId = null, actionType = null;
    try {
      const clock = await simRepo.getActiveClock(sim.id); if (!clock) return;
      const nextTime = new Date(new Date(clock.simulationAnchorAt).getTime() + (Date.now() - new Date(clock.realAnchorAt).getTime()) * Number(clock.speed));
      const previousTime = new Date(sim.currentSimulationAt || clock.simulationAnchorAt); if (nextTime <= previousTime) return;
      const advanced = await simRepo.updateCurrentTimeOptimistic(sim.id, nextTime, sim.version); if (!advanced) return;
      context.simulationTime = nextTime.toISOString(); phase = "tick.create"; tickId = await simRepo.createTick(sim.id, nextTime, "AUTONOMOUS", env.ENGINE_VERSION);
      try {
        const elapsedMinutes = Math.min(360, Math.max(0, (nextTime - previousTime) / 60000));
        const lastMaintenance = this.worldMaintenanceAt.get(sim.id); const maintenanceDue = lastMaintenance === undefined || nextTime.getTime() - lastMaintenance >= 3600000;
        if (maintenanceDue) { phase = "world.initialize"; await ensureWorld(sim.id, nextTime); phase = "world.physical"; await seedPhysicalWorld(sim.id, nextTime); phase = "world.relationships"; await evolveRelationships(sim.id, nextTime); this.worldMaintenanceAt.set(sim.id, nextTime.getTime()); }
        phase = "world.events"; await generateWorldEvents(sim.id, nextTime, tickId, elapsedMinutes); const actors = await findAutonomousActors(sim.id, env.MAX_ENTITIES_PER_TICK);
        for (const id of actors) {
          entityId = id; actionType = null; phase = "entity.state"; await ensureEntityState(entityId, nextTime);
          const elapsedHours = Math.min(6, Math.max(0, (nextTime - previousTime) / 3600000)); const active = await getActiveAction(entityId, sim.id);
          if (active) {
            actionType = active.actionType; const actionStart = new Date(active.startedSimulationAt); const durationMinutes = Number(active.metadata?.durationMinutes || 30); const completionAt = new Date(actionStart.getTime() + durationMinutes * 60000);
            const eventId = active.metadata?.eventId || null; const targetEntityId = active.metadata?.targetEntityId || null; const targetLocationId = active.metadata?.targetLocationId || null; const relationshipIntent = active.metadata?.relationshipIntent || "NONE";
            const wasCompleted = nextTime >= completionAt; const updateTime = wasCompleted ? completionAt : nextTime; const updateHours = Math.min(6, Math.max(0, (updateTime - previousTime) / 3600000));
            phase = "entity.perception"; const perception = await perceive(sim.id, entityId, nextTime);
            phase = "entity.needs"; const needChanges = await updateNeeds(entityId, updateTime, updateHours, null, active.id, active.actionType);
            phase = "entity.emotions"; await applyEmotions(entityId, updateTime, needChanges, null, active.id, active.actionType, updateHours);
            phase = "entity.interruption"; const interruption = getInterruptionReason(active.actionType, await readNeeds(entityId), perception);
            if (interruption) {
              const interrupted = await interruptActiveAction({ simulationId: sim.id, entityId, active, simulationTime: updateTime, interruption });
              if (interrupted) {
                phase = "entity.publish";
                this.hub.publish(sim.id, "entity.state", { entityId, action: { ...active, status: "COMPLETED", interrupted: true }, status: "INTERRUPTED", interruption, needChanges });
                continue;
              }
            }
            if (wasCompleted) {
              phase = "entity.action.complete";
              const completion = await completeAction({ simulationId: sim.id, entityId, actionId: active.id, decisionId: active.decisionId, eventId, intentionId: active.intentionId, actionType: active.actionType, simulationTime: completionAt, targetEntityId, targetLocationId, relationshipIntent });
              if (!completion?.completed) { logger.warn({ simulationId: sim.id, entityId, actionId: active.id }, "action completion was not committed; skipping downstream learning"); continue; }
              const outcome = completion.outcome || "SUCCESS"; const successful = outcome === "SUCCESS";
              phase = "entity.emotions.outcome";
              const expectedOutcome = active.decisionId ? await getDecisionExpectedOutcome(active.decisionId) : null;
              const needRelief = needChanges.filter(change => Number(change.delta) < 0).reduce((sum, change) => sum + Math.abs(Number(change.delta)), 0);
              await applyEmotions(entityId, completionAt, needChanges, eventId, active.id, active.actionType, 0, { event: true, outcome, expectedOutcome, targetEntityId, targetLocationId, relationshipIntent, failureReason: completion.failureReason || null, meaning: active.metadata?.goalId ? (outcome === "SUCCESS" ? "GOAL_PROGRESS" : "GOAL_BLOCKED") : null, needRelief: Math.min(1, needRelief) });
              phase = "entity.goal";
              await completeGoalForAction(active.metadata?.goalId || null, active.actionType, completionAt, outcome, { simulationId: sim.id, entityId, actionId: active.id, targetEntityId, targetLocationId, ...completion });
              phase = "entity.learning"; if (successful) await learnFromAction(entityId, active.actionType, completionAt);
              phase = "entity.development"; if (successful) await updateDevelopment(sim.id, entityId, completionAt);
              phase = "entity.traits"; await developTraits(entityId, completionAt, { actionType: active.actionType, outcome, targetEntityId, relationshipIntent, goalId: active.metadata?.goalId || null, planId: active.metadata?.planId || null, planStepId: active.metadata?.planStepId || null, intentionId: active.intentionId, decisionId: active.decisionId }, eventId, active.id);
              phase = "entity.habit"; if (successful) await recordHabitEvidence({ entityId, simulationTime: completionAt, actionType: active.actionType });
              phase = "entity.cognition";
              const cognitive = await recordSignificantExperience({ simulationId: sim.id, entityId, simulationTime: completionAt, actionType: active.actionType, outcome, locationId: perception.location?.locationId || null, locationType: perception.location?.locationType || null, targetEntityId, resource: completion.resource || null, needChanges, relationshipIntent, consequence: outcome === "SUCCESS" ? "expected result obtained" : "intended result not fully obtained", learning: completion.resourceLearning?.type || completion.failureReason || null });
              phase = "entity.memory";
              const memoryPayload = outcome === "FAILURE"
                ? buildFailureMemory({ locationId: perception.location?.locationId || null, simulationTime: completionAt, actionType: active.actionType, perception, decision: { actionType: active.actionType, goalId: active.metadata?.goalId || null }, needChanges, physical: completion.resource, failureReason: completion.failureReason, resourceLearning: completion.resourceLearning })
                : buildActionMemory({ actionType: active.actionType, outcome, perception, decision: { actionType: active.actionType, goalId: active.metadata?.goalId || null }, needChanges, completion, simulationAt: completionAt });
              await createMemory({ simulationId: sim.id, entityId, eventId, locationId: perception.location?.locationId || null, type: "EPISODIC", content: memoryPayload.content, importance: memoryPayload.importance, strength: memoryPayload.strength, confidence: memoryPayload.confidence, emotionalIntensity: memoryPayload.emotionalIntensity, simulationAt: completionAt, metadata: { ...memoryPayload.metadata, actionId: active.id, eventId, durationMinutes, relationshipIntent, goalId: active.metadata?.goalId || null, planId: active.metadata?.planId || null, planStepId: active.metadata?.planStepId || null, cognitive } });
            }
            phase = "entity.mental_state"; if (["TALKING", "STUDYING", "WORKING", "EXPLORING"].includes(active.actionType)) await updateMentalState(sim.id, entityId, nextTime, { currentFocus: active.actionType.toLowerCase().replaceAll("_", " "), mentalLoad: ["WORKING", "STUDYING"].includes(active.actionType) ? 0.55 : 0.35, certainty: 0.7 });
            phase = "entity.publish"; this.hub.publish(sim.id, "entity.state", { entityId, action: { ...active, status: wasCompleted ? "COMPLETED" : "ACTIVE", startedSimulationAt: active.startedSimulationAt, expectedCompletionSimulationAt: completionAt, relationshipIntent }, needChanges }); continue;
          }
          phase = "entity.perception"; const perception = await perceive(sim.id, entityId, nextTime);
          phase = "entity.needs"; const needChanges = await updateNeeds(entityId, nextTime, elapsedHours);
          phase = "entity.emotions"; await applyEmotions(entityId, nextTime, needChanges, null, null, null, elapsedHours);
          phase = "entity.decision"; const decision = await actForEntity({ simulationId: sim.id, entityId, simulationTime: nextTime, gemini: this.gemini });
          if (!decision) { phase = "entity.publish"; this.hub.publish(sim.id, "entity.state", { entityId, decision: null, action: null, status: "IDLE", needChanges }); continue; }
          actionType = decision.actionType; phase = "entity.action.start";
          const action = await startAction({ simulationId: sim.id, entityId, decisionId: decision.decisionId, intentionId: decision.intentionId, actionType: decision.actionType, simulationTime: nextTime, targetEntityId: decision.targetEntityId || null, targetLocationId: decision.targetLocationId || null, relationshipIntent: decision.relationshipIntent || "NONE" });
          await pool.query(`UPDATE actions SET result=? WHERE id=UUID_TO_BIN(?)`, [JSON.stringify({ eventId: action.eventId, actionType: action.actionType, durationMinutes: action.durationMinutes, targetEntityId: decision.targetEntityId || null, targetLocationId: decision.targetLocationId || null, goalId: decision.goalId || null, planId: decision.planId || null, planStepId: decision.planStepId || null, relationshipIntent: decision.relationshipIntent || "NONE", expectedCompletionSimulationAt: action.expectedCompletionSimulationAt, movement: action.movement || null }), action.actionId]);
          phase = "entity.publish"; this.hub.publish(sim.id, "entity.state", { entityId, decision, action, status: "ACTIVE", needChanges });
        }
        phase = "memory.decay"; await decayMemories(sim.id, nextTime); const count = (this.tickCounter.get(sim.id) || 0) + 1; this.tickCounter.set(sim.id, count);
        if (count % 600 === 0) { phase = "asami.proactive_conversation"; const asami = await entityRepo.getAsamiCandidate(sim.id); if (asami) await initiateConversation({ simulationId: sim.id, asamiEntityId: asami.id, simulationTime: nextTime, gemini: this.gemini, hub: this.hub }); }
        if (count % env.SNAPSHOT_EVERY_TICKS === 0) { phase = "snapshot"; const snapshot = await buildSnapshot(sim.id, nextTime); await simRepo.createSnapshot(sim.id, nextTime, snapshot, 1); }
        phase = "tick.finish"; await simRepo.finishTick(tickId, "COMPLETED"); this.hub.publish(sim.id, "simulation.tick", { tickId, simulationTime: nextTime });
      } catch (err) { const errorContext = { ...context, tickId, phase, entityId, actionType }; try { await simRepo.finishTick(tickId, "FAILED"); } catch (finishErr) { logger.error(logger.contextError({ ...errorContext, secondaryFailure: "finishTick" }, finishErr, "failed to mark simulation tick failed")); } throw Object.assign(err, { simulationContext: errorContext }); }
    } catch (err) { const mergedContext = { ...context, ...(err.simulationContext || {}), phase, entityId, actionType }; logger.error(logger.contextError(mergedContext, err, "simulation failed")); throw err; }
  }
}

async function getDecisionExpectedOutcome(decisionId) {
  const [rows] = await pool.query(`SELECT expected_outcome AS expectedOutcome FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1`, [decisionId]);
  if (!rows.length) return null;
  const value = rows[0].expectedOutcome;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString());
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return value; } }
  return value || null;
}

async function buildSnapshot(simulationId, simulationTime) { const actors = await entityRepo.listActors(simulationId, env.MAX_ENTITIES_PER_TICK); const entities = []; for (const actor of actors) { const dashboard = await entityRepo.getDashboard(simulationId, actor.id); entities.push({ entity: dashboard.entity, needs: dashboard.needs, emotions: dashboard.emotions, traits: dashboard.traits, location: dashboard.location, currentAction: dashboard.currentAction }); } return { simulationId, simulationTime, entities }; }
module.exports = { SimulationEngine, buildSnapshot, getCriticalInterruptionNeed, getCriticalInterruptionEvent, getInterruptionReason, interruptActiveAction };