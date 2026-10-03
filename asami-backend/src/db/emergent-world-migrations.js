const { pool } = require("./pool");

async function ensureEmergentWorldMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_projects (
      id BINARY(16) PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      proposer_entity_id BINARY(16) NOT NULL,
      scope_location_id BINARY(16) NULL,
      project_type VARCHAR(64) NOT NULL,
      issue_code VARCHAR(64) NOT NULL,
      title VARCHAR(180) NOT NULL,
      description VARCHAR(500) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'PROPOSED',
      support_score DECIMAL(8,4) NOT NULL DEFAULT 0,
      required_support INT NOT NULL DEFAULT 2,
      proposal JSON NULL,
      created_simulation_at DATETIME(3) NOT NULL,
      updated_simulation_at DATETIME(3) NOT NULL,
      completed_simulation_at DATETIME(3) NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_ep_sim_status (simulation_id, status),
      KEY idx_ep_scope_issue (simulation_id, scope_location_id, issue_code),
      KEY idx_ep_created (simulation_id, created_simulation_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_project_members (
      project_id BINARY(16) NOT NULL,
      simulation_id BINARY(16) NOT NULL,
      entity_id BINARY(16) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'SUPPORTER',
      motivation JSON NULL,
      joined_simulation_at DATETIME(3) NOT NULL,
      PRIMARY KEY (project_id, entity_id),
      KEY idx_epm_entity (simulation_id, entity_id),
      KEY idx_epm_project (simulation_id, project_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_structures (
      id BINARY(16) PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      project_id BINARY(16) NULL,
      entity_id BINARY(16) NOT NULL,
      structure_type VARCHAR(64) NOT NULL,
      name VARCHAR(180) NOT NULL,
      scope_location_id BINARY(16) NULL,
      activities JSON NULL,
      attributes JSON NULL,
      created_simulation_at DATETIME(3) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_es_sim_type (simulation_id, structure_type),
      KEY idx_es_scope (simulation_id, scope_location_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_systems (
      id BINARY(16) PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      system_type VARCHAR(64) NOT NULL,
      name VARCHAR(180) NOT NULL,
      scope_location_id BINARY(16) NULL,
      stage VARCHAR(32) NOT NULL DEFAULT 'EMERGING',
      attributes JSON NULL,
      created_simulation_at DATETIME(3) NOT NULL,
      updated_simulation_at DATETIME(3) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_ews_sim_type (simulation_id, system_type),
      KEY idx_ews_scope (simulation_id, scope_location_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_policies (
      id BINARY(16) PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      proposer_entity_id BINARY(16) NOT NULL,
      governance_system_id BINARY(16) NULL,
      scope_location_id BINARY(16) NULL,
      issue_code VARCHAR(64) NOT NULL,
      title VARCHAR(180) NOT NULL,
      statement VARCHAR(500) NOT NULL,
      parameters JSON NULL,
      support_score DECIMAL(8,4) NOT NULL DEFAULT 0,
      opposition_score DECIMAL(8,4) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'PROPOSED',
      created_simulation_at DATETIME(3) NOT NULL,
      updated_simulation_at DATETIME(3) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_epl_sim_issue (simulation_id, issue_code),
      KEY idx_epl_governance (simulation_id, governance_system_id)
    )
  `);

  const policyExpiryColumn = await pool.query(`SHOW COLUMNS FROM emergent_policies LIKE 'expires_simulation_at'`);
  if (!policyExpiryColumn[0]?.length) {
    await pool.query(`ALTER TABLE emergent_policies ADD COLUMN expires_simulation_at DATETIME(3) NULL AFTER updated_simulation_at`);
  }
  await pool.query(`
    UPDATE emergent_policies
       SET expires_simulation_at = DATE_ADD(updated_simulation_at, INTERVAL 72 HOUR)
     WHERE expires_simulation_at IS NULL
       AND issue_code LIKE 'ECONOMIC_%'
       AND status='ENACTED'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergent_conflicts (
      id BINARY(16) PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      scope_location_id BINARY(16) NULL,
      conflict_type VARCHAR(64) NOT NULL,
      left_type VARCHAR(32) NOT NULL,
      left_id BINARY(16) NOT NULL,
      right_type VARCHAR(32) NOT NULL,
      right_id BINARY(16) NOT NULL,
      intensity DECIMAL(8,4) NOT NULL DEFAULT 0.5,
      status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
      metadata JSON NULL,
      created_simulation_at DATETIME(3) NOT NULL,
      resolved_simulation_at DATETIME(3) NULL,
      version INT NOT NULL DEFAULT 1,
      KEY idx_ec_sim_status (simulation_id, status),
      KEY idx_ec_scope (simulation_id, scope_location_id)
    )
  `);
}

module.exports = { ensureEmergentWorldMigrations };