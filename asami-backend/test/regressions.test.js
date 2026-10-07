const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");

const { toProviderJsonSchema } = require("../src/ai/gemini");
const { ProposalSchema } = require("../src/services/open-emergence-service");
const {
  simulationTimestampMs,
  getAdaptiveRetentionProfile
} = require("../src/services/safe-retention-service");

function collectKeys(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, result);
    return result;
  }
  for (const [key, value] of Object.entries(node)) {
    result.push(key);
    collectKeys(value, result);
  }
  return result;
}

test("Gemini provider schema strips unsupported exclusive bounds", () => {
  const schema = z.object({
    value: z.number().positive(),
    nested: z.array(z.object({
      amount: z.number().nonnegative()
    }))
  });

  const providerSchema = toProviderJsonSchema(schema);
  const keys = collectKeys(providerSchema);

  assert.equal(keys.includes("exclusiveMinimum"), false);
  assert.equal(keys.includes("exclusiveMaximum"), false);
});

test("open-ended proposal schema keeps basePrice within Gemini-compatible bounds", () => {
  const providerSchema = toProviderJsonSchema(ProposalSchema);
  const basePrice = providerSchema.properties?.products?.items?.properties?.basePrice;

  assert.ok(basePrice);
  assert.equal(basePrice.minimum, 0.01);
  assert.equal(Object.hasOwn(basePrice, "exclusiveMinimum"), false);
});

test("retention timestamp telemetry accepts MySQL Date values", () => {
  const iso = "2026-10-07T17:33:33.410Z";
  const expected = Date.parse(iso);

  assert.equal(
    simulationTimestampMs(new Date(expected)),
    expected
  );
  assert.equal(
    simulationTimestampMs("2026-10-07 17:33:33.410"),
    expected
  );
  assert.equal(simulationTimestampMs(expected), expected);
});

test("retention adaptive cleanup increases capacity only after overload is established", () => {
  const base = getAdaptiveRetentionProfile(0);
  const level1 = getAdaptiveRetentionProfile(3);
  const level2 = getAdaptiveRetentionProfile(6);
  const level3 = getAdaptiveRetentionProfile(9);

  assert.equal(base.level, 0);
  assert.ok(level1.timeBudgetMs > base.timeBudgetMs);
  assert.ok(level2.timeBudgetMs > level1.timeBudgetMs);
  assert.equal(level3.timeBudgetMs, 30000);
  assert.ok(level3.simulationIntervalHours < level2.simulationIntervalHours);
});
