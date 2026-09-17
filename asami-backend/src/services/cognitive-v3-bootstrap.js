const decisionService = require('./decision-service');
const actionService = require('./action-service');
const { install: installSchema } = require('./cognitive-v3-schema');
const { install: installCausalSchema } = require('./cognitive-causal-schema');
const emergent = require('./cognitive-v3-service');
const causal = require('./cognitive-causal-service');
const logger = require('../lib/logger');

let installed = false;
let originalMakeDecision = null;
let originalCompleteAction = null;

function normalize(value) { return String(value ?? '').trim().toUpperCase(); }

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
      if (!decisionId && actionId && simulationId && entityId) {
        const { pool } = require('../db/pool');
        const [rows] = await pool.query(`SELECT BIN_TO_UUID(decision_id) AS decisionId,JSON_UNQUOTE(JSON_EXTRACT(parameters,'$.targetEntityId')) AS targetEntityId FROM actions WHERE id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) LIMIT 1`, [actionId,simulationId,entityId]);
        decisionId = rows[0]?.decisionId || null;
        targetEntityId = targetEntityId || rows[0]?.targetEntityId || null;
      }
      if (simulationId && entityId && simulationTime && actionType && outcome) {
        void emergent.processExperience({ simulationId,entityId,simulationTime,actionType,outcome,actionId,decisionId,targetEntityId });
        void causal.processExperience({ simulationId,entityId,simulationTime,actionType,outcome,actionId,decisionId,targetEntityId });
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