const logger = require("../lib/logger");
const { env } = require("../config/env");
const simRepo = require("../repositories/simulation-repo");
const entityRepo = require("../repositories/entity-repo");
const { ensureEntityState, readNeeds, updateNeeds, applyEmotions, developTraits } = require("../services/state-service");
const { findAutonomousActors, actForEntity, completeGoalForAction } = require("../services/autonomy-service");
const { perceive } = require("../services/perception-service");
const { executeAction, learnFromAction } = require("../services/action-service");
const { createMemory, decayMemories } = require("../services/memory-service");
const { generateWorldEvents } = require("../services/world-service");
const { updateDevelopment } = require("../services/development-service");
const { initiateConversation } = require("../services/chat-service");
const { recordHabitEvidence } = require("../services/habit-service");
const { updateMentalState } = require("../services/personality-service");

class SimulationEngine {
  constructor({gemini,hub}) {
    this.gemini=gemini;
    this.hub=hub;
    this.running=new Set();
    this.interval=null;
    this.tickCounter=new Map();
  }

  async start() {
    if(this.interval)return;
    this.interval=setInterval(()=>this.pulse().catch(err=>logger.error({err},"engine pulse failed")),env.ENGINE_INTERVAL_MS);
    await this.pulse();
  }

  async stop() {
    if(this.interval){clearInterval(this.interval);this.interval=null;}
  }

  async pulse() {
    const sims=await simRepo.listSimulations();
    for(const sim of sims){
      if(sim.status!=="RUNNING" || this.running.has(sim.id))continue;
      this.running.add(sim.id);
      this.runSimulation(sim).catch(err=>logger.error({err,simulationId:sim.id},"simulation failed"))
        .finally(()=>this.running.delete(sim.id));
    }
  }

  async runSimulation(sim) {
    const clock=await simRepo.getActiveClock(sim.id);
    if(!clock)return;
    const nextTime=new Date(new Date(clock.simulationAnchorAt).getTime()+
      (Date.now()-new Date(clock.realAnchorAt).getTime())*Number(clock.speed));
    if(nextTime<=new Date(sim.currentSimulationAt))return;
    const advanced=await simRepo.updateCurrentTimeOptimistic(sim.id,nextTime,sim.version);
    if(!advanced)return;

    const tickId=await simRepo.createTick(sim.id,nextTime,"AUTONOMOUS",env.ENGINE_VERSION);
    try{
      await generateWorldEvents(sim.id,nextTime,tickId);
      const actors=await findAutonomousActors(sim.id,env.MAX_ENTITIES_PER_TICK);
      for(const entityId of actors){
        await ensureEntityState(entityId,nextTime);
        const perception=await perceive(sim.id,entityId,nextTime);
        const decision=await actForEntity({simulationId:sim.id,entityId,simulationTime:nextTime,gemini:this.gemini});
        if(!decision) continue;
        const action=await executeAction({
          simulationId:sim.id,entityId,decisionId:decision.decisionId,intentionId:decision.intentionId,
          actionType:decision.actionType,simulationTime:nextTime,
          targetEntityId:decision.targetEntityId||null,targetLocationId:decision.targetLocationId||null
        });
        const deltaHours=Math.max(0,(new Date(nextTime)-new Date(sim.currentSimulationAt))/3600000);
        const needChanges=await updateNeeds(entityId,nextTime,deltaHours,action.eventId,action.actionId,decision.actionType);
        await applyEmotions(entityId,nextTime,needChanges,action.eventId,action.actionId);
        await learnFromAction(entityId,decision.actionType,nextTime);
        await completeGoalForAction(decision.goalId,decision.actionType,nextTime);
        await developTraits(entityId,nextTime,signalForDecision(decision.actionType),action.eventId,action.actionId);
        await recordHabitEvidence({ entityId, simulationTime: nextTime, actionType: decision.actionType });
        await updateDevelopment(sim.id,entityId,nextTime);
        if (decision.actionType === "TALKING" || decision.actionType === "STUDYING" || decision.actionType === "WORKING" || decision.actionType === "EXPLORING") {
          await updateMentalState(sim.id, entityId, nextTime, {
            currentFocus: decision.actionType.toLowerCase().replaceAll("_", " "),
            mentalLoad: decision.actionType === "WORKING" || decision.actionType === "STUDYING" ? 0.55 : 0.35,
            certainty: decision.confidence
          });
        }
        await createMemory({
          simulationId:sim.id,entityId,eventId:action.eventId,
          content:`Experienced ${decision.actionType.toLowerCase().replaceAll("_"," ")} at ${nextTime.toISOString()}`,
          importance:0.45,strength:0.9,confidence:0.8,emotionalIntensity:0.25,
          simulationAt:nextTime,metadata:{perceptionSummary:perception.location||null}
        });
        this.hub.publish(sim.id,"entity.state",{entityId,decision,action,needChanges});
      }
      await decayMemories(sim.id,nextTime);
      const count=(this.tickCounter.get(sim.id)||0)+1;
      this.tickCounter.set(sim.id,count);

      if(count % 600 === 0){
        const asami = await entityRepo.getAsamiCandidate(sim.id);
        if(asami){
          await initiateConversation({
            simulationId:sim.id,
            asamiEntityId:asami.id,
            simulationTime:nextTime,
            gemini:this.gemini,
            hub:this.hub
          });
        }
      }

      if(count % env.SNAPSHOT_EVERY_TICKS===0){
        const snapshot=await buildSnapshot(sim.id,nextTime);
        await simRepo.createSnapshot(sim.id,nextTime,snapshot,1);
      }
      await simRepo.finishTick(tickId,"COMPLETED");
      this.hub.publish(sim.id,"simulation.tick",{tickId,simulationTime:nextTime});
    }catch(err){
      try { await simRepo.finishTick(tickId,"FAILED"); } catch (finishErr) { logger.error({finishErr,simulationId:sim.id,tickId},"failed to mark simulation tick failed"); }
      throw err;
    }
  }
}

function signalForDecision(action){
  const map={
    TALKING:{EXTRAVERSION:1,SOCIABILITY:1,EMPATHY:0.2},
    EXPLORING:{OPENNESS:1,CURIOSITY:1,CONFIDENCE:0.2},
    STUDYING:{CONSCIENTIOUSNESS:1,DISCIPLINE:1,PATIENCE:0.4},
    WORKING:{CONSCIENTIOUSNESS:1,DISCIPLINE:1},
    PLAYING:{OPENNESS:0.4,IMPULSIVITY:0.3},
    WALKING:{OPENNESS:0.3},
    READING:{OPENNESS:0.4,CURIOSITY:0.6},
    SLEEPING:{PATIENCE:0.2},
    RESTING:{PATIENCE:0.2},
    EATING:{SELF_CARE:0.2},
    DRINKING:{SELF_CARE:0.2},
    WATCHING:{OPENNESS:0.1}
  };
  return map[action]||{};
}

async function buildSnapshot(simulationId,simulationTime){
  const actors=await entityRepo.listActors(simulationId,env.MAX_ENTITIES_PER_TICK);
  const entities=[];
  for(const a of actors){
    const d=await entityRepo.getDashboard(simulationId,a.id);
    entities.push({entity:d.entity,needs:d.needs,emotions:d.emotions,traits:d.traits,location:d.location,currentAction:d.currentAction});
  }
  return {simulationId,simulationTime,entities};
}

module.exports={SimulationEngine,signalForDecision,buildSnapshot};