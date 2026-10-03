const { pool } = require("./pool");

async function ensureRetentionArchiveMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_trade_daily_metrics (
    simulation_id BINARY(16) NOT NULL,
    simulation_date DATE NOT NULL,
    location_id BINARY(16) NOT NULL,
    good_code VARCHAR(64) NOT NULL,
    trade_count INT UNSIGNED NOT NULL DEFAULT 0,
    buyer_count INT UNSIGNED NOT NULL DEFAULT 0,
    seller_count INT UNSIGNED NOT NULL DEFAULT 0,
    total_quantity DECIMAL(20,4) NOT NULL DEFAULT 0,
    total_value DECIMAL(20,4) NOT NULL DEFAULT 0,
    average_unit_price DECIMAL(20,4) NOT NULL DEFAULT 0,
    min_unit_price DECIMAL(20,4) NOT NULL DEFAULT 0,
    max_unit_price DECIMAL(20,4) NOT NULL DEFAULT 0,
    first_simulation_at DATETIME(3) NOT NULL,
    last_simulation_at DATETIME(3) NOT NULL,
    PRIMARY KEY (simulation_id, simulation_date, location_id, good_code),
    KEY idx_etdm_sim_date (simulation_id, simulation_date),
    KEY idx_etdm_good (simulation_id, good_code, simulation_date)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS emergent_production_daily_metrics (
    simulation_id BINARY(16) NOT NULL,
    simulation_date DATE NOT NULL,
    producer_entity_id BINARY(16) NOT NULL,
    structure_entity_id BINARY(16) NOT NULL,
    good_code VARCHAR(64) NOT NULL,
    production_count INT UNSIGNED NOT NULL DEFAULT 0,
    total_quantity DECIMAL(20,4) NOT NULL DEFAULT 0,
    average_quantity DECIMAL(20,4) NOT NULL DEFAULT 0,
    first_simulation_at DATETIME(3) NOT NULL,
    last_simulation_at DATETIME(3) NOT NULL,
    PRIMARY KEY (
      simulation_id,
      simulation_date,
      producer_entity_id,
      structure_entity_id,
      good_code
    ),
    KEY idx_epdm_sim_date (simulation_id, simulation_date),
    KEY idx_epdm_good (simulation_id, good_code, simulation_date),
    KEY idx_epdm_producer (simulation_id, producer_entity_id, simulation_date)
  )`);
}

module.exports = { ensureRetentionArchiveMigrations };
