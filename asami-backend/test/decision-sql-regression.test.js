const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fixDecisionInsertSql,
  BROKEN_DECISION_INSERT_VALUES,
  FIXED_DECISION_INSERT_VALUES
} = require("../src/services/decision-sql-compat-bootstrap");

test("decision insert SQL removes the extra status placeholder", () => {
  const sql = `INSERT INTO decisions(id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version) ${BROKEN_DECISION_INSERT_VALUES}`;
  const fixed = fixDecisionInsertSql(sql);
  assert.ok(fixed.includes(FIXED_DECISION_INSERT_VALUES));
  assert.equal((fixed.match(/\?/g) || []).length, 7);
  assert.doesNotMatch(fixed, /,\?,'CREATED',1\)$/);
});

test("unrelated SQL is not modified", () => {
  const sql = "SELECT * FROM decisions WHERE id=UUID_TO_BIN(?)";
  assert.equal(fixDecisionInsertSql(sql), sql);
});
