const express = require('express');
const { uuid } = require('./validation');
const { getMind, getIdentity, getSocialMind, getLatestCognitiveState } = require('../services/cognitive-v2-service');
const { pool } = require('../db/pool');

function buildCognitiveRouter() {
  const router = express.Router();

  router.get('/simulations/:simulationId/mind/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    const mind = await getMind(simulationId, entityId);
    res.json(mind);
  });

  router.get('/simulations/:simulationId/cognitive/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    const [identity, state, social] = await Promise.all([
      getIdentity(simulationId, entityId),
      getLatestCognitiveState(simulationId, entityId),
      getSocialMind(simulationId, entityId),
    ]);
    res.json({ identity, state, social });
  });

  router.get('/simulations/:simulationId/promises/:entityId', async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const entityId = uuid.parse(req.params.entityId);
    const [rows] = await pool.query(`SELECT BIN_TO_UUID(id) AS id,title,description,target_entity_id AS targetEntityId,due_simulation_at AS dueSimulationAt,status,importance,created_simulation_at AS createdAt FROM promises WHERE simulation_id=UUID_TO_BIN(?) AND issuer_entity_id=UUID_TO_BIN(?) ORDER BY CASE WHEN status='OPEN' THEN 0 ELSE 1 END,due_simulation_at IS NULL,due_simulation_at ASC`, [simulationId,entityId]);
    res.json(rows);
  });

  return router;
}

module.exports = { buildCognitiveRouter };
