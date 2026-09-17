const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fixDecisionInsertSql,
  normalizeQueryValues,
  binaryUuidToString,
  BROKEN_DECISION_INSERT_VALUES,
  FIXED_DECISION_INSERT_VALUES,
  FIXED_SELECTED_OPTION_SELECT
} = require("../src/services/decision-sql-compat-bootstrap");

test("decision insert SQL maps exactly 7 placeholders to the 7 bound values", () => {
  const sql = `INSERT INTO decisions(id,simulation_id,entity_id,simulation_time,trigger_event_id,trigger_type,context,status,version) ${BROKEN_DECISION_INSERT_VALUES}`;
  const fixed = fixDecisionInsertSql(sql);
  assert.equal((fixed.match(/\?/g) || []).length, 7);
  assert.ok(fixed.endsWith("?,?,'CREATED',1)"));
  assert.ok(fixed.includes(FIXED_DECISION_INSERT_VALUES));
});

test("selected option query is normalized even when SQL is formatted across lines", () => {
  const sql = `\n    SELECT selected_option_id AS selectedOptionId
    FROM decisions
    WHERE id=UUID_TO_BIN(?)
    LIMIT 1
  `;
  const fixed = fixDecisionInsertSql(sql);
  assert.equal(fixed.trim(), FIXED_SELECTED_OPTION_SELECT);
  assert.match(fixed.trim(), /^SELECT BIN_TO_UUID\(selected_option_id\)/);
});

test("binary UUID simulation_id is normalized for relationship history inserts", () => {
  const sql = `INSERT INTO relationship_history(id,simulation_id,relationship_id,simulation_time) VALUES(UUID_TO_BIN(?),?,UUID_TO_BIN(?),?)`;
  const simulationId = Buffer.from("61289d415e0b450d8989ff0512c394fe", "hex");
  const values = ["history-id", simulationId, "relationship-id", new Date("2026-09-29T20:00:00.000Z")];
  const normalized = normalizeQueryValues(sql, values);
  assert.notStrictEqual(normalized, values);
  assert.equal(normalized[1], "61289d41-5e0b-450d-8989-ff0512c394fe");
  assert.ok(Buffer.isBuffer(values[1]));
});

test("16-byte UUID buffers are converted to canonical UUID strings", () => {
  const uuidBuffer = Buffer.from("80625c7c722940ab8ab3da566c8c7b00", "hex");
  assert.equal(binaryUuidToString(uuidBuffer), "80625c7c-7229-40ab-8ab3-da566c8c7b00");
  assert.equal(binaryUuidToString(Buffer.from("abc", "utf8")), Buffer.from("abc", "utf8"));
});

test("unrelated SQL is not modified", () => {
  const sql = "SELECT * FROM decisions WHERE id=UUID_TO_BIN(?)";
  assert.equal(fixDecisionInsertSql(sql), sql);
  const values = ["x", Buffer.alloc(16)];
  assert.deepEqual(normalizeQueryValues(sql, values), values);
});
