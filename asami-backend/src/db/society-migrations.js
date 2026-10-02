const { pool } = require("./pool");

async function ensureSocietyMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS world_capabilities (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, location_id BINARY(16) NOT NULL, source_entity_id BINARY(16) NULL,
    code VARCHAR(80) NOT NULL, name VARCHAR(160) NOT NULL, category VARCHAR(48) NOT NULL, parameters JSON NULL, active TINYINT(1) NOT NULL DEFAULT 1,
    created_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_wc_location_code (simulation_id,location_id,code), KEY idx_wc_location (simulation_id,location_id,active)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_goods (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, code VARCHAR(64) NOT NULL, name VARCHAR(120) NOT NULL,
    category VARCHAR(48) NOT NULL, unit VARCHAR(24) NOT NULL DEFAULT 'unit', base_price DECIMAL(12,4) NOT NULL DEFAULT 1,
    created_simulation_at DATETIME(3) NOT NULL, UNIQUE KEY uq_eg_sim_code (simulation_id,code)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_economy_accounts (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, entity_id BINARY(16) NOT NULL,
    balance DECIMAL(16,4) NOT NULL DEFAULT 0, lifetime_income DECIMAL(16,4) NOT NULL DEFAULT 0,
    lifetime_spending DECIMAL(16,4) NOT NULL DEFAULT 0, last_updated_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_eea_entity (simulation_id,entity_id), KEY idx_eea_balance (simulation_id,balance)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_inventory (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, owner_entity_id BINARY(16) NOT NULL, good_code VARCHAR(64) NOT NULL,
    quantity DECIMAL(16,4) NOT NULL DEFAULT 0, updated_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_ei_owner_good (simulation_id,owner_entity_id,good_code), KEY idx_ei_good (simulation_id,good_code,quantity)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_jobs (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, employer_entity_id BINARY(16) NOT NULL, employee_entity_id BINARY(16) NOT NULL,
    role VARCHAR(80) NOT NULL, wage_per_hour DECIMAL(12,4) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    hired_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_ej_employee_active (simulation_id,employee_entity_id,status), KEY idx_ej_employer (simulation_id,employer_entity_id,status)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_market_state (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, location_id BINARY(16) NOT NULL, good_code VARCHAR(64) NOT NULL,
    price DECIMAL(12,4) NOT NULL DEFAULT 1, supply DECIMAL(16,4) NOT NULL DEFAULT 0, demand DECIMAL(16,4) NOT NULL DEFAULT 0,
    updated_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_ems_market_good (simulation_id,location_id,good_code)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_trades (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, buyer_entity_id BINARY(16) NOT NULL, seller_entity_id BINARY(16) NOT NULL,
    location_id BINARY(16) NOT NULL, good_code VARCHAR(64) NOT NULL, quantity DECIMAL(16,4) NOT NULL, unit_price DECIMAL(12,4) NOT NULL,
    total DECIMAL(16,4) NOT NULL, simulation_at DATETIME(3) NOT NULL, KEY idx_et_sim_time (simulation_id,simulation_at), KEY idx_et_good (simulation_id,good_code)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_wealth_history (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, entity_id BINARY(16) NOT NULL, balance DECIMAL(16,4) NOT NULL,
    rank_position INT NOT NULL, population_count INT NOT NULL, simulation_at DATETIME(3) NOT NULL,
    KEY idx_ewh_sim_time (simulation_id,simulation_at), KEY idx_ewh_entity (simulation_id,entity_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_economic_metrics (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, population_count INT NOT NULL, total_wealth DECIMAL(16,4) NOT NULL DEFAULT 0,
    average_wealth DECIMAL(16,4) NOT NULL DEFAULT 0, gini DECIMAL(8,5) NOT NULL DEFAULT 0, average_food_price DECIMAL(12,4) NOT NULL DEFAULT 1,
    total_trade_value DECIMAL(16,4) NOT NULL DEFAULT 0, simulation_at DATETIME(3) NOT NULL, KEY idx_eem_sim_time (simulation_id,simulation_at)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_policy_votes (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, policy_id BINARY(16) NOT NULL, voter_entity_id BINARY(16) NOT NULL,
    choice VARCHAR(16) NOT NULL, score DECIMAL(8,5) NOT NULL DEFAULT 0, rationale JSON NULL, simulation_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_epv_vote (simulation_id,policy_id,voter_entity_id), KEY idx_epv_policy (simulation_id,policy_id)
  )`);



  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_definition_catalog (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, kind VARCHAR(24) NOT NULL, code VARCHAR(80) NOT NULL,
    name VARCHAR(160) NOT NULL, category VARCHAR(64) NOT NULL, scope_location_id BINARY(16) NULL, origin_entity_id BINARY(16) NULL,
    origin_proposal_id BINARY(16) NULL, definition JSON NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
    created_simulation_at DATETIME(3) NOT NULL, updated_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_edc_sim_kind_code (simulation_id,kind,code), KEY idx_edc_scope (simulation_id,scope_location_id,status),
    KEY idx_edc_origin (simulation_id,origin_entity_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_world_proposals (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, proposer_entity_id BINARY(16) NOT NULL,
    scope_location_id BINARY(16) NULL, kind VARCHAR(24) NOT NULL, code VARCHAR(80) NOT NULL, title VARCHAR(180) NOT NULL,
    rationale JSON NULL, definition JSON NOT NULL, validation JSON NULL, support_score DECIMAL(8,5) NOT NULL DEFAULT 0,
    required_support INT NOT NULL DEFAULT 3, status VARCHAR(24) NOT NULL DEFAULT 'PROPOSED',
    created_simulation_at DATETIME(3) NOT NULL, decided_simulation_at DATETIME(3) NULL, version INT NOT NULL DEFAULT 1,
    KEY idx_ewp_sim_status (simulation_id,status,created_simulation_at),
    KEY idx_ewp_sim_code (simulation_id,kind,code), KEY idx_ewp_proposer (simulation_id,proposer_entity_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_system_members (
    system_id BINARY(16) NOT NULL, simulation_id BINARY(16) NOT NULL, entity_id BINARY(16) NOT NULL,
    role VARCHAR(48) NOT NULL DEFAULT 'MEMBER', support_score DECIMAL(8,5) NOT NULL DEFAULT 0,
    joined_simulation_at DATETIME(3) NOT NULL, PRIMARY KEY (system_id,entity_id), KEY idx_esm_entity (simulation_id,entity_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_businesses (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, entity_id BINARY(16) NOT NULL, owner_entity_id BINARY(16) NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE', production_capacity DECIMAL(10,4) NOT NULL DEFAULT 1,
    recent_revenue DECIMAL(16,4) NOT NULL DEFAULT 0, recent_input_cost DECIMAL(16,4) NOT NULL DEFAULT 0,
    recent_wage_cost DECIMAL(16,4) NOT NULL DEFAULT 0, recent_profit DECIMAL(16,4) NOT NULL DEFAULT 0,
    cumulative_profit DECIMAL(18,4) NOT NULL DEFAULT 0, cumulative_investment DECIMAL(18,4) NOT NULL DEFAULT 0,
    failure_count INT NOT NULL DEFAULT 0, last_evaluated_simulation_at DATETIME(3) NULL,
    created_simulation_at DATETIME(3) NOT NULL, updated_simulation_at DATETIME(3) NOT NULL, version INT NOT NULL DEFAULT 1,
    UNIQUE KEY uq_eb_entity (simulation_id,entity_id), KEY idx_eb_status (simulation_id,status)
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_production_history (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL, producer_entity_id BINARY(16) NOT NULL,
    structure_entity_id BINARY(16) NOT NULL, good_code VARCHAR(64) NOT NULL, quantity DECIMAL(16,4) NOT NULL,
    inputs JSON NULL, simulation_at DATETIME(3) NOT NULL, KEY idx_eph_sim_time (simulation_id,simulation_at),
    KEY idx_eph_good (simulation_id,good_code), KEY idx_eph_producer (simulation_id,producer_entity_id)
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_business_metrics (
    id BINARY(16) PRIMARY KEY, simulation_id BINARY(16) NOT NULL,
    business_count INT NOT NULL DEFAULT 0, active_business_count INT NOT NULL DEFAULT 0, failed_business_count INT NOT NULL DEFAULT 0,
    unemployed_count INT NOT NULL DEFAULT 0, employed_count INT NOT NULL DEFAULT 0,
    revenue DECIMAL(16,4) NOT NULL DEFAULT 0, input_cost DECIMAL(16,4) NOT NULL DEFAULT 0,
    wage_cost DECIMAL(16,4) NOT NULL DEFAULT 0, profit DECIMAL(16,4) NOT NULL DEFAULT 0,
    production_value DECIMAL(16,4) NOT NULL DEFAULT 0, investment DECIMAL(16,4) NOT NULL DEFAULT 0,
    simulation_at DATETIME(3) NOT NULL, KEY idx_ebm_sim_time (simulation_id,simulation_at)
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_governance_members (
    system_id BINARY(16) NOT NULL, simulation_id BINARY(16) NOT NULL, entity_id BINARY(16) NOT NULL, role VARCHAR(32) NOT NULL DEFAULT "MEMBER",
    support_score DECIMAL(8,5) NOT NULL DEFAULT 0, joined_simulation_at DATETIME(3) NOT NULL, PRIMARY KEY (system_id,entity_id)
  )`);
}

module.exports={ensureSocietyMigrations};