const BROKEN_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,'CREATED',1)";
const FIXED_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'CREATED',1)";

let installed = false;

function fixDecisionInsertSql(sql) {
  if (typeof sql !== "string" || !sql.includes(BROKEN_DECISION_INSERT_VALUES)) return sql;
  return sql.replace(BROKEN_DECISION_INSERT_VALUES, FIXED_DECISION_INSERT_VALUES);
}

function install() {
  if (installed) return;
  const { pool } = require("../db/pool");
  const originalQuery = pool.query.bind(pool);
  pool.query = (sql, values) => originalQuery(fixDecisionInsertSql(sql), values);
  installed = true;
}

module.exports = { install, fixDecisionInsertSql, BROKEN_DECISION_INSERT_VALUES, FIXED_DECISION_INSERT_VALUES };
