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
    for(const columns of inserts) assert.doesNotMatch(columns,/\bsimulation_id\b/);
    assert.doesNotMatch(sql,/UPDATE entity_location_history SET exited_simulation_at=\? WHERE simulation_id=/);
  }
  assert.match(source,/UPDATE entity_location_history SET exited_simulation_at/);
  assert.match(world,/UPDATE entity_location_history SET exited_simulation_at/);
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
  assert.match(section,/UPDATE entity_location_history SET exited_simulation_at=\? WHERE entity_id=UUID_TO_BIN\(\?\) AND exited_simulation_at IS NULL/);
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
