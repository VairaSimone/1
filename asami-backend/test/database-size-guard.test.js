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
