const express = require('express');
const { uuid } = require('../api/validation');
const { getMind, getIdentity, getSocialMind, getLatestCognitiveState } = require('./cognitive-v2-service');
const { getEmergentMind } = require('./cognitive-v3-service');
const { getCausalMind } = require('./cognitive-causal-service');
const { pool } = require('../db/pool');

async function assertEntityInSimulation(simulationId,entityId){
    const [rows]=await pool.query(`SELECT id FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`,[simulationId,entityId]);
    if(!rows.length)throw Object.assign(new Error('Entity not found'),{code:'NOT_FOUND'});
  }

function buildCognitiveRouter() {
  const router = express.Router();

  router.get('/simulations/:simulationId/mind/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    await assertEntityInSimulation(simulationId,entityId);
    const [mind, emergent, causal] = await Promise.all([
      getMind(simulationId, entityId),
      getEmergentMind(simulationId, entityId),
      getCausalMind(simulationId, entityId),
    ]);
    res.json({ ...mind, emergent, causal });
  });

  router.get('/simulations/:simulationId/cognitive/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    await assertEntityInSimulation(simulationId,entityId);
    const [identity, state, social, emergent, causal] = await Promise.all([
      getIdentity(simulationId, entityId),
      getLatestCognitiveState(simulationId, entityId),
      getSocialMind(simulationId, entityId),
      getEmergentMind(simulationId, entityId),
      getCausalMind(simulationId, entityId),
    ]);
    res.json({ identity, state, social, emergent, causal });
  });

  router.get('/simulations/:simulationId/causal/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    await assertEntityInSimulation(simulationId,entityId);
    res.json(await getCausalMind(simulationId, entityId, Number(req.query.limit) || 60));
  });

  router.get('/simulations/:simulationId/promises/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    await assertEntityInSimulation(simulationId,entityId);
    const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,title,description,BIN_TO_UUID(target_entity_id) AS targetEntityId,due_simulation_at AS dueSimulationAt,status,importance,created_simulation_at AS createdAt FROM promises WHERE simulation_id=UUID_TO_BIN(?) AND issuer_entity_id=UUID_TO_BIN(?) ORDER BY CASE WHEN status='OPEN' THEN 0 ELSE 1 END,due_simulation_at IS NULL,due_simulation_at ASC`, [simulationId,entityId]);
    res.json(rows);
  });

  return router;
}

module.exports = { buildCognitiveRouter };