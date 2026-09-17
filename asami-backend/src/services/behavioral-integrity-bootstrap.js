const { pool } = require("../db/pool");
const behavioral = require("./behavioral-policy-bootstrap");

let installed = false;

async function persistFinalDriver(decisionId, context, result, classification) {
  if (!decisionId) return;

  const proactivity = behavioral.buildProactivity({
    ...context,
    behavioralClassification: classification,
    behavioralDriver: classification.driver
  }, result?.actionType);

  const finalContext = {
    ...context,
    behavioralDriver: classification.driver,
    behavioralClassification: classification,
    proactivity,
    chosenAction: result?.actionType || null
  };

  await pool.query(`
    UPDATE decisions
    SET trigger_type=?, context=?
    WHERE id=UUID_TO_BIN(?)
  `, [
    proactivity.trigger,
    JSON.stringify(finalContext),
    decisionId
  ]);

  const [rows] = await pool.query(`
    SELECT selected_option_id AS selectedOptionId
    FROM decisions
    WHERE id=UUID_TO_BIN(?)
    LIMIT 1
  `, [decisionId]);
  const selectedOptionId = rows[0]?.selectedOptionId;
  if (!selectedOptionId) return;

  const [optionRows] = await pool.query(`
    SELECT evaluation
    FROM decision_options
    WHERE id=UUID_TO_BIN(?)
    LIMIT 1
  `, [selectedOptionId]);
  const evaluation = optionRows[0]?.evaluation;
  let parsed = {};
  if (evaluation && typeof evaluation === "object") parsed = evaluation;
  else if (typeof evaluation === "string") {
    try { parsed = JSON.parse(evaluation); } catch { parsed = {}; }
  }

  await pool.query(`
    UPDATE decision_options
    SET evaluation=?
    WHERE id=UUID_TO_BIN(?)
  `, [
    JSON.stringify({ ...parsed, behavioralDriver: classification.driver, proactivity }),
    selectedOptionId
  ]);
}

function installDecisionIntegrity() {
  const decisionService = require("./decision-service");
  const originalMakeDecision = decisionService.makeDecision;

  decisionService.makeDecision = async function preservedBehavioralDriver(args = {}) {
    const context = { ...(args.context || {}) };
    const classification = behavioral.classifyBehavioralDriver(context);
    const result = await originalMakeDecision(args);
    const finalProactivity = behavioral.buildProactivity({
      ...context,
      behavioralClassification: classification,
      behavioralDriver: classification.driver
    }, result?.actionType);

    const finalResult = {
      ...result,
      behavioralDriver: classification.driver,
      proactivity: finalProactivity
    };

    await persistFinalDriver(result?.decisionId, context, finalResult, classification);
    return finalResult;
  };
}

async function persistAdultDevelopmentStage(simulationId, entityId) {
  await pool.query(`
    UPDATE entity_development ed
    JOIN development_stages ds
      ON ds.active=1
     AND ds.code IN ('ADULT','YOUNG_ADULT','MATURE_ADULT')
    SET ed.development_stage_id=ds.id
    WHERE ed.entity_id=UUID_TO_BIN(?)
      AND ds.id=(
        SELECT selected.id
        FROM (
          SELECT id
          FROM development_stages
          WHERE active=1
            AND code IN ('ADULT','YOUNG_ADULT','MATURE_ADULT')
          ORDER BY min_age_days DESC
          LIMIT 1
        ) selected
      )
  `, [entityId]);
}

function installAdultStagePersistence() {
  const simulationRepo = require("../repositories/simulation-repo");
  const originalCreateSimulation = simulationRepo.createSimulation;

  simulationRepo.createSimulation = async function persistAdultStage(args = {}) {
    const result = await originalCreateSimulation(args);
    if (result?.simulation?.id && result?.asamiEntityId) {
      await persistAdultDevelopmentStage(result.simulation.id, result.asamiEntityId);
    }
    return result;
  };
}

function install() {
  if (installed) return;
  installDecisionIntegrity();
  installAdultStagePersistence();
  installed = true;
}

module.exports = { install, persistAdultDevelopmentStage };
