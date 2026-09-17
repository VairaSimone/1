const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fixDecisionInsertSql,
  BROKEN_DECISION_INSERT_VALUES,
  FIXED_DECISION_INSERT_VALUES,
  BROKEN_SELECTED_OPTION_SELECT,
  FIXED_SELECTED_OPTION_SELECT
} = require("../src/services/decision-sql-compat-bootstrap");

test("decision insert SQL maps exactly 7 placeholders to the 7 bound values", () => {
  const sql = `INSERT INTO decisions(id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version) ${BROKEN_DECISION_INSERT_VALUES}`;
  const fixed = fixDecisionInsertSql(sql);
  assert.equal((fixed.match(/\?/g) || []).length, 7);
  assert.ok(fixed.endsWith("?,?,'CREATED',1)"));
  assert.ok(fixed.includes(FIXED_DECISION_INSERT_VALUES));
});

test("selected option is converted from BINARY(16) to UUID text before UUID_TO_BIN use", () => {
  const fixed = fixDecisionInsertSql(BROKEN_SELECTED_OPTION_SELECT);
  assert.equal(fixed, FIXED_SELECTED_OPTION_SELECT);
  assert.match(fixed, /^SELECT BIN_TO_UUID\(selected_option_id\)/);
});

test("unrelated SQL is not modified", () => {
  const sql = "SELECT * FROM decisions WHERE id=UUID_TO_BIN(?)";
  assert.equal(fixDecisionInsertSql(sql), sql);
});
