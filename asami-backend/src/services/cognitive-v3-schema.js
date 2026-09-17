const { pool } = require('../db/pool');
const logger = require('../lib/logger');

let installed = false;

const SQL = [
  `CREATE TABLE IF NOT EXISTS belief_evidence (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,belief_key VARCHAR(80) NOT NULL,polarity TINYINT NOT NULL DEFAULT 1,evidence_strength DECIMAL(6,5) NOT NULL DEFAULT 0.5,source_type VARCHAR(60) NOT NULL,source_ref BINARY(16) NULL,statement VARCHAR(500) NULL,created_simulation_at DATETIME(3) NOT NULL,metadata JSON NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_belief_evidence (simulation_id,entity_id,belief_key,created_simulation_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS self_model_snapshots (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,simulation_time DATETIME(3) NOT NULL,trigger_type VARCHAR(60) NOT NULL,self_view VARCHAR(1000) NOT NULL,capabilities JSON NULL,limitations JSON NULL,metrics JSON NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_self_model_snapshot (simulation_id,entity_id,simulation_time)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS memory_consolidations (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,consolidation_key VARCHAR(180) NOT NULL,memory_type VARCHAR(40) NOT NULL DEFAULT 'SEMANTIC',source_count INT NOT NULL DEFAULT 0,source_from DATETIME(3) NULL,source_to DATETIME(3) NULL,summary TEXT NOT NULL,confidence DECIMAL(6,5) NOT NULL DEFAULT 0.5,created_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_memory_consolidation (simulation_id,entity_id,consolidation_key),KEY idx_memory_consolidation_entity (simulation_id,entity_id,created_simulation_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS counterfactual_worlds (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,decision_id BINARY(16) NOT NULL,world_key VARCHAR(120) NOT NULL,selected TINYINT(1) NOT NULL DEFAULT 0,baseline_state JSON NULL,predicted_state JSON NULL,predicted_utility DECIMAL(8,5) NOT NULL DEFAULT 0,actual_outcome VARCHAR(30) NULL,regret_score DECIMAL(8,5) NOT NULL DEFAULT 0,status VARCHAR(20) NOT NULL DEFAULT 'OPEN',created_simulation_at DATETIME(3) NOT NULL,resolved_simulation_at DATETIME(3) NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_counterfactual_world (simulation_id,decision_id,world_key),KEY idx_counterfactual_world_entity (simulation_id,entity_id,created_simulation_at)) ENGINE=InnoDB`,
];

async function install() {
  if (installed) return;
  installed = true;
  try {
    const started = Date.now();
    for (const statement of SQL) await pool.query(statement);
    logger.info({ durationMs: Date.now() - started }, 'Cognitive v3 schema ready');
  } catch (err) {
    installed = false;
    throw err;
  }
}

module.exports = { install };