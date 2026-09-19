const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

function loadBudgetServiceWithFakePool() {
  const servicePath = require.resolve("../src/services/gemini-budget-service");
  const poolPath = path.resolve(path.dirname(servicePath), "../db/pool");
  const envPath = path.resolve(path.dirname(servicePath), "../config/env");

  const state = {
    dayRequests: 0,
    monthRequests: 0,
    updates: []
  };

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, values) {
      if (sql.includes("SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE period_type='DAY'")) {
        return [[{
          reserved_usd: 0,
          estimated_usd: 0,
          requests: state.dayRequests
        }], []];
      }

      if (sql.includes("SELECT reserved_usd,estimated_usd,requests FROM gemini_usage WHERE period_type='MONTH'")) {
        return [[{
          reserved_usd: 0,
          estimated_usd: 0,
          requests: state.monthRequests
        }], []];
      }

      if (sql.startsWith("UPDATE gemini_usage SET reserved_usd=reserved_usd+?")) {
        state.updates.push({ sql, values });

        if (sql.includes("period_type='DAY'")) state.dayRequests += 1;
        if (sql.includes("period_type='MONTH'")) state.monthRequests += 1;

        return [{ affectedRows: 1 }, []];
      }

      return [{ affectedRows: 1 }, []];
    }
  };

  const fakePool = {
    async query() {
      return [[], []];
    },
    async getConnection() {
      return connection;
    }
  };

  const fakeEnv = {
    env: {
      GEMINI_INPUT_PRICE_USD_PER_1M: 0.75,
      GEMINI_OUTPUT_PRICE_USD_PER_1M: 3.75,
      GEMINI_DAILY_BUDGET_USD: 100,
      GEMINI_MONTHLY_BUDGET_USD: 1000,
      GEMINI_DAILY_MAX_REQUESTS: 100,
      GEMINI_MONTHLY_MAX_REQUESTS: 2500,
      GEMINI_DAILY_PACING_GRACE_MINUTES: 1440
    }
  };

  const originalLoad = Module._load;
  delete require.cache[servicePath];
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === servicePath && path.resolve(path.dirname(parent.filename), request) === poolPath) {
      return { pool: fakePool };
    }
    if (parent?.filename === servicePath && path.resolve(path.dirname(parent.filename), request) === envPath) {
      return fakeEnv;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = require(servicePath);
    return { service, state, restore() {
      Module._load = originalLoad;
      delete require.cache[servicePath];
    }};
  } catch (err) {
    Module._load = originalLoad;
    delete require.cache[servicePath];
    throw err;
  }
}

test("Gemini reserve increments the monthly request counter exactly like the daily counter", async () => {
  const loaded = loadBudgetServiceWithFakePool();
  try {
    const first = await loaded.service.reserve({
      prompt: "test request",
      outputTokenCeiling: 128,
      kind: "AUTONOMY"
    });

    assert.equal(first.allowed, true);
    assert.equal(loaded.state.dayRequests, 1);
    assert.equal(loaded.state.monthRequests, 1);

    const second = await loaded.service.reserve({
      prompt: "second test request",
      outputTokenCeiling: 128,
      kind: "AUTONOMY"
    });

    assert.equal(second.allowed, true);
    assert.equal(loaded.state.dayRequests, 2);
    assert.equal(loaded.state.monthRequests, 2);

    const reservationUpdates = loaded.state.updates.filter(({ sql }) =>
      sql.startsWith("UPDATE gemini_usage SET reserved_usd=reserved_usd+?")
    );
    assert.equal(reservationUpdates.length, 4);
    assert.equal(
      reservationUpdates.filter(({ sql }) => sql.includes("period_type='DAY'") && sql.includes("requests=requests+1")).length,
      2
    );
    assert.equal(
      reservationUpdates.filter(({ sql }) => sql.includes("period_type='MONTH'") && sql.includes("requests=requests+1")).length,
      2
    );
  } finally {
    loaded.restore();
  }
});
