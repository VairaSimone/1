const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BYTES_PER_MB,
  DUMP_ESTIMATE_SAFETY_FACTOR,
  MIN_DUMP_ESTIMATE_SAFETY_FACTOR,
  getDumpEstimateSafetyFactor,
  megabytesToBytes,
  isDatabaseSizeLimitReached,
  estimateDumpSizeBytes
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

test("dump estimate applies a safety factor to logical table data", () => {
  assert.equal(DUMP_ESTIMATE_SAFETY_FACTOR, 2.75);
  assert.equal(MIN_DUMP_ESTIMATE_SAFETY_FACTOR, 2.75);
  assert.equal(getDumpEstimateSafetyFactor(), 2.75);
  assert.equal(estimateDumpSizeBytes(100 * BYTES_PER_MB), 275 * BYTES_PER_MB);
  assert.equal(estimateDumpSizeBytes(0), 0);
});

test("database storage breakdown keeps physical storage diagnostic but uses estimated dump size for the guard", async () => {
  const { getDatabaseSizeBreakdown } = require("../src/services/database-size-guard");
  const fakeDb = {
    query: async (sql) => {
      if (sql.includes("innodb_tablespaces")) return [[{ bytes: "419430400" }]];
      if (sql.includes("SUM(data_length + index_length)")) return [[{ bytes: "262144000" }]];
      if (sql.includes("SUM(data_length)")) return [[{ bytes: "157286400" }]];
      if (sql.includes("SHOW VARIABLES LIKE 'log_bin'")) return [[{ Variable_name: "log_bin", Value: "OFF" }]];
      if (sql.includes("SHOW BINARY LOGS")) throw new Error("must not query binary logs when disabled");
      throw new Error("unexpected query: " + sql);
    }
  };

  const breakdown = await getDatabaseSizeBreakdown(fakeDb);
  assert.equal(breakdown.innodbAllocatedBytes, 419430400);
  assert.equal(breakdown.innodbDataAndIndexBytes, 262144000);
  assert.equal(breakdown.logicalDataBytes, 157286400);
  assert.equal(breakdown.binaryLogBytes, 0);
  assert.equal(breakdown.estimatedDumpBytes, 432537600);
  assert.equal(breakdown.sizeBytes, 432537600);
});

test("database storage guard scopes InnoDB allocation to the Asami schema", () => {
  const { getInnoDBAllocatedSizeBytes } = require("../src/services/database-size-guard");
  let receivedSql = "";
  const fakeDb = {
    query: async (sql) => {
      receivedSql = sql;
      return [[{ bytes: "10485760" }]];
    }
  };
  return getInnoDBAllocatedSizeBytes(fakeDb).then(bytes => {
    assert.equal(bytes, 10485760);
    assert.match(receivedSql, /name LIKE CONCAT\(\?, '\/%'\)/);
    assert.doesNotMatch(receivedSql, /innodb_system/);
    assert.doesNotMatch(receivedSql, /innodb_temporary/);
    assert.doesNotMatch(receivedSql, /innodb_undo_001/);
    assert.doesNotMatch(receivedSql, /innodb_undo_002/);
  });
});

test("database storage guard ignores binary logs when binary logging is disabled", async () => {
  const { getDatabaseSizeBreakdown } = require("../src/services/database-size-guard");
  const fakeDb = {
    query: async (sql) => {
      if (sql.includes("innodb_tablespaces")) return [[{ bytes: "4194304" }]];
      if (sql.includes("SUM(data_length + index_length)")) return [[{ bytes: "4194304" }]];
      if (sql.includes("SUM(data_length)")) return [[{ bytes: "2097152" }]];
      if (sql.includes("SHOW VARIABLES LIKE 'log_bin'")) return [[{ Variable_name: "log_bin", Value: "OFF" }]];
      if (sql.includes("SHOW BINARY LOGS")) throw new Error("must not query binary logs when disabled");
      throw new Error("unexpected query");
    }
  };

  const breakdown = await getDatabaseSizeBreakdown(fakeDb);
  assert.equal(breakdown.innodbAllocatedBytes, 4194304);
  assert.equal(breakdown.logicalDataBytes, 2097152);
  assert.equal(breakdown.binaryLogBytes, 0);
  assert.equal(breakdown.sizeBytes, 5767168);
});


test("dump estimate helper clamps unsafe explicit factors to the safety floor",()=>{
  assert.equal(estimateDumpSizeBytes(100*BYTES_PER_MB,1.0),275*BYTES_PER_MB);
  assert.equal(estimateDumpSizeBytes(100*BYTES_PER_MB,99),600*BYTES_PER_MB);
});
