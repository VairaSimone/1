const BROKEN_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,'CREATED',1)";
const FIXED_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'CREATED',1)";
const BROKEN_SELECTED_OPTION_SELECT = "SELECT selected_option_id AS selectedOptionId FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1";
const FIXED_SELECTED_OPTION_SELECT = "SELECT BIN_TO_UUID(selected_option_id) AS selectedOptionId FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1";

let installed = false;

function fixDecisionInsertSql(sql) {
  if (typeof sql !== "string") return sql;
  let fixed = sql.replace(BROKEN_DECISION_INSERT_VALUES, FIXED_DECISION_INSERT_VALUES);
  fixed = fixed.replace(BROKEN_SELECTED_OPTION_SELECT, FIXED_SELECTED_OPTION_SELECT);
  return fixed;
}

function install() {
  if (installed) return;
  const { pool } = require("../db/pool");
  const originalQuery = pool.query.bind(pool);
  pool.query = (sql, values) => originalQuery(fixDecisionInsertSql(sql), values);
  installed = true;
}

module.exports = {
  install,
  fixDecisionInsertSql,
  BROKEN_DECISION_INSERT_VALUES,
  FIXED_DECISION_INSERT_VALUES,
  BROKEN_SELECTED_OPTION_SELECT,
  FIXED_SELECTED_OPTION_SELECT
};
