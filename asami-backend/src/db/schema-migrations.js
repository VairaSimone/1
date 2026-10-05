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
  locationHistoryIndex: "idx_location_history_entity_time",
  needHistoryTimeIndex: "idx_need_history_time_entity",
  emotionHistoryTimeIndex: "idx_emotion_history_time_entity"
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
    ["entity_need_history",MEMORY_RETENTION_MIGRATION.needHistoryTimeIndex,"simulation_time,entity_id,id"],
    ["entity_emotion_history",MEMORY_RETENTION_MIGRATION.emotionHistoryIndex,"entity_id,simulation_time"],
    ["entity_emotion_history",MEMORY_RETENTION_MIGRATION.emotionHistoryTimeIndex,"simulation_time,entity_id,id"],
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

const INTENTION_DECISION_MIGRATION = {
  column: "decision_id",
  index: "idx_intentions_simulation_decision"
};

async function ensureIntentionDecisionLinkMigration(db) {
  const [columns] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='intentions'
       AND COLUMN_NAME=?`,
    [INTENTION_DECISION_MIGRATION.column]
  );

  if (Number(columns[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE intentions
       ADD COLUMN decision_id BINARY(16) NULL
       AFTER plan_id`
    );
  }

  // Backfill the link from the canonical action linkage. Actions already
  // reference both the decision and the source intention, so this does not
  // require guessing based on timestamps or action type.
  await db.query(
    `UPDATE intentions i
     JOIN actions a
       ON a.source_intention_id=i.id
      AND a.simulation_id=i.simulation_id
     SET i.decision_id=a.decision_id
     WHERE i.decision_id IS NULL
       AND a.decision_id IS NOT NULL`
  );

  const [indexes] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='intentions'
       AND INDEX_NAME=?`,
    [INTENTION_DECISION_MIGRATION.index]
  );
  if (Number(indexes[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE intentions
       ADD KEY idx_intentions_simulation_decision (simulation_id,decision_id)`
    );
  }

  const [sameSimulationForeignKeys] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE()
       AND TABLE_NAME='intentions'
       AND CONSTRAINT_NAME='fk_intentions_decision_same_simulation'`
  );
  if (Number(sameSimulationForeignKeys[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE intentions
       ADD CONSTRAINT fk_intentions_decision_same_simulation
       FOREIGN KEY (simulation_id,decision_id)
       REFERENCES decisions(simulation_id,id)
       ON DELETE CASCADE
       ON UPDATE RESTRICT`
    );
  }

  return true;
}

async function ensureDecisionOptionIntegrityMigration(db) {
  const [columns] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='decisions'
       AND COLUMN_NAME='selected_option_snapshot'`
  );
  if (Number(columns[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE decisions
       ADD COLUMN selected_option_snapshot JSON NULL
       AFTER selected_option_id`
    );
  }

  // Preserve the full selected option before enforcing the FK. This also makes
  // old databases auditable even if an option was already lost.
  await db.query(
    `UPDATE decisions d
     JOIN decision_options o ON o.id=d.selected_option_id
     SET d.selected_option_snapshot=JSON_OBJECT(
       'optionId',BIN_TO_UUID(o.id),
       'decisionId',BIN_TO_UUID(o.decision_id),
       'optionCode',o.option_code,
       'description',o.description,
       'actionDefinition',o.action_definition,
       'evaluation',o.evaluation,
       'expectedOutcome',o.expected_outcome,
       'source','MIGRATION_BACKFILL'
     )
     WHERE d.selected_option_id IS NOT NULL
       AND d.selected_option_snapshot IS NULL`
  );

  // Existing orphan references cannot satisfy the new FK. Do not silently
  // discard the audit trail: preserve what can still be reconstructed from
  // the decision context, then clear only the invalid pointer.
  await db.query(
    `UPDATE decisions d
     LEFT JOIN decision_options o ON o.id=d.selected_option_id
     SET
       d.selected_option_snapshot=COALESCE(
         d.selected_option_snapshot,
         JSON_OBJECT(
           'optionId',BIN_TO_UUID(d.selected_option_id),
           'decisionId',BIN_TO_UUID(d.id),
           'optionCode',JSON_UNQUOTE(JSON_EXTRACT(d.context,'$.chosenAction')),
           'actionDefinition',JSON_OBJECT(
             'actionType',JSON_UNQUOTE(JSON_EXTRACT(d.context,'$.chosenAction'))
           ),
           'source','MIGRATION_ORPHAN_REPAIR'
         )
       ),
       d.selected_option_id=NULL
     WHERE d.selected_option_id IS NOT NULL
       AND o.id IS NULL`
  );

  const [constraints] = await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE()
       AND TABLE_NAME='decisions'
       AND CONSTRAINT_NAME='fk_decisions_selected_option'`
  );
  if (Number(constraints[0]?.count || 0) === 0) {
    await db.query(
      `ALTER TABLE decisions
       ADD CONSTRAINT fk_decisions_selected_option
       FOREIGN KEY (selected_option_id)
       REFERENCES decision_options(id)
       ON DELETE RESTRICT
       ON UPDATE RESTRICT`
    );
  }
  return true;
}

async function ensureDecisionActionAuditMigration(db=pool){
  const columns=[
    ["action_created","TINYINT(1) NOT NULL DEFAULT 0 AFTER status"],
    ["action_id","BINARY(16) NULL AFTER action_created"],
    ["action_outcome","VARCHAR(32) NULL AFTER action_id"]
  ];
  for(const [name,definition] of columns){
    const [rows]=await db.query(
      `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='decisions' AND COLUMN_NAME=?`,
      [name]
    );
    if(Number(rows[0]?.count||0)===0){
      await db.query(`ALTER TABLE decisions ADD COLUMN ${name} ${definition}`);
    }
  }

  const [indexes]=await db.query(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='decisions'
       AND INDEX_NAME='idx_decisions_action_audit'`
  );
  if(Number(indexes[0]?.count||0)===0){
    await db.query(
      `ALTER TABLE decisions
       ADD KEY idx_decisions_action_audit (simulation_id,action_created,simulation_time)`
    );
  }

  // Backfill surviving action links first.
  await db.query(
    `UPDATE decisions d
     JOIN actions a
       ON a.decision_id=d.id
      AND a.simulation_id=d.simulation_id
     SET d.action_created=1,
         d.action_id=a.id
     WHERE d.action_created=0
       AND d.action_id IS NULL`
  );

  // Recover causal evidence from retained decision outcomes for actions that
  // have already been deleted by retention.
  await db.query(
    `UPDATE decisions
     SET action_created=1,
         action_id=UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.actionId')))
     WHERE action_created=0
       AND action_id IS NULL
       AND actual_outcome IS NOT NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.actionId')) IS NOT NULL`
  );

  await db.query(
    `UPDATE decisions
     SET action_outcome=UPPER(COALESCE(
       JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.outcome')),
       JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.actionSummary.outcome'))
     ))
     WHERE action_created=1
       AND action_outcome IS NULL
       AND actual_outcome IS NOT NULL
       AND COALESCE(
         JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.outcome')),
         JSON_UNQUOTE(JSON_EXTRACT(actual_outcome,'$.actionSummary.outcome'))
       ) IS NOT NULL`
  );

  return true;
}

async function ensureDecisionContextArchiveMigration(db=pool){
  await db.query(`
    CREATE TABLE IF NOT EXISTS decision_context_archive (
      decision_id BINARY(16) NOT NULL PRIMARY KEY,
      simulation_id BINARY(16) NOT NULL,
      entity_id BINARY(16) NOT NULL,
      simulation_time DATETIME(3) NOT NULL,
      context JSON NOT NULL,
      created_real_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_decision_context_archive_sim_time (simulation_id,simulation_time),
      KEY idx_decision_context_archive_entity_time (simulation_id,entity_id,simulation_time)
    ) ENGINE=InnoDB
  `);
  return true;
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
    await ensureDecisionOptionIntegrityMigration(conn);
    await ensureIntentionDecisionLinkMigration(conn);
    await ensureActionLifecycleMigration(conn);
    const decisionActionAudit=await ensureDecisionActionAuditMigration(conn);
    const decisionContextArchive=await ensureDecisionContextArchiveMigration(conn);
    const memoryRetention=await ensureMemoryRetentionMigration(conn);
    return { changed, actionIdempotency: true, actionLifecycle: true, decisionActionAudit, decisionContextArchive, memoryRetention };
  } finally {
    if (acquired) {
      try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    }
    conn.release();
  }
}

module.exports = { ensurePlanningStatusMigrations, ensureMemoryRetentionMigration, ensureDecisionContextArchiveMigration };

