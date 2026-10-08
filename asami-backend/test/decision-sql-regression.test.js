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

test("relationship history simulation_id is explicitly converted with UUID_TO_BIN", () => {
  const sql = `INSERT INTO relationship_history(id,simulation_id,relationship_id,simulation_time) VALUES(UUID_TO_BIN(?),?,UUID_TO_BIN(?),?)`;
  const fixed = fixDecisionInsertSql(sql);
  assert.equal(fixed, `INSERT INTO relationship_history(id,simulation_id,relationship_id,simulation_time) VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)`);
});

test("binary UUID simulation_id is normalized before relationship history insert SQL is fixed", () => {
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
  assert.deepEqual(binaryUuidToString(Buffer.from("abc", "utf8")), Buffer.from("abc", "utf8"));
});

test("autonomous decisions store a compact operational context and archive the full context",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/decision-service.js"),"utf8");
  assert.match(source,/function compactOperationalDecisionContext\(/);
  assert.match(source,/operationalDecisionContext/);
  assert.match(source,/fullDecisionContext/);
  assert.match(source,/INSERT INTO decision_context_archive/);
  assert.match(source,/operational:true/);
  assert.match(source,/schemaVersion:4/);
});

test("selected option snapshot no longer duplicates evaluation and expected outcome payloads",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/services/decision-service.js"),"utf8");
  const start=source.indexOf("const selectedOptionSnapshot = JSON.stringify(");
  const end=source.indexOf("\n\n  await withTransaction",start);
  const block=source.slice(start,end);
  assert.ok(block);
  assert.match(block,/targetEntityId/);
  assert.match(block,/targetLocationId/);
  assert.doesNotMatch(block,/actionDefinition,/);
  assert.doesNotMatch(block,/expectedOutcome,/);
  assert.doesNotMatch(block,/evaluation,/);
});

test("decision action audit is durable after action retention",()=>{
  const fs=require("node:fs");
  const path=require("node:path");
  const migration=fs.readFileSync(path.join(__dirname,"../src/db/schema-migrations.js"),"utf8");
  const decision=fs.readFileSync(path.join(__dirname,"../src/services/decision-service.js"),"utf8");
  const action=fs.readFileSync(path.join(__dirname,"../src/services/action-service.js"),"utf8");
  assert.match(migration,/ensureDecisionActionAuditMigration/);
  assert.match(migration,/\["action_created","TINYINT\(1\) NOT NULL DEFAULT 0 AFTER status"\]/);
  assert.match(migration,/\["action_id","BINARY\(16\) NULL AFTER action_created"\]/);
  assert.match(migration,/\["action_outcome","VARCHAR\(32\) NULL AFTER action_id"\]/);
  assert.match(migration,/ALTER TABLE decisions ADD COLUMN \$\{name\} \$\{definition\}/);
  assert.match(migration,/a\.decision_id=d\.id/);
  assert.match(migration,/JSON_EXTRACT\(actual_outcome,'\$\.actionId'\)/);
  assert.match(decision,/markDecisionActionCreated/);
  assert.match(decision,/action_created=1/);
  assert.match(decision,/action_outcome IS NULL/);
  assert.match(decision,/DECISION_ACTION_AUDIT_CONFLICT/);
  assert.match(action,/markDecisionActionCreated/);
  assert.match(action,/markDecisionActionOutcome/);
});

test("unrelated SQL is not modified", () => {
  const sql = "SELECT * FROM decisions WHERE id=UUID_TO_BIN(?)";
  assert.equal(fixDecisionInsertSql(sql), sql);
  const values = ["x", Buffer.alloc(16)];
  assert.deepEqual(normalizeQueryValues(sql, values), values);
});
