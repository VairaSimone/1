const { z } = require("zod");
require("dotenv").config();

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default("root"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("asami"),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GEMINI_ENABLED: z.coerce.boolean().default(true),
  GEMINI_INPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(0.75),
  GEMINI_OUTPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(3.75),
  GEMINI_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.35),
  GEMINI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(10),
  GEMINI_DAILY_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  GEMINI_MONTHLY_MAX_REQUESTS: z.coerce.number().int().positive().default(1800),
  GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES: z.coerce.number().nonnegative().default(360),
  GEMINI_DAILY_PACING_GRACE_MINUTES: z.coerce.number().int().nonnegative().default(10),
  GEMINI_PROACTIVE_EVERY_TICKS: z.coerce.number().int().positive().default(600),
  GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING: z.coerce.number().int().positive().default(300),
  GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING: z.coerce.number().int().positive().default(800),
  ENGINE_VERSION: z.string().default("1.0.0"),
  ENGINE_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  DEFAULT_SPEED: z.coerce.number().nonnegative().default(60),
  SNAPSHOT_EVERY_TICKS: z.coerce.number().int().positive().default(60),
  MAX_ENTITIES_PER_TICK: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().default("*")
});

const env = Env.parse(process.env);
module.exports = { env };
