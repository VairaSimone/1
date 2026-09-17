const BROKEN_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,'CREATED',1)";
const FIXED_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'CREATED',1)";
const SELECTED_OPTION_SELECT_REGEX = /SELECT\s+selected_option_id\s+AS\s+selectedOptionId\s+FROM\s+decisions\s+WHERE\s+id=UUID_TO_BIN\(\?\)\s+LIMIT\s+1/gi;
const FIXED_SELECTED_OPTION_SELECT = "SELECT BIN_TO_UUID(selected_option_id) AS selectedOptionId FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1";

let installed = false;

function fixDecisionInsertSql(sql) {
  if (typeof sql !== "string") return sql;
  let fixed = sql.replace(BROKEN_DECISION_INSERT_VALUES, FIXED_DECISION_INSERT_VALUES);
  fixed = fixed.replace(SELECTED_OPTION_SELECT_REGEX, FIXED_SELECTED_OPTION_SELECT);
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
  FIXED_SELECTED_OPTION_SELECT
};
