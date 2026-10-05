const logger = require("../lib/logger");
const { AsyncLocalStorage } = require("node:async_hooks");
const runtimeContext = new AsyncLocalStorage();
const { env } = require("../config/env");

const countersBySimulation = new Map();
const gaugesBySimulation = new Map();
const actorStates = new Map();

function getMap(root, simulationId) {
  const key = String(simulationId);
  let map = root.get(key);
  if (!map) {
    map = new Map();
    root.set(key, map);
  }
  return map;
}

function runWithContext(context,fn){return runtimeContext.run(context,fn);}
function getContext(){return runtimeContext.getStore()||null;}
function recordDbQuery(durationMs){
  const context=getContext();
  if(!context?.simulationId)return;
  const phase=String(context.phase||"unknown").replace(/[^a-zA-Z0-9_.-]+/g,"_").slice(0,80);
  increment(context.simulationId,`db_queries_phase_${phase}_total`);
  increment(context.simulationId,`db_query_latency_phase_${phase}_ms_total`,Math.max(0,Number(durationMs)||0));
  increment(context.simulationId,"db_queries_total");
  increment(context.simulationId,"db_query_latency_ms_total",Math.max(0,Number(durationMs)||0));
  setGauge(context.simulationId,"db_query_latency_ms_last",Math.max(0,Number(durationMs)||0));
  setGauge(context.simulationId,"db_query_latency_ms_max",Math.max(Number(getMap(gaugesBySimulation,context.simulationId).get("db_query_latency_ms_max")||0),Number(durationMs)||0));
  context.tickQueryCount=Number(context.tickQueryCount||0)+1;
  if(Number(durationMs||0)>=1000)increment(context.simulationId,"db_slow_queries_total");
}
function increment(simulationId, metric, value=1) {
  if (!simulationId || !metric) return 0;
  const map=getMap(countersBySimulation,simulationId);
  const next=Number(map.get(metric)||0)+Math.max(0,Number(value)||0);
  map.set(metric,next);
  return next;
}

function setGauge(simulationId, metric, value) {
  if (!simulationId || !metric) return null;
  const map=getMap(gaugesBySimulation,simulationId);
  const next=Number.isFinite(Number(value))?Number(value):0;
  map.set(metric,next);
  return next;
}

function recordResourceEmergency(simulationId, resources=[]) {
  const items=Array.isArray(resources)?resources:[];
  if (!items.length) return;
  increment(simulationId,"resource_emergency_total",items.length);
  const replenished=items.reduce((sum,item)=>sum+Math.max(0,Number(item?.replenished||0)),0);
  if (replenished) increment(simulationId,"resource_emergency_replenished_units_total",replenished);
}

function recordGoalBlocked(simulationId,{resource=null}={}) {
  increment(simulationId,"goal_blocked_total");
  if (resource) increment(simulationId,`goal_blocked_${String(resource).toLowerCase()}_total`);
}

function recordRecoveryFailed(simulationId) {
  increment(simulationId,"recovery_failed_total");
}

function recordRetentionSummary(simulationId,summary={}) {
  const names=[
    ["retention_backlog_rows",summary.retentionBacklogTotal],
    ["retention_backlog_before_rows",summary.retentionBacklogBefore],
    ["need_history_backlog_rows",summary.needHistoryBacklog],
    ["emotion_history_backlog_rows",summary.emotionHistoryBacklog],
    ["action_backlog_rows",summary.actionBacklog],
    ["event_backlog_rows",summary.eventBacklog],
    ["action_decision_summary_backlog_rows",summary.actionDecisionSummaryBacklog],
    ["retention_produced_rows_per_sim_day",summary.retentionProducedRowsPerSimDay],
    ["retention_deleted_rows_per_sim_day",summary.retentionDeletedRowsPerSimDay],
    ["retention_debt_age_hours",summary.retentionDebtAgeHours],
    ["retention_overload_streak",summary.retentionOverloadStreak],
    ["retention_adaptive_level",summary.adaptiveRetentionLevel]
  ];
  for(const [metric,value] of names)setGauge(simulationId,metric,value);
  setGauge(simulationId,"retention_budget_ms",summary.retentionBudgetMs);
  setGauge(simulationId,"retention_budget_remaining_ms",summary.retentionBudgetRemainingMs);
}

function parseSimulationMs(value) {
  const ms=new Date(value).getTime();
  return Number.isFinite(ms)?ms:null;
}

function actorKey(simulationId,entityId) {
  return String(simulationId)+":"+String(entityId);
}

function getGoalObservabilityState(key,now,progress) {
  return actorStates.get(key)||{
    lastProgress:Number(progress)||0,
    lastProgressAt:now,
    lastActionAt:null,
    activeTimeHours:0,
    successfulActionsOnGoal:0,
    failedActionsOnGoal:0,
    actionCount:0,
    countedActionKeys:new Set()
  };
}

function goalProgressSnapshot(previous,simulationTime,numericProgress) {
  const now=parseSimulationMs(simulationTime);
  const timeSinceLastProgress=now===null?0:Math.max(0,(now-Number(previous.lastProgressAt||now))/3600000);
  const timeSinceLastAction=now===null||previous.lastActionAt===null
    ?null
    :Math.max(0,(now-Number(previous.lastActionAt||now))/3600000);
  return {
    progress:numericProgress,
    timeSinceLastProgress:Number(timeSinceLastProgress.toFixed(2)),
    timeSinceLastAction:timeSinceLastAction===null?null:Number(timeSinceLastAction.toFixed(2)),
    totalActiveTime:Number(Number(previous.activeTimeHours||0).toFixed(2)),
    activeTimeOnCurrentGoal:Number(Number(previous.activeTimeHours||0).toFixed(2)),
    successfulActionsOnGoal:Number(previous.successfulActionsOnGoal||0),
    failedActionsOnGoal:Number(previous.failedActionsOnGoal||0),
    actionCount:Number(previous.actionCount||0)
  };
}

function recordGoalProgress(simulationId,entityId,simulationTime,{goalId,progress=0,status="ACTIVE",actionType=null}={}) {
  if(!simulationId||!entityId||!goalId)return null;
  const now=parseSimulationMs(simulationTime);
  if(now===null)return null;
  const key="goal:"+actorKey(simulationId,goalId);
  const previous=getGoalObservabilityState(key,now,progress);
  const numericProgress=Math.max(0,Math.min(1,Number(progress)||0));
  const previousProgress=Number(previous.lastProgress||0);
  const timeSinceLastProgress=Math.max(0,(now-Number(previous.lastProgressAt||now))/3600000);
  const timeSinceLastAction=previous.lastActionAt===null
    ?null
    :Math.max(0,(now-Number(previous.lastActionAt||now))/3600000);
  const progressed=numericProgress>previousProgress+0.0001;
  const active=!["COMPLETED","FAILED","CANCELLED","ABANDONED"].includes(String(status||"").toUpperCase());

  if(progressed){
    previous.lastProgress=numericProgress;
    previous.lastProgressAt=now;
  }
  if(actionType){
    previous.lastActionAt=now;
    previous.actionCount=Number(previous.actionCount||0)+1;
  }
  actorStates.set(key,previous);
  if(!active)return null;

  const stagnantHours=Math.max(0,(now-Number(previous.lastProgressAt||now))/3600000);
  const threshold=Math.max(1,Number(env.GOAL_STAGNATION_ALERT_HOURS)||24);
  if(stagnantHours<threshold||!actionType)return null;
  const alertKey=key+":alert";
  const lastAlert=Number(actorStates.get(alertKey)?.lastAlertAt||0);
  const repeat=Math.max(1,Number(env.GOAL_STAGNATION_ALERT_REPEAT_HOURS)||12);
  if(lastAlert&&now-lastAlert<repeat*3600000)return null;
  actorStates.set(alertKey,{lastAlertAt:now});
  increment(simulationId,"goal_stagnation_total");

  return {
    entityId,
    goalId,
    simulationTime,
    ...goalProgressSnapshot(previous,simulationTime,numericProgress),
    stagnantHours:Number(stagnantHours.toFixed(2)),
    actionType,
    deprecatedActivityHours:timeSinceLastAction===null?null:Number(timeSinceLastAction.toFixed(2))
  };
}

function recordGoalActionOutcome(simulationId,entityId,simulationTime,{goalId,actionId=null,actionType=null,outcome=null,durationMinutes=0}={}) {
  if(!simulationId||!entityId||!goalId)return null;
  const now=parseSimulationMs(simulationTime);
  if(now===null)return null;
  const key="goal:"+actorKey(simulationId,goalId);
  const previous=getGoalObservabilityState(key,now,0);
  const actionKey=String(actionId||("at:"+simulationTime+"|"+String(actionType||"")+"|"+String(outcome||"")));
  previous.countedActionKeys=previous.countedActionKeys instanceof Set?previous.countedActionKeys:new Set();
  if(previous.countedActionKeys.has(actionKey)){
    return goalProgressSnapshot(previous,simulationTime,previous.lastProgress);
  }

  const normalizedOutcome=String(outcome||"").trim().toUpperCase();
  const durationHours=Math.max(0,Number(durationMinutes)||0)/60;
  previous.activeTimeHours=Math.max(0,Number(previous.activeTimeHours||0))+durationHours;
  if(["SUCCESS","SUCCEEDED","COMPLETED"].includes(normalizedOutcome)){
    previous.successfulActionsOnGoal=Number(previous.successfulActionsOnGoal||0)+1;
  }else if(["FAILURE","FAILED","CANCELLED","INTERRUPTED"].includes(normalizedOutcome)){
    previous.failedActionsOnGoal=Number(previous.failedActionsOnGoal||0)+1;
  }
  previous.countedActionKeys.add(actionKey);
  if(previous.countedActionKeys.size>128){
    const first=previous.countedActionKeys.values().next().value;
    if(first)previous.countedActionKeys.delete(first);
  }
  actorStates.set(key,previous);
  return {
    entityId,
    goalId,
    simulationTime,
    actionId,
    actionType,
    outcome:normalizedOutcome||null,
    actionDurationHours:Number(durationHours.toFixed(2)),
    ...goalProgressSnapshot(previous,simulationTime,previous.lastProgress)
  };
}

function recordActorTick(simulationId,entityId,simulationTime,{active=false,criticalNeed=false}={}) {
  if (!simulationId || !entityId) return null;
  const now=parseSimulationMs(simulationTime);
  if (now===null) return null;
  const key=actorKey(simulationId,entityId);
  const previous=actorStates.get(key)||{
    idleSinceMs:null,
    lastAlertMs:null,
    lastSimulationMs:now
  };

  previous.lastSimulationMs=now;
  if (active) {
    previous.idleSinceMs=null;
    previous.lastAlertMs=null;
    actorStates.set(key,previous);
    return null;
  }

  if (previous.idleSinceMs===null)previous.idleSinceMs=now;
  const idleHours=Math.max(0,(now-previous.idleSinceMs)/3600000);
  const thresholdHours=Math.max(1,Number(env.ACTOR_INACTIVITY_ALERT_HOURS)||12);
  const repeatHours=Math.max(1,Number(env.ACTOR_INACTIVITY_ALERT_REPEAT_HOURS)||6);
  const canAlert=previous.lastAlertMs===null ||
    now-previous.lastAlertMs>=repeatHours*3600000;

  actorStates.set(key,previous);
  if (idleHours<thresholdHours||!canAlert)return null;

  previous.lastAlertMs=now;
  increment(simulationId,"actor_inactivity_total");
  if (criticalNeed) increment(simulationId,"actor_inactivity_critical_total");

  return {
    entityId,
    simulationTime,
    idleHours:Number(idleHours.toFixed(2)),
    criticalNeed:Boolean(criticalNeed)
  };
}

function snapshot(simulationId) {
  const context=getContext();
  if(context?.simulationId===String(simulationId)||context?.simulationId===simulationId){
    setGauge(simulationId,"db_queries_current_tick",Number(context.tickQueryCount||0));
  }
  const counters=Object.fromEntries(
    [...getMap(countersBySimulation,simulationId).entries()].sort((a,b)=>a[0].localeCompare(b[0]))
  );
  const gauges=Object.fromEntries(
    [...getMap(gaugesBySimulation,simulationId).entries()].sort((a,b)=>a[0].localeCompare(b[0]))
  );
  return { counters, gauges };
}


function compactSnapshot(metrics={}) {
  const counters=metrics?.counters||{};
  const gauges=metrics?.gauges||{};
  return {
    dbQueries:Number(counters.db_queries_total||0),
    dbQueryMs:Number(counters.db_query_latency_ms_total||0),
    dbSlowQueries:Number(counters.db_slow_queries_total||0),
    tickQueries:Number(gauges.db_queries_current_tick||0),
    dbLastMs:Number(gauges.db_query_latency_ms_last||0),
    dbMaxMs:Number(gauges.db_query_latency_ms_max||0),
    backlogs:{
      retention:Number(gauges.retention_backlog_rows||0),
      actions:Number(gauges.action_backlog_rows||0),
      actionSummaries:Number(gauges.action_decision_summary_backlog_rows||0),
      events:Number(gauges.event_backlog_rows||0),
      needs:Number(gauges.need_history_backlog_rows||0),
      emotions:Number(gauges.emotion_history_backlog_rows||0)
    },
    alerts:{
      resourceEmergency:Number(counters.resource_emergency_total||0),
      recoveryFailed:Number(counters.recovery_failed_total||0),
      goalBlocked:Number(counters.goal_blocked_total||0),
      goalStagnation:Number(counters.goal_stagnation_total||0),
      actorInactivity:Number(counters.actor_inactivity_total||0),
      integrityViolations:Number(counters.integrity_violation_total||0),
      staleEvaluatedDecisions:Number(counters.stale_evaluated_decisions_total||0),
      staleEvaluatedInvariantViolations:Number(counters.stale_evaluated_decision_invariant_violations_total||0),
      staleEvaluatedRepaired:Number(counters.stale_evaluated_decisions_repaired_total||0),
      staleEvaluatedCurrent:Number(gauges.stale_evaluated_decisions_current||0)
    }
  };
}

function logSnapshot(simulationId,simulationTime) {
  const metrics=snapshot(simulationId);
  logger.debug({
    simulationId,
    simulationTime,
    metrics:compactSnapshot(metrics)
  },"simulation observability");
  logger.debug({
    simulationId,
    simulationTime,
    metrics
  },"simulation observability detail");
  return metrics;
}

module.exports={
  runWithContext,
  getContext,
  recordDbQuery,
  increment,
  setGauge,
  recordResourceEmergency,
  recordGoalBlocked,
  recordRecoveryFailed,
  recordRetentionSummary,
  recordGoalProgress,
  recordGoalActionOutcome,
  recordActorTick,
  snapshot,
  compactSnapshot,
  logSnapshot
};
