const { pool } = require("./pool");

const PLANNING_STATUS_MIGRATIONS = [
  {
    table: "goals",
    constraint: "chk_goals_status",
    statuses: ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "ABANDONED", "BLOCKED"]
  },
  {
    table: "plans",
    constraint: "chk_plans_status",
    statuses: ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "BLOCKED"]
  },
  {
    table: "plan_steps",
    constraint: "chk_plan_steps_status",
    statuses: ["PENDING", "ACTIVE", "COMPLETED", "SKIPPED", "FAILED", "CANCELLED", "BLOCKED"]
  }
];

function quoteSqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function ensureStatusConstraint({ table, constraint, statuses }, db = pool) {
  const [rows] = await db.query(
    `SELECT CHECK_CLAUSE AS checkClause
     FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE()
       AND CONSTRAINT_NAME=?
     LIMIT 1`,
    [constraint]
  );
  const current = String(rows[0]?.checkClause || "");
  if (current.includes("'BLOCKED'")) return false;

  const clause = `CHECK (status IN (${statuses.map(quoteSqlString).join(", ") }))`;
  await db.query(`ALTER TABLE \`${table}\` DROP CHECK \`${constraint}\``);
  await db.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${clause}`);
  return true;
}


const ACTION_EXECUTION_MIGRATION = {
  column: "idempotency_key",
  uniqueIndex: "uq_actions_idempotency_key"
};

const MEMORY_RETENTION_MIGRATION = {
  memoryDedupeColumn: "memory_dedupe_key",
  memoryDedupeIndex: "idx_memories_dedupe",
  memoryRetentionIndex: "idx_memories_retention",
  needHistoryIndex: "idx_need_history_entity_time",
  emotionHistoryIndex: "idx_emotion_history_entity_time",
  locationHistoryIndex: "idx_location_history_entity_time"
};

async function ensureIndex(table,indexName,definition,db) {
  const [rows]=await db.query(
    "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?",
    [table,indexName]
  );
  if(Number(rows[0]?.count||0)===0){
    await db.query("ALTER TABLE " + table + " ADD KEY " + indexName + " (" + definition + ")");
    return true;
  }
  return false;
}

async function ensureMemoryRetentionMigration(db) {
  const [columns]=await db.query(
    "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='memories' AND COLUMN_NAME=?",
    [MEMORY_RETENTION_MIGRATION.memoryDedupeColumn]
  );
  if(Number(columns[0]?.count||0)===0){
    await db.query("ALTER TABLE memories ADD COLUMN memory_dedupe_key VARCHAR(64) NULL AFTER metadata");
  }
  const changed=[];
  for(const [table,indexName,definition] of [
    ["memories",MEMORY_RETENTION_MIGRATION.memoryDedupeIndex,"simulation_id,entity_id,status,memory_dedupe_key,created_simulation_at"],
    ["memories",MEMORY_RETENTION_MIGRATION.memoryRetentionIndex,"simulation_id,status,created_simulation_at"],
    ["entity_need_history",MEMORY_RETENTION_MIGRATION.needHistoryIndex,"entity_id,simulation_time"],
    ["entity_emotion_history",MEMORY_RETENTION_MIGRATION.emotionHistoryIndex,"entity_id,simulation_time"],
    ["entity_location_history",MEMORY_RETENTION_MIGRATION.locationHistoryIndex,"entity_id,entered_simulation_at"],
    ["memories","idx_memories_actor_retention","simulation_id,entity_id,memory_type,status,created_simulation_at,importance"],
    ["cognitive_expectations","idx_cognitive_expectations_retention","simulation_id,entity_id,status,created_simulation_at"],
    ["counterfactuals","idx_counterfactuals_retention","simulation_id,entity_id,created_simulation_at"],
    ["counterfactual_worlds","idx_counterfactual_worlds_retention","simulation_id,entity_id,status,created_simulation_at"],
    ["relationship_history","idx_relationship_history_retention","simulation_id,relationship_id,simulation_time"]
  ]){
    if(await ensureIndex(table,indexName,definition,db))changed.push(indexName);
  }
  return {changed};
}

async function ensureActionLifecycleMigration(db) {
  const [columns] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='actions'
       AND COLUMN_NAME='post_processing_status'`
  );
  if (Number(columns[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE actions ADD COLUMN post_processing_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' AFTER result`
    );
  }
  const [indexes] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='actions'
       AND INDEX_NAME='idx_actions_post_processing'`
  );
  if (Number(indexes[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE actions ADD KEY idx_actions_post_processing (simulation_id, status, post_processing_status, completed_simulation_at)`
    );
  }
}

async function ensureActionIdempotencyMigration(db) {
  const [columns] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='actions' AND COLUMN_NAME=?`,
    [ACTION_EXECUTION_MIGRATION.column]
  );
  if (Number(columns[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE actions ADD COLUMN idempotency_key VARCHAR(191) NULL AFTER decision_id`
    );
  }

  const [indexes] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='actions'
       AND INDEX_NAME=?`,
    [ACTION_EXECUTION_MIGRATION.uniqueIndex]
  );
  if (Number(indexes[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE actions ADD UNIQUE KEY uq_actions_idempotency_key (idempotency_key)`
    );
  }
}

async function ensurePlanningStatusMigrations() {
  const conn = await pool.getConnection();
  const lockName = "asami:schema-planning-status";
  let acquired = false;
  try {
    const [lockRows] = await conn.query("SELECT GET_LOCK(?,30) AS acquired", [lockName]);
    acquired = Number(lockRows[0]?.acquired) === 1;
    if (!acquired) throw new Error("Could not acquire planning schema migration lock");
    const changed = [];
    for (const migration of PLANNING_STATUS_MIGRATIONS) {
      if (await ensureStatusConstraint(migration, conn)) changed.push(migration.table);
    }
    await ensureActionIdempotencyMigration(conn);
    await ensureActionLifecycleMigration(conn);
    const memoryRetention=await ensureMemoryRetentionMigration(conn);
    return { changed, actionIdempotency: true, actionLifecycle: true, memoryRetention };
  } finally {
    if (acquired) {
      try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    }
    conn.release();
  }
}

module.exports = { ensurePlanningStatusMigrations, ensureMemoryRetentionMigration };

