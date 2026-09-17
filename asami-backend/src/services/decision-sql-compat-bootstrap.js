const BROKEN_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,'CREATED',1)";
const FIXED_DECISION_INSERT_VALUES = "VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,'CREATED',1)";
const SELECTED_OPTION_SELECT_REGEX = /SELECT\s+selected_option_id\s+AS\s+selectedOptionId\s+FROM\s+decisions\s+WHERE\s+id=UUID_TO_BIN\(\?\)\s+LIMIT\s+1/gi;
const FIXED_SELECTED_OPTION_SELECT = "SELECT BIN_TO_UUID(selected_option_id) AS selectedOptionId FROM decisions WHERE id=UUID_TO_BIN(?) LIMIT 1";
const RELATIONSHIP_HISTORY_SIMULATION_ID_REGEX = /(INSERT\s+INTO\s+relationship_history\s*\(\s*id\s*,\s*simulation_id\s*,\s*relationship_id\s*[^)]*\)\s*VALUES\s*\(\s*UUID_TO_BIN\(\?\)\s*,)\s*\?\s*(,\s*UUID_TO_BIN\(\?\))/i;

let installed = false;

function fixDecisionInsertSql(sql) {
  if (typeof sql !== "string") return sql;
  let fixed = sql.replace(BROKEN_DECISION_INSERT_VALUES, FIXED_DECISION_INSERT_VALUES);
  fixed = fixed.replace(SELECTED_OPTION_SELECT_REGEX, FIXED_SELECTED_OPTION_SELECT);
  fixed = fixed.replace(RELATIONSHIP_HISTORY_SIMULATION_ID_REGEX, "$1UUID_TO_BIN(?)$2");
  return fixed;
}

function binaryUuidToString(value) {
  if (!Buffer.isBuffer(value) || value.length !== 16) return value;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeQueryValues(sql, values) {
  if (!Array.isArray(values) || !RELATIONSHIP_HISTORY_SIMULATION_ID_REGEX.test(String(sql || ""))) return values;
  if (!Buffer.isBuffer(values[1])) return values;
  const normalized = values.slice();
  normalized[1] = binaryUuidToString(normalized[1]);
  return normalized;
}

function install() {
  if (installed) return;
  const { pool } = require("../db/pool");
  const originalQuery = pool.query.bind(pool);
  pool.query = (sql, values) => {
    const normalizedValues = normalizeQueryValues(sql, values);
    const fixedSql = fixDecisionInsertSql(sql);
    return originalQuery(fixedSql, normalizedValues);
  };
  installed = true;
}

module.exports = {
  install,
  fixDecisionInsertSql,
  normalizeQueryValues,
  binaryUuidToString,
  BROKEN_DECISION_INSERT_VALUES,
  FIXED_DECISION_INSERT_VALUES,
  FIXED_SELECTED_OPTION_SELECT
};
