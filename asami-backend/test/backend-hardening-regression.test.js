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
