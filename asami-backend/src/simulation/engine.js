const logger = require("../lib/logger");
const { env } = require("../config/env");
const { pool } = require("../db/pool");
const simRepo = require("../repositories/simulation-repo");
const entityRepo = require("../repositories/entity-repo");
const { ensureEntityState, updateNeeds, applyEmotions, developTraits } = require("../services/state-service");
const { findAutonomousActors, actForEntity, completeGoalForAction } = require("../services/autonomy-service");
const { perceive } = require("../services/perception-service");
const { startAction, completeAction, getActiveAction, learnFromAction } = require("../services/action-service");
const { createMemory, decayMemories } = require("../services/memory-service");
const { generateWorldEvents } = require("../services/world-service");
const { ensureWorld, evolveRelationships } = require("../services/world-population-service");
const { seedPhysicalWorld } = require("../services/physical-world-service");
const { updateDevelopment } = require("../services/development-service");
const { initiateConversation } = require("../services/chat-service");
const { recordHabitEvidence } = require("../services/habit-service");
const { updateMentalState } = require("../services/personality-service");

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
            if (wasCompleted) {
              phase = "entity.action.complete";
              const completion = await completeAction({ simulationId: sim.id, entityId, actionId: active.id, decisionId: active.decisionId, eventId, intentionId: active.intentionId, actionType: active.actionType, simulationTime: completionAt, targetEntityId, targetLocationId, relationshipIntent });
              if (!completion?.completed) { logger.warn({ simulationId: sim.id, entityId, actionId: active.id }, "action completion was not committed; skipping downstream learning"); continue; }
              const outcome = completion.outcome || "SUCCESS"; const successful = outcome === "SUCCESS";
              phase = "entity.goal";
              await completeGoalForAction(active.metadata?.goalId || null, active.actionType, completionAt, outcome, { simulationId: sim.id, entityId, actionId: active.id, targetEntityId, targetLocationId, ...completion });
              phase = "entity.learning"; if (successful) await learnFromAction(entityId, active.actionType, completionAt);
              phase = "entity.development"; if (successful) await updateDevelopment(sim.id, entityId, completionAt);
              phase = "entity.traits"; if (successful) await developTraits(entityId, completionAt, signalForDecision(active.actionType), null, active.id);
              phase = "entity.habit"; if (successful) await recordHabitEvidence({ entityId, simulationTime: completionAt, actionType: active.actionType });
              phase = "entity.memory";
              if (outcome !== "FAILURE") await createMemory({ simulationId: sim.id, entityId, eventId, content: buildActionMemoryContent(active, completion), importance: outcome === "PARTIAL" ? 0.6 : 0.45, strength: 0.9, confidence: 0.8, emotionalIntensity: outcome === "PARTIAL" ? 0.3 : 0.25, simulationAt: completionAt, metadata: { actionType: active.actionType, outcome, success: completion.success, failureReason: completion.failureReason || null, resource: completion.resource || null, resourceLearning: completion.resourceLearning || null, perceptionSummary: perception.location || null, durationMinutes, relationshipIntent } });
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

function buildActionMemoryContent(action, completion) {
  const actionLabel = action.actionType.toLowerCase().replaceAll("_", " ");
  if (completion.outcome === "PARTIAL") return `I tried to ${actionLabel}, but only part of the expected result was achieved. I should consider this outcome in future decisions.`;
  return `I completed ${actionLabel} successfully. This experience can inform future decisions.`;
}

function signalForDecision(action) { return { TALKING: { EXTRAVERSION: 1, SOCIABILITY: 1, EMPATHY: 0.2 }, EXPLORING: { OPENNESS: 1, CURIOSITY: 1, CONFIDENCE: 0.2 }, STUDYING: { CONSCIENTIOUSNESS: 1, DISCIPLINE: 1, PATIENCE: 0.4 }, WORKING: { CONSCIENTIOUSNESS: 1, DISCIPLINE: 1 }, PLAYING: { OPENNESS: 0.4, IMPULSIVITY: 0.3 }, WALKING: { OPENNESS: 0.3 }, READING: { OPENNESS: 0.4, CURIOSITY: 0.6 }, SLEEPING: { PATIENCE: 0.2 }, RESTING: { PATIENCE: 0.2 }, EATING: { SELF_CARE: 0.2 }, DRINKING: { SELF_CARE: 0.2 }, WATCHING: { OPENNESS: 0.1 } }[action] || {}; }
async function buildSnapshot(simulationId, simulationTime) { const actors = await entityRepo.listActors(simulationId, env.MAX_ENTITIES_PER_TICK); const entities = []; for (const actor of actors) { const dashboard = await entityRepo.getDashboard(simulationId, actor.id); entities.push({ entity: dashboard.entity, needs: dashboard.needs, emotions: dashboard.emotions, traits: dashboard.traits, location: dashboard.location, currentAction: dashboard.currentAction }); } return { simulationId, simulationTime, entities }; }
module.exports = { SimulationEngine, signalForDecision, buildSnapshot, buildActionMemoryContent };
