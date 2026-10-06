const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BYTES_PER_MB,
  megabytesToBytes,
  isDatabaseSizeLimitReached
} = require("../src/services/database-size-guard");

test("database size guard converts MiB-style limits to bytes", () => {
  assert.equal(BYTES_PER_MB, 1024 * 1024);
  assert.equal(megabytesToBytes(250), 250 * 1024 * 1024);
  assert.equal(megabytesToBytes(250.5), 250.5 * 1024 * 1024);
  assert.equal(megabytesToBytes(0), 0);
});

test("database size guard is disabled when limit is zero or invalid", () => {
  assert.equal(isDatabaseSizeLimitReached(999999, 0), false);
  assert.equal(isDatabaseSizeLimitReached(999999, -1), false);
  assert.equal(isDatabaseSizeLimitReached(999999, Number.NaN), false);
});

test("database size guard trips at and above the configured limit", () => {
  const limit = megabytesToBytes(250);
  assert.equal(isDatabaseSizeLimitReached(limit - 1, limit), false);
  assert.equal(isDatabaseSizeLimitReached(limit, limit), true);
  assert.equal(isDatabaseSizeLimitReached(limit + 1, limit), true);
});

test("database storage guard includes allocated InnoDB tablespaces and retained binary logs", async () => {
  const { getDatabaseSizeBreakdown } = require("../src/services/database-size-guard");
  const fakeDb = {
    query: async (sql) => {
      if (sql.includes("innodb_tablespaces")) return [[{ bytes: "10485760" }]];
      if (sql.includes("SHOW VARIABLES LIKE 'log_bin'")) return [[{ Variable_name: "log_bin", Value: "ON" }]];
      if (sql.includes("SHOW BINARY LOGS")) return [[
        { Log_name: "binlog.000001", File_size: "1073741824" },
        { Log_name: "binlog.000002", File_size: "524288" }
      ]];
      throw new Error("unexpected query");
    }
  };

  const breakdown = await getDatabaseSizeBreakdown(fakeDb);
  assert.equal(breakdown.innodbAllocatedBytes, 10485760);
  assert.equal(breakdown.binaryLogBytes, 1074266112);
  assert.equal(breakdown.sizeBytes, 1084749824);
});

test("database storage guard ignores binary logs when binary logging is disabled", async () => {
  const { getDatabaseSizeBreakdown } = require("../src/services/database-size-guard");
  const fakeDb = {
    query: async (sql) => {
      if (sql.includes("innodb_tablespaces")) return [[{ bytes: "4194304" }]];
      if (sql.includes("SHOW VARIABLES LIKE 'log_bin'")) return [[{ Variable_name: "log_bin", Value: "OFF" }]];
      if (sql.includes("SHOW BINARY LOGS")) throw new Error("must not query binary logs when disabled");
      throw new Error("unexpected query");
    }
  };

  const breakdown = await getDatabaseSizeBreakdown(fakeDb);
  assert.equal(breakdown.innodbAllocatedBytes, 4194304);
  assert.equal(breakdown.binaryLogBytes, 0);
  assert.equal(breakdown.sizeBytes, 4194304);
});
