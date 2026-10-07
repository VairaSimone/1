const { z } = require("zod");
require("dotenv").config({ quiet: true });

function blankAsDefault(value, fallback) {
  return value === undefined || value === null || String(value).trim() === "" ? fallback : value;
}

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
  DB_MAX_SIZE_MB: z.coerce.number().nonnegative().default(250),
  DB_DUMP_ESTIMATE_FACTOR: z.preprocess((value)=>blankAsDefault(value,2.75),z.coerce.number().min(1).max(6).default(2.75)),
  DB_RETENTION_PRESSURE_RATIO: z.coerce.number().min(0.50).max(0.95).default(0.80),
  MAX_COUNTERFACTUAL_ALTERNATIVES: z.coerce.number().int().min(1).max(4).default(2),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_FALLBACK_MODELS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return ["gemini-3.7-flash","gemini-3.6-flash","gemini-3.1-flash-lite"];
    return String(value).split(",").map(item=>item.trim()).filter(Boolean);
  },z.array(z.string().min(1).max(100)).max(5).default(["gemini-3.7-flash","gemini-3.6-flash","gemini-3.1-flash-lite"])),
  GEMINI_DIALOGUE_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_DIALOGUE_FALLBACK_MODELS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return ["gemini-3.5-flash-lite","gemini-3.7-flash"];
    return String(value).split(",").map(item=>item.trim()).filter(Boolean);
  },z.array(z.string().min(1).max(100)).max(5).default(["gemini-3.5-flash-lite","gemini-3.7-flash"])),
  GEMINI_DIALOGUE_MAX_LATENCY_MS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 12000;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(5000,Math.min(30000,n)):value;
  },z.coerce.number().int().min(5000).max(30000).default(12000)),
  GEMINI_DIALOGUE_TIMEOUT_MS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 15000;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(10000,Math.min(30000,n)):value;
  },z.coerce.number().int().min(10000).max(30000).default(15000)),
  GEMINI_DIALOGUE_MAX_MODELS: z.coerce.number().int().min(1).max(3).default(2),
  GEMINI_DIALOGUE_COMPACT_OUTPUT_TOKEN_CEILING: z.coerce.number().int().min(1024).max(4096).default(1536),
  GEMINI_AUTONOMY_MAX_LATENCY_MS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 12000;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(5000,Math.min(30000,n)):value;
  },z.coerce.number().int().min(5000).max(30000).default(12000)),
  GEMINI_TIMEOUT_MS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 30000;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(30000,n):value;
  },z.coerce.number().int().positive().default(30000)),
  GEMINI_ENABLED: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(true),
  GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 2048;
    const n=Number(value);
    return Number.isFinite(n)?Math.max(2048,n):value;
  },z.coerce.number().int().min(2048).max(20000).default(2048)),
  GEMINI_AUTONOMY_COMPACT_OUTPUT_TOKEN_CEILING: z.coerce.number().int().min(2048).max(4096).default(2048),
  // The autonomy fallback fan-out is intentionally capped at 2 in GeminiService.
  // Clamp legacy values (for example 3/4 from older .env files) instead of
  // crashing the whole backend during startup after a configuration update.
  GEMINI_AUTONOMY_MAX_MODELS: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return value;
    const n=Number(value);
    return Number.isFinite(n)?Math.min(2,n):value;
  },z.coerce.number().int().min(1).max(2).default(2)),
  GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING: z.coerce.number().int().min(256).max(20000).default(1536),
  GEMINI_INPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(0.75),
  GEMINI_OUTPUT_PRICE_USD_PER_1M: z.coerce.number().nonnegative().default(3.75),
  GEMINI_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.35),
  GEMINI_AUTONOMY_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.15),
  GEMINI_DIALOGUE_DAILY_BUDGET_USD: z.coerce.number().positive().default(0.20),
  GEMINI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(10),
  GEMINI_AUTONOMY_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(4),
  GEMINI_DIALOGUE_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(6),
  GEMINI_DAILY_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  GEMINI_AUTONOMY_DAILY_MAX_REQUESTS: z.coerce.number().int().positive().default(50),
  GEMINI_DIALOGUE_DAILY_MAX_REQUESTS: z.coerce.number().int().positive().default(50),
  GEMINI_MONTHLY_MAX_REQUESTS: z.coerce.number().int().positive().default(2500),
  GEMINI_AUTONOMY_MONTHLY_MAX_REQUESTS: z.coerce.number().int().positive().default(1250),
  GEMINI_DIALOGUE_MONTHLY_MAX_REQUESTS: z.coerce.number().int().positive().default(1500),
  GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 1440;
    const n=Number(value);
    return Number.isFinite(n)?Math.min(1440,Math.max(60,n)):value;
  },z.coerce.number().nonnegative().default(1440)),
  GEMINI_AUTONOMY_HIGH_VALUE_MIN_INTERVAL_MINUTES: z.preprocess((value)=>{
    if(value===undefined||value===null||String(value).trim()==="")return 120;
    const n=Number(value);
    return Number.isFinite(n)?Math.min(720,Math.max(30,n)):value;
  },z.coerce.number().nonnegative().default(120)),
  GEMINI_DAILY_PACING_GRACE_MINUTES: z.coerce.number().nonnegative().default(10),
  GEMINI_AUTONOMY_DAILY_PACING_ENABLED: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(false),
  GEMINI_PROVIDER_RATE_LIMIT_COOLDOWN_MS: z.coerce.number().int().min(10000).default(60000),
  GEMINI_PROVIDER_QUOTA_COOLDOWN_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  GEMINI_PROVIDER_FAILURE_BASE_COOLDOWN_MS: z.coerce.number().int().min(1000).max(300000).default(10000),
  GEMINI_PROVIDER_FAILURE_MAX_COOLDOWN_MS: z.coerce.number().int().min(5000).max(900000).default(120000),
  GEMINI_PROVIDER_FAILURE_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  GEMINI_PROACTIVE_EVERY_TICKS: z.coerce.number().int().positive().default(90),
  WORLD_EVENT_RATE_PER_SIM_HOUR: z.coerce.number().nonnegative().default(0.25),
  ENGINE_VERSION: z.string().default("1.0.1"),
  ENGINE_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  TICK_MAX_RUNNING_AGE_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  DEFAULT_SPEED: z.coerce.number().nonnegative().default(60),
  SNAPSHOT_EVERY_TICKS: z.coerce.number().int().positive().default(60),
  MAX_ENTITIES_PER_TICK: z.coerce.number().int().positive().default(100),
  MAX_CONCURRENT_SIMULATIONS: z.coerce.number().int().positive().default(1),
  ACTOR_INACTIVITY_ALERT_HOURS: z.coerce.number().positive().default(12),
  ACTOR_INACTIVITY_ALERT_REPEAT_HOURS: z.coerce.number().positive().default(6),
  DECISION_RECONCILIATION_GRACE_MINUTES: z.coerce.number().positive().default(5),
  DECISION_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  DECISION_RECONCILIATION_MAX_EVALUATED_MINUTES: z.coerce.number().int().min(15).max(10080).default(720),
  GOAL_STAGNATION_ALERT_HOURS: z.coerce.number().positive().default(24),
  GOAL_STAGNATION_ALERT_REPEAT_HOURS: z.coerce.number().positive().default(12),
  RETENTION_ENABLED: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(true),
  RETENTION_CHECK_INTERVAL_MS: z.coerce.number().int().min(60000).default(15*60*1000),
  RETENTION_DECISION_CONTEXT_DAYS: z.coerce.number().int().min(1).default(2),
  RETENTION_DECISION_CONTEXT_ARCHIVE_DAYS: z.coerce.number().int().min(2).default(2),
  RETENTION_DECISION_OPTIONS_DAYS: z.coerce.number().int().min(2).default(3),
  RETENTION_COGNITIVE_ARTIFACT_DAYS: z.coerce.number().int().min(7).default(14),
  RETENTION_NEED_HISTORY_DAYS: z.coerce.number().int().min(1).default(3),
  RETENTION_EMOTION_HISTORY_DAYS: z.coerce.number().int().min(1).default(3),
  RETENTION_ACTION_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_SIMULATION_TICK_DAYS: z.coerce.number().int().min(1).default(2),
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
  RETENTION_TIME_BUDGET_MS: z.preprocess((value)=>blankAsDefault(value,7500),z.coerce.number().int().min(250).max(30000).default(7500)),
  RETENTION_INTENTION_DAYS: z.coerce.number().int().min(1).default(7),
  RETENTION_DECISION_DAYS: z.coerce.number().int().min(7).default(30),
  RETENTION_DECISION_OPTION_DAYS: z.coerce.number().int().min(3).default(7),
  RETENTION_TRAIT_HISTORY_DAYS: z.coerce.number().int().min(7).default(30),
  RETENTION_GEMINI_DECISION_TELEMETRY_DAYS: z.coerce.number().int().min(7).default(30),
  TRAIT_HISTORY_MIN_DELTA: z.preprocess((value)=>blankAsDefault(value,0.001),z.coerce.number().nonnegative().default(0.001)),
  NEED_HISTORY_SIGNIFICANT_MIN_DELTA: z.preprocess((value)=>blankAsDefault(value,0.03),z.coerce.number().nonnegative().default(0.03)),
  EMOTION_HISTORY_SIGNIFICANT_MIN_DELTA: z.preprocess((value)=>blankAsDefault(value,0.03),z.coerce.number().nonnegative().default(0.03)),
  NEED_HISTORY_MIN_DELTA: z.preprocess((value)=>blankAsDefault(value,0.01),z.coerce.number().nonnegative().default(0.01)),
  EMOTION_HISTORY_MIN_DELTA: z.preprocess((value)=>blankAsDefault(value,0.01),z.coerce.number().nonnegative().default(0.01)),
  NEED_HISTORY_MIN_SIMULATION_INTERVAL_MINUTES: z.preprocess((value)=>blankAsDefault(value,15),z.coerce.number().nonnegative().default(15)),
  EMOTION_HISTORY_MIN_SIMULATION_INTERVAL_MINUTES: z.preprocess((value)=>blankAsDefault(value,15),z.coerce.number().nonnegative().default(15)),
  RETENTION_DRY_RUN: z.preprocess((value)=>{if(typeof value!=="string")return value;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;return value;},z.boolean()).default(false),
  CORS_ORIGIN: z.string().default("*")
});
const env=Env.parse(process.env);
process.env.TZ = env.TIME_ZONE;
module.exports={env};
