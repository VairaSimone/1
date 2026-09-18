const decisionService = require('./decision-service');
const actionService = require('./action-service');
const { install: installSchema } = require('./cognitive-v3-schema');
const { install: installCausalSchema } = require('./cognitive-causal-schema');
const emergent = require('./cognitive-v3-service');
const causal = require('./cognitive-causal-service');
const logger = require('../lib/logger');
const cognitiveQueue = require('./cognitive-queue');

let installed = false;
let originalMakeDecision = null;
let originalCompleteAction = null;

const processedActionIds = new Map();
const MAX_PROCESSED_ACTION_IDS = 10000;

function normalize(value) { return String(value ?? '').trim().toUpperCase(); }

function claimAction(actionId) {
  if (!actionId) return true;
  if (processedActionIds.has(actionId)) return false;
  processedActionIds.set(actionId, Date.now());
  if (processedActionIds.size > MAX_PROCESSED_ACTION_IDS) {
    const oldest = processedActionIds.keys().next().value;
    if (oldest) processedActionIds.delete(oldest);
  }
  return true;
}


async function install() {
  if (installed) return;
  await installSchema();
  await installCausalSchema();
  if (installed) return;

  originalMakeDecision = decisionService.makeDecision;
  decisionService.makeDecision = async function cognitiveV3MakeDecision(...args) {
    const result = await originalMakeDecision.apply(this,args);
    try {
      const decisionId = result?.decisionId || result?.id;
      const simulationId = args[0]?.simulationId || result?.simulationId;
      const entityId = args[0]?.entityId || result?.entityId;
      const simulationTime = args[0]?.simulationTime || result?.simulationTime;
      const actionType = result?.actionType || args[0]?.actionType;
      if (decisionId && simulationId && entityId && simulationTime && actionType) {
        await emergent.branchCounterfactuals({ simulationId,entityId,simulationTime,decisionId,actionType });
      }
    } catch (err) {
      logger.warn({ err: err.message },'Cognitive v3 counterfactual branching skipped');
    }
    return result;
  };

  originalCompleteAction = actionService.completeAction;
  actionService.completeAction = async function cognitiveV3CompleteAction(...args) {
    const result = await originalCompleteAction.apply(this,args);
    try {
      const input = args[0] || {};
      const simulationId = input.simulationId || result?.simulationId;
      const entityId = input.entityId || result?.entityId;
      const simulationTime = input.simulationTime || result?.simulationTime || result?.completedSimulationAt;
      const actionType = input.actionType || result?.actionType;
      const outcome = result?.outcome || result?.result?.outcome || input.outcome;
      const actionId = input.actionId || result?.actionId || result?.id || null;
      let decisionId = input.decisionId || result?.decisionId || null;
      let targetEntityId = result?.targetEntityId || input.targetEntityId || null;
      const shouldProcess = result?.completed !== false && simulationId && entityId && simulationTime && actionType && outcome && claimAction(actionId);

      if (shouldProcess) {
        if (!decisionId && actionId) {
          const { pool } = require('../db/pool');
          const [rows] = await pool.query(`SELECT BIN_TO_UUID(decision_id) AS decisionId,JSON_UNQUOTE(JSON_EXTRACT(parameters,'$.targetEntityId')) AS targetEntityId FROM actions WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [actionId,simulationId,entityId]);
          decisionId = rows[0]?.decisionId || null;
          targetEntityId = targetEntityId || rows[0]?.targetEntityId || null;
        }

        const cognitiveInput = { simulationId,entityId,simulationTime,actionType,outcome,actionId,decisionId,targetEntityId };
        void cognitiveQueue.enqueue(entityId, async () => {
          const results = await Promise.all([
            emergent.processExperience(cognitiveInput),
            causal.processExperience(cognitiveInput),
          ]);
          const emergentFailure = results[0]?.error;
          if (emergentFailure) {
            throw Object.assign(new Error(emergentFailure), { code: results[0]?.code || 'COGNITIVE_V3_FAILURE' });
          }
          return results;
        }, { retries: 3, baseDelayMs: 10 }).catch(err => {
          logger.warn({ err: err.message, simulationId, entityId, actionId, actionType, outcome },'Cognitive v3 post-action learning failed after retries');
        });
      }
    } catch (err) {
      logger.warn({ err: err.message },'Cognitive v3 post-action learning skipped');
    }
    return result;
  };

  installed = true;
  logger.info('Cognitive v3 + causal mind bootstrap installed');
}

module.exports = { install };