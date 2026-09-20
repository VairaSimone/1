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
  const changed = [];
  for (const migration of PLANNING_STATUS_MIGRATIONS) {
    if (await ensureStatusConstraint(migration)) changed.push(migration.table);
  }
  return { changed };
}

module.exports = { ensurePlanningStatusMigrations };

