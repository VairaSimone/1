const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLink, normalizeActivation } = require('../src/services/cognitive-causal-api-guard');

test('causal API normalizes SQL DECIMAL fields to numbers', () => {
  const link = normalizeLink({ weight: '0.42', polarity: '-1', confidence: '0.75', evidenceCount: '9' });
  assert.equal(link.weight, 0.42);
  assert.equal(link.polarity, -1);
  assert.equal(link.confidence, 0.75);
  assert.equal(link.evidenceCount, 9);
});

test('causal API normalizes activation depth and magnitude', () => {
  const activation = normalizeActivation({ activation: '-0.6', depth: '2.8' });
  assert.equal(activation.activation, -0.6);
  assert.equal(activation.depth, 3);
});

test('causal API rejects non-finite numeric payloads safely', () => {
  const link = normalizeLink({ weight: 'not-a-number', confidence: null });
  const activation = normalizeActivation({ activation: 'NaN', depth: '-4' });
  assert.equal(link.weight, 0);
  assert.equal(link.confidence, 0);
  assert.equal(activation.activation, 0);
  assert.equal(activation.depth, 0);
});

test("engine and autonomy resolve live service modules after cognitive bootstraps", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const engineSource = fs.readFileSync(
    path.join(__dirname, "../src/simulation/engine.js"),
    "utf8"
  );
  const autonomySource = fs.readFileSync(
    path.join(__dirname, "../src/services/autonomy-service.js"),
    "utf8"
  );
  const serverSource = fs.readFileSync(
    path.join(__dirname, "../src/server.js"),
    "utf8"
  );
  const workerSource = fs.readFileSync(
    path.join(__dirname, "../src/worker.js"),
    "utf8"
  );

  assert.match(engineSource, /const actionService = require\("\.\.\/services\/action-service"\);/);
  assert.match(engineSource, /const autonomyService = require\("\.\.\/services\/autonomy-service"\);/);
  assert.doesNotMatch(
    engineSource,
    /const \{ completeAction, getActiveAction, learnFromAction/
  );
  assert.match(autonomySource, /const decisionService = require\("\.\/decision-service"\);/);
  assert.match(autonomySource, /const actionService = require\("\.\/action-service"\);/);
  assert.doesNotMatch(
    autonomySource,
    /const \{ buildDecisionContext, makeDecision \} = require\("\.\/decision-service"\);/
  );
  assert.ok(serverSource.indexOf('await cognitiveV3.install();') < serverSource.indexOf('require("./simulation/engine")'));
  assert.ok(workerSource.indexOf('await cognitiveV3.install();') < workerSource.indexOf('require("./simulation/engine")'));
});
