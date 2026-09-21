const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('movement start rejects missing origin and unreachable destinations', () => {
  const source = read('services/action-service.js');
  assert.match(source, /MOVEMENT_ORIGIN_REQUIRED/);
  assert.match(source, /MOVEMENT_DESTINATION_UNREACHABLE/);
  assert.match(source, /MOVEMENT_DESTINATION_REQUIRED/);
  assert.match(source, /MOVEMENT_ALREADY_ACTIVE/);
});

test('movement completion trusts the persisted movement destination', () => {
  const source = read('services/action-service.js');
  assert.match(source, /destination_location_id/);
  assert.match(source, /resolvedDestination=movement\.destinationLocationId\|\|destination/);
  assert.match(source, /location_id=UUID_TO_BIN\(\?\)/);
});

test('speed changes advance the simulation clock before creating a new segment', () => {
  const source = read('repositories/simulation-repo.js');
  assert.match(source, /UPDATE simulations\s+SET current_simulation_at=\?,version=version\+1/);
  assert.match(source, /simulation_anchor_at/);
  assert.match(source, /\bspeed\b/);
  assert.match(source, /endSimulationTime/);
});

test('worker installs the same core runtime and cognitive bootstraps as the server', () => {
  const source = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
  for (const bootstrap of [
    'runtime-enhancements',
    'memory-normalization-bootstrap',
    'behavioral-policy-bootstrap',
    'behavioral-integrity-bootstrap',
    'development-duration-bootstrap',
    'decision-sql-compat-bootstrap',
    'action-runtime-bootstrap',
    'behavior-fix-bootstrap',
    'cognitive-v2-bootstrap',
    'cognitive-v3-bootstrap',
  ]) assert.match(source, new RegExp(bootstrap));
});

test('behavior feedback deduplication is bounded instead of an ever-growing Set', () => {
  const source = read('services/behavior-fix-bootstrap.js');
  assert.match(source, /const feedbackApplied = new Map\(\)/);
  assert.match(source, /MAX_FEEDBACK_KEYS/);
  assert.match(source, /FEEDBACK_KEY_TTL_MS/);
  assert.match(source, /pruneFeedbackClaims/);
});

test('simulation snapshots use timestamps that exist on the canonical goals schema', () => {
  const source = read('repositories/simulation-repo.js');
  assert.match(source, /created_simulation_at AS createdSimulationAt,COALESCE\(g\.completed_simulation_at,g\.created_simulation_at\) AS updatedSimulationAt/);
  assert.doesNotMatch(source, /g\.updated_simulation_at/);
});

test('location history queries match the canonical schema',()=>{
  const source=read('services/action-service.js');
  const world=read('services/world-population-service.js');
  for(const sql of [source,world]){
    const inserts=[...sql.matchAll(/INSERT INTO entity_location_history\(([^)]*)\)/g)].map(match=>match[1]);
    assert.ok(inserts.length>0);
    for(const columns of inserts) assert.match(columns,/\bsimulation_id\b/);
    assert.match(sql,/UPDATE entity_location_history SET exited_simulation_at=\? WHERE simulation_id=/);
  }
  assert.match(source,/UPDATE entity_location_history SET exited_simulation_at/);
  assert.match(world,/UPDATE entity_location_history SET exited_simulation_at/);
});

test('movement creation binds every simulation-scoped placeholder',()=>{
  const source=read('services/action-service.js');
  const start=source.indexOf('async function startMovement');
  const end=source.indexOf('async function completeMovement',start);
  const section=source.slice(start,end);
  assert.match(section,/WHERE simulation_id=UUID_TO_BIN\(\?\) AND entity_id=UUID_TO_BIN\(\?\)/);
  assert.match(section,/\[simulationId,entityId\]/);
  assert.match(section,/INSERT INTO movements\(id,simulation_id,entity_id,/);
  assert.match(section,/\[movementId,simulationId,entityId,origin,destination,startedSimulationAt,expectedArrival\]/);
});

test('failed action starts clean up persisted partial state',()=>{
  const source=read('services/action-service.js');
  assert.match(source,/UPDATE actions[\s\S]*SET status='FAILED'/);
  assert.match(source,/UPDATE movements SET status='FAILED'/);
  assert.match(source,/UPDATE events SET status='CANCELLED'/);
  assert.match(source,/UPDATE intentions SET status='CANCELLED'/);
  assert.match(source,/UPDATE decisions SET status='FAILED'/);
});

test('movement creation serializes on the entity location row',()=>{
  const source=read('services/action-service.js');
  const start=source.indexOf('async function startMovement');
  const end=source.indexOf('async function completeMovement',start);
  assert.ok(start>=0&&end>start);
  const section=source.slice(start,end);
  assert.match(section,/entity_locations_current[\s\S]*FOR UPDATE/);
  assert.match(section,/movements[\s\S]*status IN \('PLANNED','ACTIVE'\)[\s\S]*FOR UPDATE/);
});

test('conversation failures are recorded on the communication attempt',()=>{
  const source=read('services/chat-service.js');
  assert.match(source,/SET status='FAILED',result=\?/);
  assert.match(source,/UPDATE communication_intents[\s\S]*status='FAILED'/);
  assert.match(source,/status IN \('STARTED','DELIVERED'\)/);
});

test('movement completion closes all open history rows before recording arrival',()=>{
  const source=read('services/action-service.js');
  const start=source.indexOf('async function completeMovement');
  const end=source.indexOf('async function startAction',start);
  const section=source.slice(start,end);
  assert.match(section,/UPDATE entity_location_history SET exited_simulation_at=\? WHERE simulation_id=UUID_TO_BIN\(\?\) AND entity_id=UUID_TO_BIN\(\?\) AND exited_simulation_at IS NULL/);
});

test('action completion does not create an event before core action commit',()=>{
  const source=read('services/action-service.js');
  const start=source.indexOf('async function completeAction');
  const end=source.indexOf('async function executeAction',start);
  const section=source.slice(start,end);
  const transactionIndex=section.indexOf('await withTransaction');
  const eventIndex=section.indexOf('eventId=await ensureEventId');
  assert.ok(transactionIndex>=0);
  assert.ok(eventIndex>transactionIndex);
});

test('consolidated memory upserts are serialized with a database lock',()=>{
  const source=read('services/runtime-enhancements.js');
  const start=source.indexOf('async function upsertConsolidatedMemory');
  const end=source.indexOf('async function consolidateActionMemories',start);
  const section=source.slice(start,end);
  assert.match(section,/GET_LOCK\(\?,5\)/);
  assert.match(section,/RELEASE_LOCK/);
  assert.match(section,/pool\.getConnection\(\)/);
});

test('conversation creation is serialized per simulation and entity pair',()=>{
  const source=read('services/chat-service.js');
  const start=source.indexOf('async function ensureConversation');
  const end=source.indexOf('async function findExistingConversation',start);
  const section=source.slice(start,end);
  assert.match(section,/GET_LOCK\(\?,5\)/);
  assert.match(section,/RELEASE_LOCK/);
  assert.match(section,/sort\(\)\.join\(["']\|["']\)/);
});


test('movement start normalizes ISO simulation timestamps before using a raw DB connection',()=>{
  const source=read('services/action-service.js');
  const start=source.indexOf('async function startMovement');
  const end=source.indexOf('async function completeMovement',start);
  const section=source.slice(start,end);
  assert.match(section,/normalizeSimulationTimestamp\(simulationTime\)/);
  assert.match(section,/startedSimulationAt/);
  assert.match(section,/movementId,simulationId,entityId,origin,destination,startedSimulationAt,expectedArrival/);
});

test('raw mysql connections normalize simulation timestamps like pool.query',()=>{
  const source=read('db/pool.js');
  assert.match(source,/originalGetConnection = pool\.getConnection\.bind\(pool\)/);
  assert.match(source,/conn\.query = \(sql, values\) => originalConnectionQuery\(sql, normalizeMysqlValues\(values\)\)/);
});

test('entity need persistence is serialized and current plus history share one transaction',()=>{
  const source=read('services/state-service.js');
  assert.match(source,/async function withEntityStateLock\(entityId, fn\)/);
  assert.match(source,/GET_LOCK\(\?,\?\)/);
  assert.match(source,/await conn\.beginTransaction\(\)/);
  assert.match(source,/await conn\.commit\(\)/);
  assert.match(source,/SELECT RELEASE_LOCK/);
  assert.match(source,/async function persistNeedTransition\([\s\S]*db = pool/);
  const updateStart=source.indexOf('async function updateNeeds(');
  const updateEnd=source.indexOf('\nfunction traitValue',updateStart);
  const section=source.slice(updateStart,updateEnd);
  assert.match(section,/return withEntityStateLock\(entityId, async db =>/);
  assert.match(section,/readNeeds\(entityId,db\)/);
  assert.match(section,/persistNeedTransition\([\s\S]*db/);
});

test('conversation need and entity writes use the same entity state serialization',()=>{
  const source=read('services/conversation-cognition-service.js');
  assert.match(source,/withEntityStateLock, persistNeedTransition/);
  const needStart=source.indexOf('async function applyNeedDeltas(');
  const needEnd=source.indexOf('\nasync function applyEmotionDeltas',needStart);
  const needSection=source.slice(needStart,needEnd);
  assert.match(needSection,/return withEntityStateLock\(entityId, async db =>/);
  assert.match(needSection,/persistNeedTransition\(/);
  assert.match(needSection,/db/);
  const styleStart=source.indexOf('async function updateCommunicationStyle(');
  const styleEnd=source.indexOf('\nasync function createGoalFromProposal',styleStart);
  assert.match(source.slice(styleStart,styleEnd),/return withEntityStateLock\(entityId, async db =>/);
});

test('mental state writes do not race need-history foreign-key writes on the entity row',()=>{
  const source=read('services/personality-service.js');
  assert.match(source,/withEntityStateLock/);
  const start=source.indexOf('async function updateMentalState(');
  const end=source.indexOf('\nasync function upsertPreference',start);
  assert.match(source.slice(start,end),/return withEntityStateLock\(entityId, async db =>/);
});

test('event creation is atomic and serialized per simulation',()=>{
  const source=read('services/event-service.js');
  assert.match(source,/async function withEventWriteLock\(simulationId, fn, db = pool\)/);
  assert.match(source,/GET_LOCK\(\?,\?\)/);
  assert.match(source,/await conn\.beginTransaction\(\)/);
  assert.match(source,/await conn\.commit\(\)/);
  assert.match(source,/INSERT INTO events/);
  assert.match(source,/INSERT IGNORE INTO event_participants/);
  assert.match(source,/SELECT RELEASE_LOCK/);
});

test('event retention shares the event write lock instead of deleting concurrently',()=>{
  const source=read('services/safe-retention-service.js');
  assert.match(source,/withEventWriteLock/);
  assert.match(source,/deleteOldEvents\(conn, simulationId, mysqlSimulationTime\)/);
});

test('world event processing shares the event write lock',()=>{
  const source=read('services/world-service.js');
  assert.match(source,/withEventWriteLock/);
  const start=source.indexOf('async function processWorldEffects');
  assert.match(source.slice(start),/return withEventWriteLock\(simulationId/);
});
test('event write lock helper is exported for retention and world writers',()=>{
  const source=read('services/event-service.js');
  assert.match(source,/module\.exports=\{[^}]*withEventWriteLock/);
});

test('symmetric relationship lookup qualifies id after joining relationship types',()=>{
  const source=read('services/relationship-service.js');
  const start=source.indexOf('if(!rows.length && Number(type.symmetric))');
  const end=source.indexOf('\n  if(!rows.length){',start);
  const section=source.slice(start,end);
  assert.match(section,/SELECT BIN_TO_UUID\(r\.id\) AS id,r\.version/);
  assert.doesNotMatch(section,/SELECT BIN_TO_UUID\(id\) AS id,version/);
});


test('critical resources have bounded emergency reserves and an explicit emergency marker',()=>{
  const source=read('services/physical-world-service.js');
  assert.match(source,/CRITICAL_RESOURCE_RESERVES/);
  assert.match(source,/water:\s*12/);
  assert.match(source,/food:\s*8/);
  assert.match(source,/RESOURCE_EMERGENCY_TTL_MINUTES/);
  assert.match(source,/resourceEmergencies/);
  assert.match(source,/resources\[resource\]=reserve/);
  assert.match(source,/if\(available>=reserve\)return current/);
});

test('critical resource invariant checks reachability from actor locations and verifies recovery',()=>{
  const source=read('services/physical-world-service.js');
  const start=source.indexOf('async function ensureCriticalResourceAvailability');
  const end=source.indexOf('\nasync function getLocationPhysicalState',start);
  const section=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(section,/loadActorLocationIds\(simulationId,entityId\)/);
  assert.match(section,/findReachableResource\(locations,originId,resource\)/);
  assert.match(section,/ensureResourceReserveAtLocation\([\s\S]*locationId:originId/);
  assert.match(section,/const refreshed=await loadActiveLocations\(simulationId\)/);
  assert.match(section,/const stillReachable=findReachableResource\(nextLocations,originId,resource\)/);
  assert.match(section,/code:"CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE"/);
});

test('resource action completion has an emergency race-safe retry without changing normal success semantics',()=>{
  const source=read('services/physical-world-service.js');
  const start=source.indexOf('async function resolveActionResource');
  const end=source.indexOf('\nmodule.exports=',start);
  const section=source.slice(start,end);
  assert.match(section,/const first=await consumeResource/);
  assert.match(section,/if\(first\.ok\|\|first\.remaining===null\)return first/);
  assert.match(section,/reason:"ACTION_RESOURCE_RACE"/);
  assert.match(section,/const recovered=await consumeResource/);
  assert.match(section,/emergencyRecovered:true/);
});

test('decision context records explicit RESOURCE_EMERGENCY mode',()=>{
  const source=read('services/decision-service.js');
  assert.match(source,/selectionMode\s*=\s*criticalResourceRecovery\.mode === "RESOURCE_EMERGENCY"/);
  assert.match(source,/"RESOURCE_EMERGENCY"/);
  assert.match(source,/criticalResourceRecovery\.mode/);
});

test('engine enforces critical resource invariant before actors are selected',()=>{
  const source=read('simulation/engine.js');
  assert.match(source,/ensureCriticalResourceAvailability/);
  const invariantIndex=source.indexOf('phase = "world.resource_invariant"');
  const actorIndex=source.indexOf('findAutonomousActors',invariantIndex);
  assert.ok(invariantIndex>=0&&actorIndex>invariantIndex);
  assert.match(source.slice(invariantIndex,actorIndex),/ensureCriticalResourceAvailability\(sim\.id,nextTime\.toISOString\(\)\)/);
});

test('critical resource recovery is WARN-level and retried, not classified as an expected debug-only condition',()=>{
  const source=read('simulation/engine.js');
  assert.doesNotMatch(source,/EXPECTED_ENTITY_CONDITION_CODES[^\\n]*CRITICAL_RESOURCE_RECOVERY_UNAVAILABLE/);
  assert.match(source,/isCriticalResourceRecoveryUnavailable/);
  const start=source.indexOf('if (isCriticalResourceRecoveryUnavailable(err))');
  const end=source.indexOf('} else if (String(err?.code||"").toUpperCase()==="CRITICAL_ACTION_UNAVAILABLE")',start);
  const section=source.slice(start,end);
  assert.match(section,/logger\.warn/);
  assert.match(section,/ensureCriticalResourceAvailability\(/);
  assert.match(section,/autonomyService\.actForEntity\(/);
});

test('CRITICAL_ACTION_UNAVAILABLE stays distinct from resource emergency recovery',()=>{
  const source=read('simulation/engine.js');
  const resourceIndex=source.indexOf('isCriticalResourceRecoveryUnavailable');
  const actionIndex=source.indexOf('String(err?.code||"").toUpperCase()==="CRITICAL_ACTION_UNAVAILABLE"');
  assert.ok(resourceIndex>=0&&actionIndex>resourceIndex);
  const resourceSection=source.slice(resourceIndex,actionIndex);
  assert.doesNotMatch(resourceSection,/CRITICAL_ACTION_UNAVAILABLE/);
});


test('resource emergency routing still enforces the persisted destination',()=>{
  const source=read('services/decision-service.js');
  assert.match(source,/\["ROUTING","RESOURCE_EMERGENCY"\]\.includes\(requirement\.mode\)/);
  const start=source.indexOf('function validateCriticalDecision');
  const end=source.indexOf('\nasync function makeDecision',start);
  assert.match(source.slice(start,end),/Critical resource recovery for/);
  assert.match(source.slice(start,end),/expectedTargetLocationId/);
});


test('MySQL transient failures are classified and retried without retrying transaction bodies',()=>{
  const source=read('db/pool.js');
  assert.match(source,/PROTOCOL_CONNECTION_LOST/);
  assert.match(source,/ECONNREFUSED/);
  assert.match(source,/EAI_AGAIN/);
  assert.match(source,/async function pingWithRetry/);
  assert.match(source,/async function getConnectionWithRetry/);
  const txStart=source.indexOf('async function withTransaction');
  const txEnd=source.indexOf('\nasync function close',txStart);
  const txSection=source.slice(txStart,txEnd);
  assert.match(txSection,/getConnectionWithRetry/);
  assert.doesNotMatch(txSection,/retry.*fn/i);
});

test('engine checks database health before listing simulations and before creating a tick',()=>{
  const source=read('simulation/engine.js');
  const pulseIndex=source.indexOf('await pingWithRetry');
  const listIndex=source.indexOf('simRepo.listSimulations',pulseIndex);
  const tickIndex=source.indexOf('simRepo.advanceAndCreateTick');
  const secondPingIndex=source.indexOf('await pingWithRetry',pulseIndex+1);
  assert.ok(pulseIndex>=0&&listIndex>pulseIndex);
  assert.ok(secondPingIndex>pulseIndex&&tickIndex>secondPingIndex);
  assert.match(source,/database degraded; skipping engine pulse/);
  assert.match(source,/database degraded; tick creation skipped/);
  assert.match(source,/pulseInFlight/);
});

test('backend and worker use retried database startup and planning schema migrations',()=>{
  for(const relative of ['server.js','worker.js']){
    const source=fs.readFileSync(path.join(root,relative),'utf8');
    assert.match(source,/ensureDatabaseWithRetry/);
    assert.match(source,/pingWithRetry/);
    assert.match(source,/ensurePlanningStatusMigrations/);
  }
});

test('planning schema migration adds BLOCKED state idempotently to goal, plan and step checks',()=>{
  const source=read('db/schema-migrations.js');
  assert.match(source,/table: "goals"/);
  assert.match(source,/table: "plans"/);
  assert.match(source,/table: "plan_steps"/);
  assert.match(source,/statuses: \[[\s\S]*"BLOCKED"[\s\S]*\]/);
  assert.match(source,/INFORMATION_SCHEMA\.CHECK_CONSTRAINTS/);
  assert.match(source,/current\.includes\("'BLOCKED'"\)/);
  assert.match(source,/DROP CHECK/);
  assert.match(source,/ADD CONSTRAINT/);
  assert.match(source,/GET_LOCK\(\?,30\)/);
});

test('abandoning a goal atomically cancels its open plan steps before closing plans',()=>{
  const source=read('services/planning-service.js');
  const start=source.indexOf('async function abandonGoal');
  const end=source.indexOf('\nasync function ensureGoalPlan',start);
  const section=source.slice(start,end);
  assert.match(section,/withTransaction/);
  assert.match(section,/status='ABANDONED'/);
  assert.match(section,/status='CANCELLED'/);
  assert.match(section,/plan_steps SET status='CANCELLED'/);
  assert.match(section,/status IN \('PENDING','ACTIVE','BLOCKED'\)/);
  assert.match(section,/FOR UPDATE/);
});

test('resource failures move goals and plans to BLOCKED and preserve a resumable retry state',()=>{
  const source=read('services/planning-service.js');
  assert.match(source,/function isResourceBlockedFailure/);
  assert.match(source,/async function blockGoalForResource/);
  assert.match(source,/status='BLOCKED'/);
  assert.match(source,/retryWhenResourceAvailable:true/);
  assert.match(source,/blockedReason/);
  assert.match(source,/SET status='BLOCKED'/);
  assert.match(source,/plan_steps SET status='BLOCKED'/);
});

test('blocked goals only return to ACTIVE after their required resource is reachable',()=>{
  const source=read('services/planning-service.js');
  const start=source.indexOf('async function ensureGoalPlan');
  const end=source.indexOf('\nfunction selectActiveStep',start);
  const section=source.slice(start,end);
  assert.match(section,/activeGoal\.status==="BLOCKED"/);
  assert.match(section,/isCriticalResourceReachable\(simulationId,entityId,resource\)/);
  assert.match(section,/unblockBlockedGoal/);
  assert.match(section,/return\{goal:activeGoal,plan,created:false,blocked:true\}/);
});

test('late action completion cannot advance a BLOCKED plan',()=>{
  const source=read('services/planning-service.js');
  const start=source.indexOf('async function advancePlanForAction');
  const end=source.indexOf('\nmodule.exports=',start);
  const section=source.slice(start,end);
  assert.match(section,/if\(plan\.status==="BLOCKED"\)return/);
});

test('retention uses a shared time budget and reports remaining history backlog',()=>{
  const source=read('services/safe-retention-service.js');
  assert.match(source,/RETENTION_TIME_BUDGET_MS/);
  assert.match(source,/retentionDeadlineAt/);
  assert.match(source,/retentionBudgetAvailable/);
  assert.match(source,/needHistoryBacklog/);
  assert.match(source,/emotionHistoryBacklog/);
  assert.match(source,/retentionBudgetRemainingMs/);
  assert.match(source,/summary\.retentionBacklogTotal > 0/);
});

test('need and emotion retention stop cooperatively when the cycle time budget is exhausted',()=>{
  const source=read('services/safe-retention-service.js');
  for(const fn of ['deleteOldNeedHistory','deleteOldEmotionHistory']){
    const start=source.indexOf('async function '+fn);
    const end=source.indexOf('\nasync function ',start+10);
    const section=source.slice(start,end>start?end:source.length);
    assert.match(section,/deleteSelectedRows/);
  }
  assert.match(source,/while \(deleted < POLICY\.maxDeletesPerTable && retentionBudgetAvailable\(simulationId\)/);
});


test('failed plan paths also cancel every remaining open step',()=>{
  const source=read('services/planning-service.js');
  const start=source.indexOf('async function advancePlanForAction');
  const end=source.indexOf('\nmodule.exports=',start);
  const section=source.slice(start,end);
  const cancelIndex=section.indexOf("status='CANCELLED'",section.indexOf('failedSteps>0'));
  assert.ok(cancelIndex>=0);
  assert.match(section.slice(Math.max(0,cancelIndex-500),cancelIndex+700),/UPDATE plan_steps SET status='CANCELLED'/);
  assert.match(section.slice(Math.max(0,cancelIndex-500),cancelIndex+1000),/status IN \('PENDING','ACTIVE','BLOCKED'\)/);
});

test('blocked goals remain visible in persisted simulation snapshots',()=>{
  const source=read('repositories/simulation-repo.js');
  assert.match(source,/g\.status IN \('DRAFT','ACTIVE','PAUSED','BLOCKED'\)/);
});

test('actions are summarized before terminal action retention',()=>{
  const action=read('services/action-service.js');
  const retention=read('services/safe-retention-service.js');
  assert.match(action,/buildDecisionActionSummary/);
  assert.match(action,/actionSummary/);
  assert.match(retention,/compactOldActionDecisionSummaries/);
  assert.match(retention,/actionSummary/);
  assert.match(retention,/a\.decision_id IS NULL OR EXISTS/);
  assert.ok(retention.indexOf('compactOldActionDecisionSummaries') < retention.indexOf('deleteOldActions(lock.conn'));
});

test('occupied locations receive bounded critical-resource maintenance and planner routing remains explicit',()=>{
  const physical=read('services/physical-world-service.js');
  const engine=read('simulation/engine.js');
  const decision=read('services/decision-service.js');
  assert.match(physical,/RESOURCE_DISTRIBUTION_POLICY/);
  assert.match(physical,/maintainDistributedResources/);
  assert.match(physical,/OCCUPIED_LOCATION_DISTRIBUTION/);
  assert.match(engine,/maintainDistributedResources/);
  assert.match(decision,/findNearestResourceLocation/);
  assert.match(decision,/RESOURCE_UNAVAILABLE_LOCALLY/);
});

test('Gemini transient failures open an exponential backoff breaker',()=>{
  const source=read('ai/gemini.js');
  assert.match(source,/TRANSIENT_NETWORK_CODES/);
  assert.match(source,/503/);
  assert.match(source,/AI_TIMEOUT/);
  assert.match(source,/providerFailureStreak/);
  assert.match(source,/computeProviderBackoffMs/);
  assert.match(source,/local circuit breaker opened with exponential backoff/);
});

test('Gemini autonomy receives a bounded context',()=>{
  const source=read('services/autonomy-service.js');
  assert.match(source,/buildGeminiDecisionContext/);
  assert.match(source,/memories\.slice\(0,6\)/);
  assert.match(source,/recentFailures/);
  assert.match(source,/gemini\.chooseDecision\(geminiContext\)/);
});

test('mental state is refreshed from canonical needs on every actor tick',()=>{
  const personality=read('services/personality-service.js');
  const engine=read('simulation/engine.js');
  assert.match(personality,/refreshMentalStateFromSimulation/);
  assert.match(personality,/updatedSimulationAt: simulationTime/);
  assert.match(engine,/refreshMentalStateFromSimulation/);
  assert.match(engine,/activeActionType: wasCompleted \? null : active\.actionType/);
  assert.match(engine,/activeActionType: null/);
});

test('simulation observability covers recovery, goal blocking, retention backlog and inactivity',()=>{
  const obs=read('services/simulation-observability.js');
  const engine=read('simulation/engine.js');
  const planning=read('services/planning-service.js');
  const retention=read('services/safe-retention-service.js');
  for(const metric of ['resource_emergency_total','goal_blocked_total','recovery_failed_total','actor_inactivity_total']){
    assert.match(obs,new RegExp(metric));
  }
  assert.match(obs,/retention_backlog_rows/);
  assert.match(engine,/event:"RESOURCE_EMERGENCY"/);
  assert.match(engine,/event:"RECOVERY_FAILED"/);
  assert.match(engine,/event:"ACTOR_INACTIVITY"/);
  assert.match(planning,/goal blocked by unavailable critical resource/);
  assert.match(retention,/event:"RETENTION_BACKLOG"/);
});

test('resource consumption is compare-and-swap based against the persisted location version',()=>{
  const source=read('services/physical-world-service.js');
  const start=source.indexOf('async function consumeResource');
  const end=source.indexOf('async function replenishResource',start);
  const section=source.slice(start,end);
  assert.match(section,/updateLocationAttributes/);
  assert.match(source,/WHERE id=UUID_TO_BIN\(\?\) AND simulation_id=UUID_TO_BIN\(\?\) AND version=\?/, 'location updates must be version-guarded');
});

test('simulation world logic uses simulation time while wall clock remains technical infrastructure',()=>{
  const engine=read('simulation/engine.js');
  const state=read('services/state-service.js');
  const world=read('services/environment-service.js');
  assert.match(engine,/nextTime = new Date/);
  assert.match(engine,/simulationTime/);
  assert.match(state,/updateNeeds\(entityId,simulationTime/);
  assert.match(state,/applyEmotions\(entityId,simulationTime/);
  assert.match(world,/hourOf\(simulationTime\)/);
  assert.match(world,/daylight\(hour\)/);
});

test('replanning is bounded and records failed strategy constraints',()=>{
  const source=read('services/planning-service.js');
  assert.match(source,/MAX_PLAN_REPLANS=3/);
  assert.match(source,/REPLAN_REQUIRED/);
  assert.match(source,/avoidLocationIds/);
  assert.match(source,/avoidTargetEntityIds/);
  assert.match(source,/PLAN_REPLAN_LIMIT/);
});

test('social plan commitments yield to unavailable social targets',()=>{
  const source=read('services/decision-service.js');
  assert.match(source,/!c\.socialUnavailable/);
  assert.match(source,/applySocialIsolationFallback/);
  assert.match(source,/NO_REACHABLE_PERSON/);
});

test('database backpressure and deadlock controls are bounded',()=>{
  const engine=read('simulation/engine.js');
  const pool=read('db/pool.js');
  const env=read('config/env.js');
  assert.match(engine,/MAX_CONCURRENT_SIMULATIONS/);
  assert.match(engine,/simulation_queue_depth/);
  assert.match(pool,/DEADLOCK_ERRORS/);
  assert.match(pool,/attempt<totalAttempts-1/);
  assert.match(env,/MAX_CONCURRENT_SIMULATIONS/);
});

test('integrity checks cover cross-scope relationships beyond foreign-key existence',()=>{
  const source=read('services/integrity-check-service.js');
  assert.match(source,/actions_decision_scope/);
  assert.match(source,/actions_goal_scope/);
  assert.match(source,/plans_goal_scope/);
  assert.match(source,/events_source_action_scope/);
  assert.match(source,/memories_source_event_scope/);
});

test('AI proposal and executed action provenance are persisted separately',()=>{
  const decision=read('services/decision-service.js');
  const action=read('services/action-service.js');
  assert.match(decision,/aiProposal/);
  assert.match(decision,/validatedDecision/);
  assert.match(decision,/transformation/);
  assert.match(action,/executedAction/);
});

test('state machine defines terminal states and rejects impossible transitions',()=>{
  const machine=read('services/state-machine.js');
  assert.match(machine,/INVALID_STATE_TRANSITION/);
  assert.match(machine,/COMPLETED:new Set\(\[\]\)/);
  assert.match(machine,/EXECUTED:new Set\(\[\]\)/);
  assert.match(machine,/RUNNING:new Set\(\["COMPLETED","FAILED","SKIPPED"\]\)/);
});

test('database query telemetry is tied to simulation runtime context',()=>{
  const pool=read('db/pool.js');
  const obs=read('services/simulation-observability.js');
  assert.match(pool,/recordDbQuery/);
  assert.match(obs,/AsyncLocalStorage/);
  assert.match(obs,/db_queries_total/);
  assert.match(obs,/db_slow_queries_total/);
});

test('environmental scheduling has an overdue-vital-event path',()=>{
  const environment=read('services/environment-service.js');
  const world=read('services/world-service.js');
  assert.match(environment,/FAIR_EVENT_MAX_GAP_HOURS=24/);
  assert.match(environment,/isVitalEnvironmentalEventDue/);
  assert.match(world,/isVitalEnvironmentalEventDue/);
  assert.match(world,/vitalDue/);
});


test('action relief remains effective at saturated pressure needs',()=>{
  const source=read('services/state-service.js');
  assert.match(source,/function saturatedActionDelta\(actionType,needCode,currentValue,hours\)/);
  assert.match(source,/const pressureFactor=\.30\+\.70\*value/);
  assert.doesNotMatch(source,/if\(rate<0\)return-amount\*value;/);
});

test('successful need relief actively releases negative emotional load',()=>{
  const { emotionAppraisal } = require('../src/services/state-service');
  const changes=[
    {code:'FUN',old:1,new:.35,delta:-.65},
    {code:'BELONGING',old:.9,new:.55,delta:-.35}
  ];
  const appraisal=emotionAppraisal('PLAYING',changes,{
    event:true,
    outcome:'SUCCESS',
    meaning:'GOAL_PROGRESS',
    traits:[
      {code:'NEUROTICISM',value:.5},
      {code:'EXTRAVERSION',value:.5},
      {code:'SOCIABILITY',value:.5},
      {code:'EMPATHY',value:.5},
      {code:'OPENNESS',value:.5},
      {code:'PATIENCE',value:.5},
      {code:'IMPULSIVITY',value:.5}
    ]
  });
  assert.ok(Number(appraisal.SADNESS)<0);
  assert.ok(Number(appraisal.FRUSTRATION)<0);
  assert.ok(Number(appraisal.ANXIETY)<0);
  assert.ok(Number(appraisal.JOY)>0);
});

test('exploration strongly penalizes immediate and recent revisits',()=>{
  const source=read('services/autonomy-service.js');
  assert.match(source,/if\(elapsed<=\.5\)return 0/);
  assert.match(source,/const immediateReturn=String\(location\.locationId\)===String\(previousLocationId\|\|'\) /);
  assert.match(source,/recentVisitPenalty=immediateReturn\?\.95/);
  assert.match(source,/score=novelty\*1\.55/);
  const { explorationNoveltyScore } = require('../src/services/autonomy-service');
  const now='2027-01-01T12:00:00.000Z';
  assert.equal(explorationNoveltyScore('2027-01-01T11:45:00.000Z',now),0);
  assert.ok(explorationNoveltyScore('2026-12-31T12:00:00.000Z',now) > explorationNoveltyScore('2027-01-01T10:30:00.000Z',now));
});

test('walking fallback avoids immediate backtracking when another edge exists',()=>{
  const { nextHop } = require('../src/services/action-service');
  const locations=[
    {locationId:'A',data:{connections:['B','C']}},
    {locationId:'B',data:{connections:['A']}},
    {locationId:'C',data:{connections:['A']}}
  ];
  assert.equal(nextHop(locations,'A',null,'B'),'C');
});

test('autonomy builds the heavy decision context in batch for the whole tick',()=>{
  const decision=read('services/decision-service.js');
  const autonomy=read('services/autonomy-service.js');
  const engine=read('simulation/engine.js');
  assert.match(decision,/async function buildDecisionContexts\(simulationId,entityIds=/);
  assert.match(decision,/PARTITION BY entity_id/);
  assert.match(decision,/entity_id IN \(\$\{placeholders\}\)/);
  assert.match(autonomy,/prepareTickAutonomyContext/);
  assert.match(autonomy,/recallContexts\(/);
  assert.match(autonomy,/buildSocialContexts\(/);
  assert.match(engine,/autonomyService\.prepareTickAutonomyContext/);
  assert.match(engine,/batchContext: autonomyBatchContext/);
});

test('batched cognitive profiles preserve per-actor memory and plan limits',()=>{
  const source=read('services/personality-service.js');
  const start=source.indexOf('async function getCognitiveProfiles');
  const end=source.indexOf('\nasync function updateMentalState',start);
  const section=source.slice(start,end);
  for(const limit of [24,24,24,16,8]) assert.match(section,new RegExp('rn<='+limit));
  assert.match(section,/ROW_NUMBER\(\) OVER\(PARTITION BY entity_id/);
});

test('batched memory recall updates selected memories with one set-based write',()=>{
  const source=read('services/memory-service.js');
  const start=source.indexOf('async function recallContexts');
  const end=source.indexOf('\nasync function recallContext',start);
  const section=source.slice(start,end);
  assert.match(section,/ROW_NUMBER\(\) OVER\(PARTITION BY entity_id/);
  assert.match(section,/id IN \(\$\{selectedPlaceholders\}\)/);
  assert.doesNotMatch(section,/for\(const id of selectedIds\)await pool\.query/);
});

test('batched autonomy refreshes only mutable physiological state before deciding',()=>{
  const source=read('services/autonomy-service.js');
  assert.match(source,/latestNeeds=await readNeeds\(entityId\)/);
  assert.match(source,/rebuildDecisionCandidates/);
  assert.match(source,/recoveryBlocks:decisionService\.activeRecoveryBlocks/);
});

test('batched decision context keeps resource-unavailable knowledge semantics',()=>{
  const source=read('services/decision-service.js');
  assert.match(source,/RESOURCE_UNAVAILABLE/);
  assert.match(source,/resourceKnowledge/);
  assert.match(source,/recentlyBlocked:Boolean\(blockedResources\[resource\]\)/);
});
