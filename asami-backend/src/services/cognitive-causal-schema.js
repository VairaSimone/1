const { pool } = require('../db/pool');
const logger = require('../lib/logger');

let installed = false;

const SQL = [
  `CREATE TABLE IF NOT EXISTS causal_links (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,source_type VARCHAR(60) NOT NULL,source_key VARCHAR(180) NOT NULL,target_type VARCHAR(60) NOT NULL,target_key VARCHAR(180) NOT NULL,weight DECIMAL(7,5) NOT NULL DEFAULT 0,polarity TINYINT NOT NULL DEFAULT 1,confidence DECIMAL(6,5) NOT NULL DEFAULT 0.5,evidence_count INT NOT NULL DEFAULT 0,last_activated_simulation_at DATETIME(3) NULL,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',version BIGINT NOT NULL DEFAULT 1,created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,UNIQUE KEY uq_causal_link (simulation_id,entity_id,source_type,source_key,target_type,target_key),KEY idx_causal_source (simulation_id,entity_id,source_type,source_key,status),KEY idx_causal_target (simulation_id,entity_id,target_type,target_key,status)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS causal_activations (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,link_id BINARY(16) NULL,parent_activation_id BINARY(16) NULL,source_type VARCHAR(60) NOT NULL,source_key VARCHAR(180) NOT NULL,target_type VARCHAR(60) NOT NULL,target_key VARCHAR(180) NOT NULL,activation DECIMAL(8,5) NOT NULL DEFAULT 0,depth TINYINT NOT NULL DEFAULT 0,cause_type VARCHAR(60) NOT NULL,cause_ref BINARY(16) NULL,simulation_time DATETIME(3) NOT NULL,metadata JSON NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_causal_activation_entity (simulation_id,entity_id,simulation_time),KEY idx_causal_activation_parent (parent_activation_id)) ENGINE=InnoDB`,
];

async function install() {
  if (installed) return;
  installed = true;
  try {
    const started = Date.now();
    for (const statement of SQL) await pool.query(statement);
    logger.info({ durationMs: Date.now() - started }, 'Causal mind schema ready');
  } catch (err) {
    installed = false;
    throw err;
  }
}

module.exports = { install };