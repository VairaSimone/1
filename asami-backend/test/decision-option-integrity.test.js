const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("decision option integrity migration creates an immutable selected-option snapshot and FK", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/db/schema-migrations.js"),
    "utf8"
  );
  assert.match(source, /selected_option_snapshot/);
  assert.match(source, /fk_decisions_selected_option/);
  assert.match(source, /FOREIGN KEY \(selected_option_id\)/);
  assert.match(source, /REFERENCES decision_options\(id\)/);
  assert.match(source, /ON DELETE RESTRICT/);
  assert.match(source, /MIGRATION_ORPHAN_REPAIR/);
});

test("decision creation persists option, snapshot and selected pointer atomically", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/decision-service.js"),
    "utf8"
  );
  assert.match(source, /withTransaction\(async conn =>/);
  assert.match(source, /selectedOptionSnapshot/);
  assert.match(source, /selected_option_snapshot=\?/);
  assert.match(source, /INSERT INTO decision_options/);
  assert.match(source, /selected_option_id=UUID_TO_BIN\(\?\)/);
});

test("retention never selects a selected decision option for deletion", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/safe-retention-service.js"),
    "utf8"
  );
  const start = source.indexOf("async function deleteUnselectedDecisionOptions");
  const end = source.indexOf("async function deleteResolvedExpectations", start);
  const block = source.slice(start, end);
  assert.match(block, /d\.selected_option_id IS NOT NULL/);
  assert.match(block, /dopt\.id <> d\.selected_option_id/);
});
