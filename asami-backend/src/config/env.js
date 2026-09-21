const { z } = require("zod");
require("dotenv").config();

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  TIME_ZONE: z.string().default("Europe/Rome"),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default("root"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("asami"),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(5),
  DB_STARTUP_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(60).default(12),
  DB_RETRY_BASE_MS: z.coerce.number().int().min(25).max(10000).default(250),
  DB_RETRY_MAX_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_TIMEOUT_MS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 30000;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(30000,n):value;
  },z.coerce.number().int().positive().default(30000)),
  GEMINI_ENABLED: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(true),
  GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING: z.coerce.number().int().min(128).max(20000).default(768),
  GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING: z.coerce.number().int().min(256).max(20000).default(1536),
  GEMINI_INPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(0.75),
  GEMINI_OUTPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(3.75),
  GEMINI_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.35),
  GEMINI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(10),
  GEMINI_DAILY_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  GEMINI_MONTHLY_MAX_REQUESTS: z.coerce.number().int().positive().default(2500),
  GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 60;
    const n=Number(value);
    return Number.isFinite(n)?Math.min(60,Math.max(1,n)):value;
  },z.coerce.number().nonnegative().default(60)),
  GEMINI_DAILY_PACING_GRACE_MINUTES: z.coerce.number().nonnegative().default(10),
  GEMINI_PROVIDER_RATE_LIMIT_COOLDOWN_MS: z.coerce.number().int().min(10000).default(60000),
  GEMINI_PROVIDER_QUOTA_COOLDOWN_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  GEMINI_PROVIDER_FAILURE_BASE_COOLDOWN_MS: z.coerce.number().int().min(1000).max(300000).default(10000),
  GEMINI_PROVIDER_FAILURE_MAX_COOLDOWN_MS: z.coerce.number().int().min(5000).max(900000).default(120000),
  GEMINI_PROVIDER_FAILURE_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  GEMINI_PROACTIVE_EVERY_TICKS: z.coerce.number().int().positive().default(90),
  WORLD_EVENT_RATE_PER_SIM_HOUR: z.coerce.number().nonnegative().default(0.25),
  ENGINE_VERSION: z.string().default("1.0.1"),
  ENGINE_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  TICK_MAX_RUNNING_AGE_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  DEFAULT_SPEED: z.coerce.number().nonnegative().default(60),
  SNAPSHOT_EVERY_TICKS: z.coerce.number().int().positive().default(60),
  MAX_ENTITIES_PER_TICK: z.coerce.number().int().positive().default(100),
  MAX_CONCURRENT_SIMULATIONS: z.coerce.number().int().positive().default(1),
  ACTOR_INACTIVITY_ALERT_HOURS: z.coerce.number().positive().default(12),
  ACTOR_INACTIVITY_ALERT_REPEAT_HOURS: z.coerce.number().positive().default(6),
  GOAL_STAGNATION_ALERT_HOURS: z.coerce.number().positive().default(24),
  GOAL_STAGNATION_ALERT_REPEAT_HOURS: z.coerce.number().positive().default(12),
  RETENTION_ENABLED: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(true),
  RETENTION_CHECK_INTERVAL_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  RETENTION_DECISION_CONTEXT_DAYS: z.coerce.number().int().min(1).default(2),
  RETENTION_DECISION_OPTIONS_DAYS: z.coerce.number().int().min(2).default(3),
  RETENTION_COGNITIVE_ARTIFACT_DAYS: z.coerce.number().int().min(7).default(14),
  RETENTION_NEED_HISTORY_DAYS: z.coerce.number().int().min(1).default(3),
  RETENTION_EMOTION_HISTORY_DAYS: z.coerce.number().int().min(1).default(3),
  RETENTION_ACTION_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_EVENT_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_IMPORTANT_EVENT_DAYS: z.coerce.number().int().min(7).default(30),
  RETENTION_MEMORY_ARCHIVE_DAYS: z.coerce.number().int().min(7).default(21),
  RETENTION_MEMORY_DELETE_DAYS: z.coerce.number().int().min(1).default(14),
  RETENTION_MEMORY_ARCHIVE_IMPORTANCE_MAX: z.coerce.number().min(0).max(1).default(0.82),
  RETENTION_EVENT_IMPORTANCE_KEEP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  RETENTION_MEMORY_PERMANENT_IMPORTANCE: z.coerce.number().min(0).max(1).default(0.82),
  RETENTION_MAX_EPISODIC_MEMORIES_PER_ACTOR: z.coerce.number().int().min(100).max(10000).default(1200),
  RETENTION_MAX_COGNITIVE_EXPECTATIONS_PER_ACTOR: z.coerce.number().int().min(100).max(10000).default(1200),
  RETENTION_MAX_COUNTERFACTUALS_PER_ACTOR: z.coerce.number().int().min(100).max(20000).default(2500),
  RETENTION_MAX_COUNTERFACTUAL_WORLDS_PER_ACTOR: z.coerce.number().int().min(100).max(20000).default(3000),
  RETENTION_RELATIONSHIP_HISTORY_DAYS: z.coerce.number().int().min(7).default(45),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(250).max(5000).default(5000),
  RETENTION_MAX_DELETES_PER_TABLE: z.coerce.number().int().min(500).max(20000).default(8000),
  RETENTION_TIME_BUDGET_MS: z.coerce.number().int().min(250).max(30000).default(5000),
  RETENTION_DRY_RUN: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(false),
  CORS_ORIGIN: z.string().default("*")
});
const env=Env.parse(process.env);
process.env.TZ = env.TIME_ZONE;
module.exports={env};
