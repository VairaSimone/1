const test = require("node:test");
const assert = require("node:assert/strict");

const retention = require("../src/services/safe-retention-service");

test("retention policy protects against aggressive windows", () => {
  const policy = retention.getRetentionPolicy();
  assert.ok(policy.decisionContextDays >= 1);
  assert.ok(policy.decisionOptionsDays >= 2);
  assert.ok(policy.cognitiveArtifactDays >= 14);
  assert.ok(policy.batchSize >= 50);
  assert.ok(policy.maxDeletesPerTable >= 100);
});

test("only terminal decisions are eligible for retention", () => {
  assert.equal(retention.isTerminalDecisionStatus("EXECUTED"), true);
  assert.equal(retention.isTerminalDecisionStatus("FAILED"), true);
  assert.equal(retention.isTerminalDecisionStatus("CANCELLED"), true);
  assert.equal(retention.isTerminalDecisionStatus("CREATED"), false);
  assert.equal(retention.isTerminalDecisionStatus("EVALUATED"), false);
  assert.equal(retention.isTerminalDecisionStatus(""), false);
});
