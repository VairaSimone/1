const { pool } = require('../db/pool');
const decisionService = require('./decision-service');
const actionService = require('./action-service');
const chatService = require('./chat-service');
const { ACTIONS } = require('./decision-rules');
const {
  install: installSchema,
} = require('./cognitive-v2-schema');
const cognitive = require('./cognitive-v2-service');
const { upsertBelief } = require('./personality-service');
const { applyEmotions, getTraits, persistNeedTransition } = require('./state-service');
const logger = require('../lib/logger');

let installed = false;
let originalBuildDecisionContext = null;
let originalMakeDecision = null;
let originalCompleteAction = null;
let originalSendMessage = null;

const WORLD2_ACTIONS = [
  'COOKING','DRAWING','WRITING','LISTENING_MUSIC','USING_DEVICE','CLEANING','BATHING',
  'CREATING','SHOPPING','HELPING','TEACHING','LEARNING','ARGUING','APOLOGIZING',
  'GIVING','RECEIVING','ATTENDING_EVENT'
];

const ACTION_PROFILES = {
  COOKING: { base: 0.18, needs: { HUNGER: 0.65 }, values: ['CREATIVITY','ACHIEVEMENT'], locations: ['HOME','WORKSHOP'] },
  DRAWING: { base: 0.22, needs: { FUN: 0.55, CURIOSITY: 0.35 }, values: ['CREATIVITY','CURIOSITY'], locations: ['HOME','PARK','LIBRARY'] },
  WRITING: { base: 0.18, needs: { ACHIEVEMENT: 0.55, CURIOSITY: 0.30 }, values: ['CREATIVITY','LEARNING','ACHIEVEMENT'], locations: ['HOME','LIBRARY','WORKSHOP'] },
  LISTENING_MUSIC: { base: 0.20, needs: { FUN: 0.65 }, values: ['CREATIVITY'], locations: ['HOME','PARK','GYM'] },
  USING_DEVICE: { base: 0.12, needs: { CURIOSITY: 0.35, FUN: 0.30 }, values: ['CURIOSITY','INDEPENDENCE'], locations: ['HOME','LIBRARY','CAFE'] },
  CLEANING: { base: 0.10, needs: { COMFORT: 0.60 }, values: ['ACHIEVEMENT','INDEPENDENCE'], locations: ['HOME'] },
  BATHING: { base: 0.12, needs: { COMFORT: 0.60, SAFETY: 0.20 }, values: ['SAFETY','INDEPENDENCE'], locations: ['HOME'] },
  CREATING: { base: 0.20, needs: { ACHIEVEMENT: 0.50, FUN: 0.35 }, values: ['CREATIVITY','INDEPENDENCE'], locations: ['HOME','WORKSHOP'] },
  SHOPPING: { base: 0.10, needs: { HUNGER: 0.40, CURIOSITY: 0.20 }, values: ['INDEPENDENCE'], locations: ['SHOP','CAFE'] },
  HELPING: { base: 0.10, needs: { SOCIAL_NEED: 0.25, BELONGING: 0.35 }, values: ['KINDNESS','SOCIAL_CONNECTION'], locations: ['COMMUNITY','CAFE','PARK','SCHOOL'] },
  TEACHING: { base: 0.08, needs: { ACHIEVEMENT: 0.35, SOCIAL_NEED: 0.25 }, values: ['KINDNESS','ACHIEVEMENT'], locations: ['SCHOOL','COMMUNITY','LIBRARY'] },
  LEARNING: { base: 0.18, needs: { CURIOSITY: 0.75, ACHIEVEMENT: 0.40 }, values: ['LEARNING','CURIOSITY'], locations: ['LIBRARY','SCHOOL','WORKSHOP','NATURE'] },
  ARGUING: { base: 0.03, needs: { SOCIAL_NEED: 0.25 }, values: ['INDEPENDENCE'], locations: ['CAFE','SCHOOL','COMMUNITY'] },
  APOLOGIZING: { base: 0.02, needs: { BELONGING: 0.35 }, values: ['KINDNESS','SOCIAL_CONNECTION'], locations: ['CAFE','COMMUNITY','SCHOOL'] },
  GIVING: { base: 0.04, needs: { BELONGING: 0.28 }, values: ['KINDNESS','SOCIAL_CONNECTION'], locations: ['COMMUNITY','CAFE'] },
  RECEIVING: { base: 0.03, needs: { BELONGING: 0.18 }, values: ['SOCIAL_CONNECTION'], locations: ['COMMUNITY','CAFE'] },
  ATTENDING_EVENT: { base: 0.12, needs: { FUN: 0.48, SOCIAL_NEED: 0.48 }, values: ['SOCIAL_CONNECTION','CURIOSITY'], locations: ['COMMUNITY','PARK','SCHOOL'] },
};

const ACTION_FEEDBACK = {
  COOKING: { HUNGER: -0.42, COMFORT: 0.08 },
  DRAWING: { FUN: -0.26, CURIOSITY: -0.18 },
  WRITING: { ACHIEVEMENT: -0.34, CURIOSITY: -0.14 },
  LISTENING_MUSIC: { FUN: -0.34, COMFORT: 0.06 },
  USING_DEVICE: { CURIOSITY: -0.12, FUN: -0.10 },
  CLEANING: { COMFORT: -0.34 },
  BATHING: { COMFORT: -0.42, SAFETY: 0.04 },
  CREATING: { ACHIEVEMENT: -0.30, FUN: -0.18, CURIOSITY: -0.10 },
  SHOPPING: { CURIOSITY: -0.08 },
  HELPING: { SOCIAL_NEED: -0.18, BELONGING: -0.22 },
  TEACHING: { SOCIAL_NEED: -0.20, ACHIEVEMENT: -0.22 },
  LEARNING: { CURIOSITY: -0.42, ACHIEVEMENT: -0.18 },
  ARGUING: { SOCIAL_NEED: -0.10, BELONGING: 0.05 },
  APOLOGIZING: { BELONGING: -0.25, SOCIAL_NEED: -0.12 },
  GIVING: { BELONGING: -0.12, SOCIAL_NEED: -0.08 },
  RECEIVING: { BELONGING: -0.08 },
  ATTENDING_EVENT: { SOCIAL_NEED: -0.25, FUN: -0.20 },
};

const DESIRE_BY_ACTION = {
  EXPLORING: 'UNDERSTAND_WORLD', READING: 'UNDERSTAND_WORLD', LEARNING: 'UNDERSTAND_WORLD',
  TALKING: 'MEANINGFUL_RELATIONSHIPS', HELPING: 'MEANINGFUL_RELATIONSHIPS',
  APOLOGIZING: 'MEANINGFUL_RELATIONSHIPS', GIVING: 'MEANINGFUL_RELATIONSHIPS', RECEIVING: 'MEANINGFUL_RELATIONSHIPS',
  STUDYING: 'BECOME_CAPABLE', WORKING: 'BECOME_CAPABLE', DRAWING: 'BECOME_CAPABLE', WRITING: 'BECOME_CAPABLE', CREATING: 'BECOME_CAPABLE', TEACHING: 'BECOME_CAPABLE',
  WALKING: 'MAINTAIN_AGENCY', SHOPPING: 'MAINTAIN_AGENCY', USING_DEVICE: 'MAINTAIN_AGENCY', CLEANING: 'MAINTAIN_AGENCY', BATHING: 'MAINTAIN_AGENCY',
};

function normalize(value) { return String(value || '').trim().toUpperCase(); }
function parseJson(value, fallback = {}) { if (value === null || value === undefined) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return fallback; } }
function clamp01(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; }
function round(value, digits = 5) { const p = 10 ** digits; return Math.round(Number(value) * p) / p; }

async function ensureV2TablesAndIdentity() {
  await installSchema();
}

function scoreWorldAction(action, context, identity) {
  const profile = ACTION_PROFILES[action];
  if (!profile) return 0;
  const needs = new Map((context.needs || []).map(n => [normalize(n.code), clamp01(n.value)]));
  const values = new Map((identity.values || []).map(v => [normalize(v.code), clamp01(v.importance)]));
  const location = normalize(context.location?.locationType);
  let score = profile.base;
  for (const [need, weight] of Object.entries(profile.needs || {})) score += (needs.get(need) || 0) * weight;
  for (const code of profile.values || []) score += (values.get(code) || 0.5) * 0.16;
  if (profile.locations?.includes(location)) score += 0.22;
  if ((context.cognitiveV2?.conflicts || []).some(c => normalize(c.left?.code) === 'CURIOSITY' || normalize(c.right?.code) === 'CURIOSITY') && ['LEARNING','CREATING','DRAWING','WRITING'].includes(action)) score += 0.12;
  if (context.cognitiveV2?.identity?.desires?.some(d => normalize(d.desireKey) === normalize(DESIRE_BY_ACTION[action]) && Number(d.progress || 0) < 1)) score += 0.18;
  return Math.max(0, Math.min(3, score));
}

function addWorld2Candidates(context, identity) {
  const existing = Array.isArray(context.candidates) ? context.candidates.map(c => ({ ...c })) : [];
  for (const action of WORLD2_ACTIONS) {
    const score = scoreWorldAction(action, context, identity);
    existing.push({ action, score, world2: true });
  }
  context.candidates = existing.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  context.allowedActionTypes = [...new Set([...(context.allowedActionTypes || []), ...WORLD2_ACTIONS])];
  return context;
}

async function enrichDecisionContext(simulationId, entityId, simulationTime, context) {
  const enriched = await cognitive.enrichContext({ simulationId, entityId, simulationTime, context });
  const identity = enriched.cognitiveV2.identity;
  addWorld2Candidates(enriched, identity);
  const promises = await cognitive.getOpenPromises(simulationId, entityId);
  if (promises.length) enriched.cognitiveV2.promises = promises.map(p => ({ id:p.id, title:p.title, dueSimulationAt:p.dueSimulationAt, importance:Number(p.importance||0) }));
  return enriched;
}

function predictionForAction(actionType, context, candidate) {
  const needEffects = ACTION_FEEDBACK[actionType] || {};
  const needs = {};
  for (const need of context.needs || []) needs[normalize(need.code)] = round(Number(need.value || 0));
  for (const [code, delta] of Object.entries(needEffects)) needs[normalize(code)] = round(clamp01(Number(needs[normalize(code)] || 0) + Number(delta)));
  const utility = clamp01(0.5 + Math.tanh(Number(candidate?.score || 0) / 2) * 0.35);
  return { expectedNeedState: needs, actionType: normalize(actionType), utility, narrative: `Expected outcome for ${normalize(actionType).toLowerCase().replaceAll('_', ' ')}` };
}

async function createDecisionCognition({ simulationId, entityId, simulationTime, decision, context }) {
  const candidateMap = new Map((context.candidates || []).map(c => [normalize(c.action), c]));
  const chosen = candidateMap.get(normalize(decision.actionType));
  const chosenPrediction = predictionForAction(decision.actionType, context, chosen);
  const alternatives = (context.candidates || []).filter(c => normalize(c.action) !== normalize(decision.actionType)).slice(0, 4);
  const expectationId = await cognitive.recordExpectation({
    simulationId, entityId, decisionId: decision.decisionId, simulationTime,
    actionType: decision.actionType,
    expectedUtility: chosenPrediction.utility,
    expectedSuccessProbability: clamp01(0.42 + chosenPrediction.utility * 0.50),
    prediction: chosenPrediction,
  });
  const counterfactualIds = await cognitive.createCounterfactuals({
    simulationId, entityId, decisionId: decision.decisionId, simulationTime,
    alternatives: alternatives.map(c => ({ action: c.action, utility: clamp01(0.5 + Math.tanh(Number(c.score || 0) / 2) * 0.35), predictedOutcome: predictionForAction(c.action, context, c), selectedAction: decision.actionType })),
  });
  return { expectationId, counterfactualIds };
}

async function applyWorld2Feedback({ simulationId, entityId, actionType, simulationTime, outcome, actionId = null, eventId = null }) {
  if (String(outcome || '').toUpperCase() !== 'SUCCESS') return [];
  const feedback = ACTION_FEEDBACK[normalize(actionType)];
  if (!feedback) return [];
  const codes = Object.keys(feedback);
  if (!codes.length) return [];
  const placeholders = codes.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT BIN_TO_UUID(enc.need_id) AS needId,nd.code,enc.value,enc.version FROM entity_needs_current enc JOIN need_definitions nd ON nd.id=enc.need_id WHERE enc.entity_id=UUID_TO_BIN(?) AND nd.active=1 AND nd.code IN (${placeholders})`, [entityId, ...codes]);
  const changes = [];
  for (const row of rows) {
    const delta = Number(feedback[row.code] || 0);
    if (!delta) continue;
    const oldValue = clamp01(row.value);
    const nextValue = clamp01(oldValue + delta);
    if (Math.abs(nextValue - oldValue) < 0.000001) continue;
    const transition = await persistNeedTransition({
      entityId,
      needId: row.needId,
      code: row.code,
      oldValue,
      nextValue,
      version: row.version,
      simulationTime,
      causeEventId: eventId,
      causeActionId: actionId,
      significant: true
    });
    if (!transition) continue;
    changes.push({ code:row.code,old:oldValue,new:nextValue,delta:nextValue-oldValue });
  }
  return changes;
}

async function learnCompletion({ simulationId, entityId, simulationTime, result, args }) {
  const decisionId = args?.decisionId;
  if (!decisionId || !result?.outcome) return { expectation: null, regret: 0 };
  const [alternativeRows] = await pool.query(`SELECT predicted_utility AS predictedUtility FROM counterfactuals WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND decision_id=UUID_TO_BIN(?)`, [simulationId,entityId,decisionId]);
  const expectation = await cognitive.resolveExpectation({ simulationId,entityId,decisionId,simulationTime,actualOutcome:result.outcome,alternativeUtilities:alternativeRows.map(r => Number(r.predictedUtility || 0)) });
  if (!expectation) return { expectation: null, regret: 0 };
  await cognitive.applyRegretToCounterfactuals({ simulationId,entityId,decisionId,regret:expectation.regret,simulationTime });
  await cognitive.learnFromOutcome({ simulationId,entityId,simulationTime,actionType:args.actionType,outcome:result.outcome,decisionId,expectation,targetEntityId:result.targetEntityId || null });
  if (Math.abs(Number(expectation.predictionError || 0)) >= 0.35) {
    await upsertBelief({ simulationId,entityId,simulationTime,item:{ predicate:`ACTION_OUTCOME_${normalize(args.actionType).slice(0,70)}`, objectValue:{ actionType:normalize(args.actionType), outcome:normalize(result.outcome), predictionError:Number(expectation.predictionError.toFixed(4)), regret:Number(expectation.regret.toFixed(4)) }, confidence:clamp01(0.55 + Math.abs(Number(expectation.predictionError))*0.30), importance:0.68 } });
  }
  return expectation;
}

async function maybeRecordNarrative({ simulationId, entityId, simulationTime, args, result }) {
  const outcome = normalize(result?.outcome);
  const significant = outcome !== 'SUCCESS' || Boolean(result?.targetEntityId) || ['EXPLORING','LEARNING','CREATING','DRAWING','WRITING','HELPING','TEACHING','APOLOGIZING'].includes(normalize(args?.actionType));
  if (!significant) return null;
  const [rows] = await pool.query(`SELECT created_simulation_at AS createdAt FROM life_narratives WHERE simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) ORDER BY chapter_index DESC LIMIT 1`, [simulationId,entityId]);
  if (rows.length && new Date(simulationTime) - new Date(rows[0].createdAt) < 6 * 3600000) return null;
  const actionLabel = normalize(args.actionType).toLowerCase().replaceAll('_',' ');
  const summary = outcome === 'SUCCESS'
    ? `I ${actionLabel} and the experience reinforced what I am learning about myself and my world.`
    : `I ${actionLabel}, but the result was ${outcome.toLowerCase()}. I now have to account for what went wrong.`;
  return cognitive.recordLifeNarrative(simulationId,entityId,simulationTime,{title:`${actionLabel} — ${outcome}`,summary,importance:outcome === 'FAILURE' ? 0.82 : 0.58,eventId:result.eventId || null});
}

async function postCompletionCognition(args, result) {
  if (!result?.completed || !args?.simulationId || !args?.entityId) return;
  try {
    const feedback = await applyWorld2Feedback({ simulationId:args.simulationId,entityId:args.entityId,actionType:args.actionType,simulationTime:args.simulationTime,outcome:result.outcome,actionId:args.actionId,eventId:args.eventId || result.eventId || null });
    if (feedback.length) await applyEmotions(args.entityId,args.simulationTime,feedback,result.eventId || null,args.actionId,args.actionType,0,{ event:true,outcome:result.outcome,targetEntityId:result.targetEntityId || null,meaning:'WORLD2_FEEDBACK' });
    const expectation = await learnCompletion({ simulationId:args.simulationId,entityId:args.entityId,simulationTime:args.simulationTime,result,args });
    const desireKey = DESIRE_BY_ACTION[normalize(args.actionType)];
    if (desireKey) await cognitive.updateDesireProgress(args.simulationId,args.entityId,args.simulationTime,{ desireKey,delta:result.outcome === 'SUCCESS' ? 0.025 : 0.004,reason:`${normalize(args.actionType)} outcome ${normalize(result.outcome)}` });
    const selfView = result.outcome === 'SUCCESS'
      ? `I learn from ${normalize(args.actionType).toLowerCase().replaceAll('_',' ')} and can improve through experience.`
      : `I am still learning how to handle ${normalize(args.actionType).toLowerCase().replaceAll('_',' ')} when things do not go as expected.`;
    await cognitive.updateSelfModel(args.simulationId,args.entityId,args.simulationTime,{ currentSelfView:selfView });
    await maybeRecordNarrative({simulationId:args.simulationId,entityId:args.entityId,simulationTime:args.simulationTime,args,result});
    if (expectation?.regret > 0.45) await cognitive.upsertIdentityValue({simulationId:args.simulationId,entityId:args.entityId,simulationTime:args.simulationTime,code:'LEARNING',confidenceDelta:0.018,salience:0.9});
  } catch (err) {
    logger.warn({ simulationId:args.simulationId, entityId:args.entityId, actionId:args.actionId, err }, 'Cognitive v2 post-action learning failed; core action result kept');
  }
}

function installGeminiCognitiveContext(gemini) {
  if (!gemini || gemini.__cognitiveV2Wrapped) return;
  gemini.__cognitiveV2Wrapped = true;
  const originalGenerate = gemini.generateJson.bind(gemini);
  gemini.generateJson = async (prompt, schema, options = {}) => {
    const mandate = [
      'Cognitive v2 mandate:',
      'Treat attention, interpretation, identity, values, long-term desires, self-beliefs, expectations, prediction error, regret, social obligations and narrative continuity as persistent internal state.',
      'When the context exposes competing motives, reason about the conflict before choosing.',
      'When new evidence contradicts a belief, prefer calibrated belief revision rather than inventing certainty.',
      'Use counterfactual thinking for consequential choices and use reflection to explain uncertainty.',
      'Respect the deterministic substrate and never invent entity or location identifiers.',
    ].join('\\n');
    return originalGenerate(`${prompt}\\n${mandate}`, schema, options);
  };
}

function install({ gemini } = {}) {
  if (installed) return;
  installed = true;
  return (async () => {
    await ensureV2TablesAndIdentity();
    for (const action of WORLD2_ACTIONS) if (!ACTIONS.includes(action)) ACTIONS.push(action);
    installGeminiCognitiveContext(gemini);

    originalBuildDecisionContext = decisionService.buildDecisionContext;
    decisionService.buildDecisionContext = async function wrappedBuildDecisionContext(simulationId, entityId, simulationTime) {
      const context = await originalBuildDecisionContext.apply(this, arguments);
      return enrichDecisionContext(simulationId, entityId, simulationTime || context.simulationTime || new Date(), context);
    };

    originalMakeDecision = decisionService.makeDecision;
    decisionService.makeDecision = async function wrappedMakeDecision(args = {}) {
      const simulationTime = args.simulationTime || args.context?.simulationTime || new Date();
      const context = args.context?.cognitiveV2 ? args.context : await enrichDecisionContext(args.simulationId,args.entityId,simulationTime,args.context || {});
      const result = await originalMakeDecision.call(this,{...args,context});
      try { result.cognitiveV2 = await createDecisionCognition({simulationId:args.simulationId,entityId:args.entityId,simulationTime,decision:result,context}); } catch (err) { logger.warn({err,simulationId:args.simulationId,entityId:args.entityId,decisionId:result?.decisionId},'Could not persist cognitive v2 expectation'); }
      return result;
    };

    originalCompleteAction = actionService.completeAction;
    actionService.completeAction = async function wrappedCompleteAction(args = {}) {
      const result = await originalCompleteAction.call(this,args);
      void postCompletionCognition(args,result);
      return result;
    };

    originalSendMessage = chatService.sendMessage;
    chatService.sendMessage = async function wrappedSendMessage(args = {}) {
      const result = await originalSendMessage.call(this,args);
      try {
        await cognitive.processConversationCommitments({simulationId:args.simulationId,entityId:args.asamiEntityId,simulationTime:args.simulationTime,content:args.content});
        await cognitive.updateReputationAfterInteraction({simulationId:args.simulationId,entityId:args.asamiEntityId,observerEntityId:args.senderEntityId,simulationTime:args.simulationTime,delta:result?.aiUsed ? 0.03 : 0.01});
        const identity = await cognitive.getIdentity(args.simulationId,args.asamiEntityId);
        if (identity?.values?.some(v => normalize(v.code) === 'SOCIAL_CONNECTION')) {
          await cognitive.upsertIdentityValue({simulationId:args.simulationId,entityId:args.asamiEntityId,simulationTime:args.simulationTime,code:'SOCIAL_CONNECTION',confidenceDelta:0.012,salience:0.72});
        }
      } catch (err) { logger.warn({err,simulationId:args.simulationId,entityId:args.asamiEntityId},'Cognitive v2 conversation enrichment failed; message kept'); }
      return result;
    };
  })().catch(err => {
    installed = false;
    throw err;
  });
}

module.exports = { install, WORLD2_ACTIONS, ACTION_PROFILES, ACTION_FEEDBACK };
