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
    return { changed };
  } finally {
    if (acquired) {
      try { await conn.query("SELECT RELEASE_LOCK(?)", [lockName]); } catch {}
    }
    conn.release();
  }
}

module.exports = { ensurePlanningStatusMigrations };

