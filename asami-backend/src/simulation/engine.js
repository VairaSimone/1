const logger = require("../lib/logger");
const { env } = require("../config/env");
const { pool, pingWithRetry, getDatabaseHealth } = require("../db/pool");
const simRepo = require("../repositories/simulation-repo");
const { getAsamiCandidate } = require("../repositories/entity-repo");
const { ensureEntityState, updateNeeds, applyEmotions, developTraits, readNeeds, flushPendingNeedHistory } = require("../services/state-service");
const autonomyService = require("../services/autonomy-service");
const { perceive } = require("../services/perception-service");
const actionService = require("../services/action-service");
const { createMemory, decayMemories, buildActionMemory, buildFailureMemory } = require("../services/memory-service");
const { generateWorldEvents } = require("../services/world-service");
const { ensureWorld, evolveRelationships } = require("../services/world-population-service");
const { seedPhysicalWorld, ensureCriticalResourceAvailability, maintainDistributedResources } = require("../services/physical-world-service");
const { updateDevelopment } = require("../services/development-service");
const { initiateConversation } = require("../services/chat-service");
const { recordHabitEvidence } = require("../services/habit-service");
const { refreshMentalStateFromSimulation } = require("../services/personality-service");
const { recordSignificantExperience } = require("../services/experience-learning-service");
const { maybeRunSafeRetention } = require("../services/safe-retention-service");
const { reconcileCompletedActions } = require("../services/action-reconciliation-service");
const { runSimulationIntegrityCheck } = require("../services/integrity-check-service");
const observability = require("../services/simulation-observability");

const INTERRUPTIBLE_ACTIONS = new Set(["SLEEPING", "WORKING", "STUDYING"]);
const CRITICAL_EVENT_PATTERNS = /DANGER|EMERGENCY|ACCIDENT|THREAT|CRISIS|EVACUATION|ATTACK|FIRE/i;
const EXPECTED_ENTITY_CONDITION_CODES = new Set(["MOVEMENT_ORIGIN_REQUIRED","MOVEMENT_DESTINATION_REQUIRED","MOVEMENT_DESTINATION_UNREACHABLE","MOVEMENT_ALREADY_ACTIVE"]);
function isExpectedEntityCondition(err){return EXPECTED_ENTITY_CONDITION_CODES.has(String(err?.code||"").toUpperCase());}
function isCriticalResourceRecoveryUnavailable(err){return String(err?.code||"").toUpperCase()==="CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE";}

function getNeedDirection(code) {
  const normalized = String(code || "").toUpperCase();
  if (["HUNGER", "THIRST", "SLEEPINESS", "SOCIAL_NEED", "FUN", "CURIOSITY", "ACHIEVEMENT", "BELONGING"].includes(normalized)) return "HIGH";
  if (["ENERGY", "SAFETY"].includes(normalized)) return "LOW";
  return null;
}

function isCriticalNeed(code, value) {
  const normalized = String(code || "").toUpperCase();
  const thresholds = { THIRST: 0.8, HUNGER: 0.8, SLEEPINESS: 0.85, ENERGY: 0.15, SAFETY: 0.2 };
  const threshold = thresholds[normalized];
  if (threshold === undefined || !Number.isFinite(Number(value))) return false;
  const direction = getNeedDirection(normalized);
  return direction === "HIGH" ? Number(value) >= threshold : Number(value) <= threshold;
}

function getCriticalInterruptionNeed(activeActionType, needs = []) {
  if (!INTERRUPTIBLE_ACTIONS.has(String(activeActionType || "").toUpperCase())) return null;
  let selected = null;
  for (const need of needs) {
    const code = String(need.code || "").toUpperCase(), value = Number(need.value);
    if (!isCriticalNeed(code, value)) continue;
    const compatible = {
      THIRST: new Set(["DRINKING"]),
      HUNGER: new Set(["EATING"]),
      SLEEPINESS: new Set(["SLEEPING"]),
      ENERGY: new Set(["SLEEPING", "RESTING"]),
      SAFETY: new Set([])
    }[code];
    if (compatible?.has(String(activeActionType).toUpperCase())) continue;
    const distance = getNeedDirection(code) === "HIGH" ? value : 1 - value;
    if (!selected || distance > selected.distance) selected = { code, value, threshold: ({ THIRST: 0.8, HUNGER: 0.8, SLEEPINESS: 0.85, ENERGY: 0.15, SAFETY: 0.2 })[code], distance };
  }
  return selected;
}

function getCriticalInterruptionEvent(perception) {
  const events = Array.isArray(perception?.recentEvents) ? perception.recentEvents : [];
  for (const event of events) {
    const type = String(event?.type || ""), title = String(event?.title || ""), description = String(event?.description || ""), importance = Number(event?.importance);
    if ((Number.isFinite(importance) && importance >= 0.9) || CRITICAL_EVENT_PATTERNS.test(`${type} ${title} ${description}`)) return { id: event?.id || null, type, title, importance: Number.isFinite(importance) ? importance : null };
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

async function interruptActiveAction({ simulationId, entityId, active, simulationTime, interruption, needChanges = [], perception = null }) {
  const actionId = active.id, actionType = String(active.actionType || "ACTION").toUpperCase(), eventId = active.metadata?.eventId || null;
  const result = { eventId, actionType, outcome: "PARTIAL", success: false, failureReason: "ACTION_INTERRUPTED", interrupted: true, interruption, targetEntityId: active.metadata?.targetEntityId || null, targetLocationId: active.metadata?.targetLocationId || null, relationshipIntent: active.metadata?.relationshipIntent || "NONE" };
  const [updated] = await pool.query(`UPDATE actions SET status='INTERRUPTED',completed_simulation_at=?,result=? WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'`, [simulationTime, JSON.stringify(result), actionId, entityId, simulationId]);
  if (!updated.affectedRows) return false;
  const movementId = active.metadata?.movement?.movementId || null;
  if (movementId) await pool.query(`UPDATE movements SET status='INTERRUPTED',actual_arrival_simulation_at=NULL,reason='autonomous route interrupted by critical state',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`, [movementId]);
  if (active.intentionId) await pool.query(`UPDATE intentions SET status='CANCELLED',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`, [active.intentionId]);
  if (active.decisionId) await pool.query(
    `UPDATE decisions
     SET status='EXECUTED',actual_outcome=?
     WHERE id=UUID_TO_BIN(?) AND status IN ('EVALUATED','CREATED')`,
    [JSON.stringify({
      actionId,
      eventId,
      outcome: "PARTIAL",
      success: false,
      failureReason: "ACTION_INTERRUPTED",
      interrupted: true,
      interruption,
      actionSummary: actionService.buildDecisionActionSummary({
        actionId,
        decisionId: active.decisionId,
        actionType,
        status: "INTERRUPTED",
        simulationTime,
        targetEntityId: active.metadata?.targetEntityId || null,
        targetLocationId: active.metadata?.targetLocationId || null,
        relationshipIntent: active.metadata?.relationshipIntent || "NONE",
        outcome: "PARTIAL",
        success: false,
        failureReason: "ACTION_INTERRUPTED",
        eventId,
        intentionId: active.intentionId,
        result
      })
    }), active.decisionId]
  );

  const cognitive = await recordSignificantExperience({
    simulationId,
    entityId,
    simulationTime,
    actionType,
    outcome: "PARTIAL",
    locationId: perception?.location?.locationId || active.metadata?.targetLocationId || null,
    locationType: perception?.location?.locationType || null,
    targetEntityId: active.metadata?.targetEntityId || null,
    resource: null,
    needChanges,
    relationshipIntent: active.metadata?.relationshipIntent || "NONE",
    consequence: "action interrupted by a critical internal or world state",
    learning: interruption.code || interruption.type,
    interrupted: true
  });

  await createMemory({
    simulationId,
    entityId,
    eventId,
    type: "EPISODIC",
    content: `I stopped ${actionType.toLowerCase().replaceAll("_", " ")} because ${interruption.message}. I need to reconsider what to do next.`,
    importance: interruption.type === "CRITICAL_EVENT" ? 0.78 : 0.66,
    strength: interruption.type === "CRITICAL_EVENT" ? 0.82 : 0.68,
    confidence: 0.95,
    emotionalIntensity: 0.4,
    simulationAt: simulationTime,
    metadata: { kind: "action_interruption", actionType, interrupted: true, interruption, actionId, eventId, goalId: active.metadata?.goalId || null, planId: active.metadata?.planId || null, planStepId: active.metadata?.planStepId || null, cognitiveRefs: { preferenceIds: Array.isArray(cognitive?.preferenceIds) ? cognitive.preferenceIds.slice(0, 8) : [], beliefId: cognitive?.beliefId || null, knowledgeId: cognitive?.knowledgeId || null, learningStrength: Number.isFinite(Number(cognitive?.learningStrength)) ? Number(Number(cognitive.learningStrength).toFixed(4)) : null, semanticBeliefId: cognitive?.semantic?.beliefId || null, semanticPreferenceId: cognitive?.semantic?.preferenceId || null, semanticReliability: Number.isFinite(Number(cognitive?.semantic?.reliability)) ? Number(Number(cognitive.semantic.reliability).toFixed(4)) : null } }
  });
  await applyEmotions(entityId, simulationTime, needChanges, eventId, actionId, actionType, 0, { event: true, outcome: "PARTIAL", expectedOutcome: null, targetEntityId: active.metadata?.targetEntityId || null, targetLocationId: active.metadata?.targetLocationId || null, relationshipIntent: active.metadata?.relationshipIntent || "NONE", failureReason: "ACTION_INTERRUPTED" });
  await flushPendingNeedHistory(entityId, actionId);
  await autonomyService.completeGoalForAction(active.metadata?.goalId || null, actionType, simulationTime, "PARTIAL", result);
  await actionService.markActionPostProcessingComplete(actionId);
  return true;
}

class SimulationEngine {
  constructor({ gemini, hub }) { this.gemini = gemini; this.hub = hub; this.running = new Set(); this.interval = null; this.tickCounter = new Map(); this.worldMaintenanceAt = new Map(); this.pulseInFlight = false; }
  async start() { if (this.interval) return; this.interval = setInterval(() => this.pulse().catch(err => logger.error(logger.contextError({ phase: "pulse" }, err, "engine pulse failed"))), env.ENGINE_INTERVAL_MS); await this.pulse(); }
  async stop({ drainTimeoutMs = 5000 } = {}) { if (this.interval) { clearInterval(this.interval); this.interval = null; } const timeout = Math.max(0, Number(drainTimeoutMs) || 5000); const deadline = Date.now() + timeout; while (this.running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); const drained = this.running.size === 0; if (!drained) logger.warn({ activeSimulations: this.running.size }, "engine shutdown timeout reached; simulations still running"); return drained; }
  async pulse() {
    if (this.pulseInFlight) return;
    this.pulseInFlight = true;
    try {
      const healthy = await pingWithRetry({ attempts: Math.min(3, Number(env.DB_RETRY_ATTEMPTS) || 3), throwNonTransient: true });
      if (!healthy) {
        logger.warn({ database: getDatabaseHealth() }, "database degraded; skipping engine pulse");
        return;
      }
      const simulations = await simRepo.listSimulations();
      const maxConcurrent=Math.max(1,Number(env.MAX_CONCURRENT_SIMULATIONS)||1);
      let queueDepth=0;
      for (const sim of simulations) {
        if (sim.status !== "RUNNING" || this.running.has(sim.id)) continue;
        if (this.running.size >= maxConcurrent) {
          queueDepth+=1;
          continue;
        }
        this.running.add(sim.id);
        this.runSimulation(sim)
          .catch(err => logger.error(logger.contextError({ simulationId: sim.id, phase: "simulation" }, err, "simulation failed")))
          .finally(() => this.running.delete(sim.id));
      }
      observability.setGauge("global","simulation_queue_depth",queueDepth);
    } finally {
      this.pulseInFlight = false;
    }
  }
  async runSimulation(sim) {
    const runtimeContext={simulationId:sim.id,tickId:null,tickQueryCount:0};
    return observability.runWithContext(runtimeContext,async()=>{
    const context = { simulationId: sim.id, simulationVersion: sim.version, simulationTime: sim.currentSimulationAt || null };
    let tickId = null, phase = "clock", entityId = null, actionType = null;
    const setPhase = nextPhase => { phase = nextPhase; runtimeContext.phase = nextPhase; };
    runtimeContext.phase = phase;
    try {
      const clock = await simRepo.getActiveClock(sim.id); if (!clock) return;
      const nextTime = new Date(new Date(clock.simulationAnchorAt).getTime() + (Date.now() - new Date(clock.realAnchorAt).getTime()) * Number(clock.speed));
      const previousTime = new Date(sim.currentSimulationAt || clock.simulationAnchorAt); if (nextTime <= previousTime) return;
      const dbReady = await pingWithRetry({ attempts: Math.min(2, Number(env.DB_RETRY_ATTEMPTS) || 2), throwNonTransient: true });
      if (!dbReady) {
        logger.warn({ simulationId: sim.id, database: getDatabaseHealth() }, "database degraded; tick creation skipped");
        return;
      }
      tickId = await simRepo.advanceAndCreateTick(sim.id, nextTime, sim.version, "AUTONOMOUS", env.ENGINE_VERSION); if (!tickId) return;
      runtimeContext.tickId=tickId;
      runtimeContext.tickQueryCount=0;
      context.simulationTime = nextTime.toISOString(); setPhase("tick.create");
      try {
        const elapsedMinutes = Math.min(10080, Math.max(0, (nextTime - previousTime) / 60000));
        const lastMaintenance = this.worldMaintenanceAt.get(sim.id); const maintenanceDue = lastMaintenance === undefined || nextTime.getTime() - lastMaintenance >= 3600000;
        if (maintenanceDue) {
          setPhase("world.initialize");
          await ensureWorld(sim.id, nextTime);
          setPhase("world.physical");
          await seedPhysicalWorld(sim.id, nextTime);
          setPhase("world.resource_distribution");
          const distributedResources = await maintainDistributedResources(sim.id, nextTime.toISOString());
          if (distributedResources.replenished.length) {
            logger.info({
              simulationId: sim.id,
              simulationTime: nextTime.toISOString(),
              replenishedLocations: distributedResources.replenished.length,
              resources: distributedResources.replenished
            }, "distributed resource maintenance applied");
          }
          setPhase("world.relationships");
          await evolveRelationships(sim.id, nextTime);
          setPhase("action.reconcile");
          const reconciliation = await reconcileCompletedActions(sim.id,{limit:100});
          if (reconciliation.reconciled) {
            logger.info({simulationId:sim.id,simulationTime:nextTime.toISOString(),event:"ACTION_RECONCILIATION",reconciled:reconciliation.reconciled},"completed action post-processing reconciled");
          }
          setPhase("integrity.check");
          const integrity = await runSimulationIntegrityCheck(sim.id,nextTime.toISOString());
          if(!integrity.skipped && !integrity.healthy){
            const violations=Array.isArray(integrity.violations)?integrity.violations:[];
            observability.increment(sim.id,"integrity_violation_total",violations.reduce((sum,item)=>sum+Number(item.count||0),0));
          }
          this.worldMaintenanceAt.set(sim.id, nextTime.getTime());
          observability.logSnapshot(sim.id,nextTime.toISOString());
        }
        setPhase("world.events"); await generateWorldEvents(sim.id, nextTime, tickId, elapsedMinutes);
        setPhase("world.resource_invariant");
        const resourceInvariant = await ensureCriticalResourceAvailability(sim.id, nextTime.toISOString());
        if (resourceInvariant.recovered.length) {
          observability.recordResourceEmergency(sim.id,resourceInvariant.recovered);
          logger.warn({
            simulationId: sim.id,
            simulationTime: nextTime.toISOString(),
            event:"RESOURCE_EMERGENCY",
            recoveredResources: resourceInvariant.recovered
          }, "critical resource emergency recovery applied");
        }
        const actors = await autonomyService.findAutonomousActors(sim.id, env.MAX_ENTITIES_PER_TICK);
        let autonomyBatchContext=null;
        try {
          setPhase("autonomy.context.batch");
          autonomyBatchContext=await autonomyService.prepareTickAutonomyContext({simulationId:sim.id,entityIds:actors,simulationTime:nextTime.toISOString()});
          logger.debug({simulationId:sim.id,simulationTime:nextTime.toISOString(),actorCount:actors.length,batchActorCount:autonomyBatchContext?.contexts?.size||0},"autonomy tick context prepared in batch");
        } catch(batchError) {
          autonomyBatchContext=null;
          logger.warn(logger.contextError({simulationId:sim.id,phase:"autonomy.context.batch"},batchError,"batched autonomy context unavailable; falling back to per-actor context loading"));
        }
        for (const id of actors) {
          let actorHadActivity=false;
          try {
          entityId = id; actionType = null; setPhase("entity.state"); await ensureEntityState(entityId, nextTime);
          const elapsedHours = Math.min(168, Math.max(0, (nextTime - previousTime) / 3600000)); const active = await actionService.getActiveAction(entityId, sim.id);
          if (active) {
            actorHadActivity=true;
            actionType = active.actionType; const actionStart = new Date(active.startedSimulationAt); const durationMinutes = Number(active.metadata?.durationMinutes || 30); const completionAt = new Date(actionStart.getTime() + durationMinutes * 60000);
            const eventId = active.metadata?.eventId || null; const targetEntityId = active.metadata?.targetEntityId || null; const targetLocationId = active.metadata?.targetLocationId || null; const relationshipIntent = active.metadata?.relationshipIntent || "NONE";
            const wasCompleted = nextTime >= completionAt; const updateTime = wasCompleted ? completionAt : nextTime; const updateHours = Math.min(168, Math.max(0, (updateTime - previousTime) / 3600000));
            setPhase("entity.perception"); const perception = await perceive(sim.id, entityId, nextTime);
            setPhase("entity.needs"); const needChanges = await updateNeeds(entityId, updateTime, updateHours, null, active.id, active.actionType, { significant: wasCompleted, perception });
            setPhase("entity.emotions"); await applyEmotions(entityId, updateTime, needChanges, null, active.id, active.actionType, updateHours);
            setPhase("entity.interruption"); const interruption = !wasCompleted ? getInterruptionReason(active.actionType, await readNeeds(entityId), perception) : null;
            if (interruption) {
              const interrupted = await interruptActiveAction({ simulationId: sim.id, entityId, active, simulationTime: updateTime, interruption, needChanges, perception });
              if (interrupted) {
                setPhase("entity.mental_state");
                await refreshMentalStateFromSimulation({
                  simulationId: sim.id,
                  entityId,
                  simulationTime: updateTime,
                  needs: await readNeeds(entityId),
                  activeActionType: null
                });
                setPhase("entity.publish");
                this.hub.publish(sim.id, "entity.state", {
                  entityId,
                  action: { ...active, status: "INTERRUPTED", interrupted: true },
                  status: "INTERRUPTED",
                  interruption,
                  needChanges
                });
                continue;
              }
            }
            if (wasCompleted) {
              setPhase("entity.action.complete");
              const completion = await actionService.completeAction({ simulationId: sim.id, entityId, actionId: active.id, decisionId: active.decisionId, eventId, intentionId: active.intentionId, actionType: active.actionType, simulationTime: completionAt, targetEntityId, targetLocationId, relationshipIntent });
              if (!completion?.completed) { logger.warn({ simulationId: sim.id, entityId, actionId: active.id }, "action completion was not committed; skipping downstream learning"); continue; }
              const outcome = completion.outcome || "SUCCESS"; const successful = outcome === "SUCCESS";
              setPhase("entity.emotions.outcome");
              const expectedOutcome = active.decisionId ? await getDecisionExpectedOutcome(active.decisionId) : null;
              const needRelief = needChanges.filter(change => Number(change.delta) < 0).reduce((sum, change) => sum + Math.abs(Number(change.delta)), 0);
              await applyEmotions(entityId, completionAt, needChanges, eventId, active.id, active.actionType, 0, { event: true, outcome, expectedOutcome, targetEntityId, targetLocationId, relationshipIntent, failureReason: completion.failureReason || null, meaning: active.metadata?.goalId ? (outcome === "SUCCESS" ? "GOAL_PROGRESS" : "GOAL_BLOCKED") : null, needRelief: Math.min(1, needRelief) });
              setPhase("entity.goal"); await autonomyService.completeGoalForAction(active.metadata?.goalId || null, active.actionType, completionAt, outcome, { simulationId: sim.id, entityId, actionId: active.id, targetEntityId, targetLocationId, ...completion });
              setPhase("entity.learning"); if (successful) await actionService.learnFromAction(entityId, active.actionType, completionAt);
              setPhase("entity.development"); if (successful) await updateDevelopment(sim.id, entityId, completionAt, active.actionType);
              setPhase("entity.traits"); await developTraits(entityId, completionAt, { actionType: active.actionType, outcome, targetEntityId, relationshipIntent, goalId: active.metadata?.goalId || null, planId: active.metadata?.planId || null, planStepId: active.metadata?.planStepId || null, intentionId: active.intentionId, decisionId: active.decisionId }, eventId, active.id);
              setPhase("entity.habit"); if (successful) await recordHabitEvidence({ entityId, simulationTime: completionAt, actionType: active.actionType });
              setPhase("entity.cognition"); const cognitive = await recordSignificantExperience({ simulationId: sim.id, entityId, simulationTime: completionAt, actionType: active.actionType, outcome, locationId: perception.location?.locationId || null, locationType: perception.location?.locationType || null, targetEntityId, resource: completion.resource || null, needChanges, relationshipIntent, consequence: outcome === "SUCCESS" ? "expected result obtained" : "intended result not fully obtained", learning: completion.resourceLearning?.type || completion.failureReason || null });
              setPhase("entity.memory");
              const memoryPayload = outcome === "FAILURE" ? buildFailureMemory({ locationId: perception.location?.locationId || null, simulationTime: completionAt, actionType: active.actionType, perception, decision: { actionType: active.actionType, goalId: active.metadata?.goalId || null }, needChanges, physical: completion.resource, failureReason: completion.failureReason, resourceLearning: completion.resourceLearning }) : buildActionMemory({ actionType: active.actionType, outcome, perception, decision: { actionType: active.actionType, goalId: active.metadata?.goalId || null }, needChanges, completion, simulationAt: completionAt });
              await createMemory({ simulationId: sim.id, entityId, eventId, locationId: perception.location?.locationId || null, type: "EPISODIC", content: memoryPayload.content, importance: memoryPayload.importance, strength: memoryPayload.strength, confidence: memoryPayload.confidence, emotionalIntensity: memoryPayload.emotionalIntensity, simulationAt: completionAt, metadata: { ...memoryPayload.metadata, actionId: active.id, eventId, durationMinutes, relationshipIntent, goalId: active.metadata?.goalId || null, planId: active.metadata?.planId || null, planStepId: active.metadata?.planStepId || null, cognitiveRefs: { preferenceIds: Array.isArray(cognitive?.preferenceIds) ? cognitive.preferenceIds.slice(0, 8) : [], beliefId: cognitive?.beliefId || null, knowledgeId: cognitive?.knowledgeId || null, learningStrength: Number.isFinite(Number(cognitive?.learningStrength)) ? Number(Number(cognitive.learningStrength).toFixed(4)) : null, semanticBeliefId: cognitive?.semantic?.beliefId || null, semanticPreferenceId: cognitive?.semantic?.preferenceId || null, semanticReliability: Number.isFinite(Number(cognitive?.semantic?.reliability)) ? Number(Number(cognitive.semantic.reliability).toFixed(4)) : null } } });
              // A large simulation jump can finish the active action long before nextTime.
              // Advance the passive state for the remainder so needs/emotions never freeze
              // at the action completion timestamp.
              const postActionGapHours = Math.min(168, Math.max(0, (nextTime - completionAt) / 3600000));
              if (postActionGapHours > 0.0001) {
                setPhase("entity.gap.catchup");
                const passiveNeedChanges = await updateNeeds(entityId, nextTime, postActionGapHours, null, null, null, { significant: false });
                await applyEmotions(entityId, nextTime, passiveNeedChanges, null, null, null, postActionGapHours);
              }
            }
            if (wasCompleted) {
              setPhase("entity.post_processing.commit");
              await actionService.markActionPostProcessingComplete(active.id);
            }
            setPhase("entity.mental_state");
            const latestNeeds = await readNeeds(entityId);
            await refreshMentalStateFromSimulation({
              simulationId: sim.id,
              entityId,
              simulationTime: nextTime,
              needs: latestNeeds,
              activeActionType: wasCompleted ? null : active.actionType
            });
            setPhase("entity.publish"); this.hub.publish(sim.id, "entity.state", { entityId, action: { ...active, status: wasCompleted ? "COMPLETED" : "ACTIVE" }, needChanges });
          } else {
            if (elapsedHours > 0.0001) {
              setPhase("entity.gap.catchup");
              const passiveNeedChanges = await updateNeeds(entityId, nextTime, elapsedHours, null, null, null, { significant: false });
              await applyEmotions(entityId, nextTime, passiveNeedChanges, null, null, null, elapsedHours);
            }
            setPhase("entity.mental_state");
            const latestNeeds = await readNeeds(entityId);
            await refreshMentalStateFromSimulation({
              simulationId: sim.id,
              entityId,
              simulationTime: nextTime,
              needs: latestNeeds,
              activeActionType: null
            });
            setPhase("entity.autonomy");
            const autonomy = await autonomyService.actForEntity({ simulationId: sim.id, entityId, simulationTime: nextTime.toISOString(), gemini: this.gemini, tickId, batchContext: autonomyBatchContext });
            if (!autonomy) continue;
            const decision = autonomy.decision;
            if (!decision?.actionType) throw Object.assign(new Error("Autonomy produced no executable action type"), { code: "AUTONOMY_ACTION_TYPE_REQUIRED" });
            actionType = decision.actionType;
            setPhase("entity.action.start");
            const started = autonomy.started || null;
            if (!started?.actionId) throw Object.assign(new Error("Autonomy action was not started"), { code: "AUTONOMY_ACTION_START_REQUIRED" });
            actorHadActivity=true;
            await refreshMentalStateFromSimulation({
              simulationId: sim.id,
              entityId,
              simulationTime: nextTime,
              needs: latestNeeds,
              activeActionType: started.actionType||decision.actionType
            });
            this.hub.publish(sim.id, "action.created", { entityId, decision, action: started });
          }
          } catch (err) {
            const errorContext={simulationId:sim.id,entityId,actionType,phase};
            if (isCriticalResourceRecoveryUnavailable(err)) {
              logger.warn(logger.contextError({
                ...errorContext,
                resource: err.resource || null,
                needCode: err.needCode || null
              }, err, "critical resource condition; attempting emergency recovery"));

              try {
                setPhase("entity.resource_emergency");
                const recovery = await ensureCriticalResourceAvailability(
                  sim.id,
                  nextTime.toISOString(),
                  { entityId: id, resources: [err.resource || "water"] }
                );

                if (recovery.recovered.length) {
                  observability.recordResourceEmergency(sim.id,recovery.recovered);
                  logger.warn({
                    simulationId: sim.id,
                    entityId: id,
                    simulationTime: nextTime.toISOString(),
                    event:"RESOURCE_EMERGENCY",
                    recoveredResources: recovery.recovered
                  }, "entity resource emergency restored");
                }

                setPhase("entity.resource_emergency.retry");
                const retry = await autonomyService.actForEntity({
                  simulationId: sim.id,
                  entityId: id,
                  simulationTime: nextTime.toISOString(),
                  gemini: this.gemini,
                  tickId,
                  batchContext: autonomyBatchContext
                });

                if (retry?.decision?.actionType && retry?.started?.actionId) {
                  actionType = retry.decision.actionType;
                  actorHadActivity=true;
                  await refreshMentalStateFromSimulation({
                    simulationId: sim.id,
                    entityId: id,
                    simulationTime: nextTime,
                    needs: await readNeeds(id),
                    activeActionType: retry.started.actionType||retry.decision.actionType
                  });
                  this.hub.publish(sim.id, "action.created", {
                    entityId: id,
                    decision: retry.decision,
                    action: retry.started
                  });
                  continue;
                }

                observability.recordRecoveryFailed(sim.id);
                logger.error({
                  simulationId: sim.id,
                  entityId: id,
                  simulationTime: nextTime.toISOString(),
                  event:"RECOVERY_FAILED",
                  recoveryHealthy: recovery.healthy,
                  resource: err.resource || null
                }, "critical resource recovery did not produce an executable action");
              } catch (recoveryError) {
                observability.recordRecoveryFailed(sim.id);
                logger.error(logger.contextError({
                  ...errorContext,
                  phase,
                  event:"RECOVERY_FAILED",
                  recoveryResource: err.resource || null
                }, recoveryError, "critical resource emergency recovery failed"));
              }
            } else if (String(err?.code||"").toUpperCase()==="CRITICAL_ACTION_UNAVAILABLE") {
              logger.warn(logger.contextError(errorContext,err,"critical action unavailable; actor remains active for the next tick"));
            } else if (isExpectedEntityCondition(err)) {
              logger.debug(logger.contextError(errorContext,err,"expected entity condition; actor skipped for this tick"));
            } else {
              logger.error(logger.contextError(errorContext,err,"entity tick failed; actor skipped"));
            }
          } finally {
            try {
              const needsForObservability=await readNeeds(id);
              const criticalNeed=needsForObservability.some(need=>isCriticalNeed(need.code,need.value));
              const inactivityAlert=observability.recordActorTick(
                sim.id,
                id,
                nextTime.toISOString(),
                {active:actorHadActivity,criticalNeed}
              );
              if (inactivityAlert) {
                logger.warn({
                  simulationId:sim.id,
                  simulationTime:nextTime.toISOString(),
                  event:"ACTOR_INACTIVITY",
                  ...inactivityAlert
                },"actor inactivity threshold reached");
              }
            } catch (observabilityError) {
              logger.warn({
                simulationId:sim.id,
                entityId:id,
                event:"OBSERVABILITY_FAILED",
                error:String(observabilityError?.message||observabilityError)
              },"actor observability update failed");
            }
          }
        }
        setPhase("world.decay"); await decayMemories(sim.id, nextTime); this.tickCounter.set(sim.id, Number(this.tickCounter.get(sim.id) || 0) + 1);
        const count = Number(this.tickCounter.get(sim.id) || 0); if (count % env.GEMINI_PROACTIVE_EVERY_TICKS === 0) { try { const asami = await getAsamiCandidate(sim.id); if (asami) await initiateConversation({ simulationId: sim.id, asamiEntityId: asami.id, simulationTime: nextTime.toISOString(), gemini: this.gemini, hub: this.hub }); } catch (err) { logger.warn({ simulationId: sim.id, phase: "proactive_conversation", err }, "proactive conversation attempt failed"); } } if (count % env.SNAPSHOT_EVERY_TICKS === 0) await simRepo.createSnapshot(sim.id, nextTime);
        await simRepo.completeTick(tickId, { status: "COMPLETED", entityCount: actors.length });
        void maybeRunSafeRetention(sim.id, nextTime.toISOString());
        this.hub.publish(sim.id, "simulation.tick", { simulationTime: nextTime.toISOString(), tickId });
      } catch (err) {
        if (isCriticalResourceRecoveryUnavailable(err)) {
          observability.recordRecoveryFailed(sim.id);
          logger.error({
            simulationId:sim.id,
            simulationTime:context.simulationTime||null,
            event:"RECOVERY_FAILED",
            resource:err.resource||null,
            phase
          },"simulation resource recovery failed before actor processing");
        }
        await simRepo.completeTick(tickId, { status: "FAILED", error: { name: err.name, message: err.message, code: err.code, phase, entityId, actionType } });
        throw err;
      }
    } catch (err) {
      logger.error(logger.contextError({ ...context, phase, entityId, actionType }, err, "simulation run failed"));
    }
    });
  }
}

async function getDecisionExpectedOutcome(decisionId) { const [rows] = await pool.query(`SELECT expected_outcome AS expectedOutcome FROM decision_options WHERE decision_id=UUID_TO_BIN(?) LIMIT 1`, [decisionId]); if (!rows.length) return null; const value = rows[0].expectedOutcome; if (value && typeof value === "object") return value; try { return JSON.parse(value); } catch { return null; } }

module.exports = { SimulationEngine, getInterruptionReason, getCriticalInterruptionNeed, isCriticalNeed, isExpectedEntityCondition };