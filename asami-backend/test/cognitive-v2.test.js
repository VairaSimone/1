const test = require('node:test');
const assert = require('node:assert/strict');
const cognitive = require('../src/services/cognitive-v2-service');
const bootstrap = require('../src/services/cognitive-v2-bootstrap');

test('cognitive v2 exposes stable identity defaults and normalization', () => {
  assert.equal(cognitive.normalize('social connection'), 'SOCIAL_CONNECTION');
  assert.equal(cognitive.clamp01(2), 1);
  assert.equal(cognitive.clamp01(-1), 0);
  assert.ok(Array.isArray(bootstrap.WORLD2_ACTIONS));
  assert.ok(bootstrap.WORLD2_ACTIONS.includes('LEARNING'));
  assert.ok(bootstrap.WORLD2_ACTIONS.includes('HELPING'));
});

test('interpretation turns attention into explicit cognitive signals', () => {
  const interpretation = cognitive.buildInterpretation([
    { type: 'PHYSIOLOGICAL', code: 'THIRST', intensity: 0.91, reason: 'internal pressure' },
    { type: 'GOAL', goalId: 'goal-1', title: 'Learn something', intensity: 0.72 },
  ], {
    resourceContext: { actions: { DRINKING: { locallyAvailable: true } } },
    cognitiveV2: { conflicts: [] },
  });
  assert.equal(interpretation[0].type, 'PRIMARY_DRIVE');
  assert.match(interpretation[0].statement, /THIRST/i);
});

test('conflict detector exposes competing motives', () => {
  const conflicts = cognitive.buildConflicts({
    context: {
      needs: [
        { code: 'CURIOSITY', value: 0.83, priorityWeight: 0.7 },
        { code: 'SLEEPINESS', value: 0.80, priorityWeight: 1.1 },
      ],
      goals: [],
    },
    identity: { desires: [] },
  });
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].intensity > 0.7);
});

test('world action profiles provide executable actions beyond the legacy repertoire', () => {
  for (const action of ['COOKING','DRAWING','WRITING','CLEANING','BATHING','CREATING','SHOPPING','HELPING','TEACHING','LEARNING','ARGUING','APOLOGIZING','GIVING','RECEIVING','ATTENDING_EVENT']) {
    assert.ok(bootstrap.ACTION_PROFILES[action], `missing profile for ${action}`);
    assert.ok(bootstrap.ACTION_FEEDBACK[action], `missing feedback for ${action}`);
  }
});


test('learnFromOutcome uses the current identity upsert helper', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/services/cognitive-v2-service.js'), 'utf8');
  const start = source.indexOf('async function learnFromOutcome(');
  const end = source.indexOf('\\n\\nmodule.exports=', start);
  const learn = start >= 0 && end >= 0 ? source.slice(start, end) : '';
  assert.match(learn, /upsertIdentityValue\(/);
  assert.doesNotMatch(learn, /updateIdentityValue\(/);
});
