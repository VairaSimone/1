const test = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../src/lib/logger");

test("throttled logger suppresses repeated messages and reports suppression count", () => {
  logger.clearThrottleState();

  assert.equal(
    logger.debugThrottled("test:logger", 60000, { value: 1 }, "throttle test"),
    true
  );
  assert.equal(
    logger.debugThrottled("test:logger", 60000, { value: 2 }, "throttle test"),
    false
  );

  logger.clearThrottleState();
});
