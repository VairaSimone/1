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
