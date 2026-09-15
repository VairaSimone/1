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
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GEMINI_ENABLED: z.coerce.boolean().default(true),
  ENGINE_VERSION: z.string().default("1.0.0"),
  ENGINE_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  DEFAULT_SPEED: z.coerce.number().nonnegative().default(60),
  SNAPSHOT_EVERY_TICKS: z.coerce.number().int().positive().default(60),
  MAX_ENTITIES_PER_TICK: z.coerce.number().int().positive().default(100),
  CORS_ORIGIN: z.string().default("*")
});

const env = Env.parse(process.env);
module.exports = { env };
