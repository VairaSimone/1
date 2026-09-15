const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const logger = require("../lib/logger");

async function claimOperation(simulationId, operationKey, operationType) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(`
      SELECT BIN_TO_UUID(id) AS id,status,result
      FROM simulation_operations
      WHERE simulation_id=UUID_TO_BIN(?) AND operation_key=?
      LIMIT 1
      FOR UPDATE
    `, [simulationId, operationKey]);

    if (existing.length) {
      const operation = existing[0];
      if (operation.status === "COMPLETED") {
        await conn.commit();
        return { kind: "COMPLETED", result: operation.result };
      }
      if (operation.status === "STARTED") {
        await conn.rollback();
        throw Object.assign(new Error("Operation already in progress"), { code: "OPERATION_IN_PROGRESS" });
      }

      await conn.query(`
        UPDATE simulation_operations
        SET operation_type=?,status='STARTED',result=NULL,completed_real_at=NULL
        WHERE id=UUID_TO_BIN(?)
      `, [operationType, operation.id]);
    } else {
      await conn.query(`
        INSERT INTO simulation_operations(id,simulation_id,operation_key,operation_type,status)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'STARTED')
      `, [uuid(), simulationId, operationKey, operationType]);
    }

    await conn.commit();
    return { kind: "CLAIMED" };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    if (err?.code === "ER_DUP_ENTRY") {
      throw Object.assign(new Error("Operation already in progress"), { code: "OPERATION_IN_PROGRESS" });
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function finishOperation(simulationId, operationKey, status, result) {
  await pool.query(`
    UPDATE simulation_operations
    SET status=?,result=?,completed_real_at=CURRENT_TIMESTAMP(3)
    WHERE simulation_id=UUID_TO_BIN(?) AND operation_key=? AND status='STARTED'
  `, [status, JSON.stringify(result), simulationId, operationKey]);
}

async function runIdempotent(simulationId, operationKey, operationType, fn) {
  const claim = await claimOperation(simulationId, operationKey, operationType);
  if (claim.kind === "COMPLETED") return claim.result;

  try {
    const result = await fn();
    try {
      await finishOperation(simulationId, operationKey, "COMPLETED", result);
    } catch (err) {
      logger.error({ simulationId, operationKey, operationType, err }, "Failed to persist completed idempotent operation");
      throw Object.assign(new Error("Operation completed but its idempotency record could not be finalized"), {
        code: "IDEMPOTENCY_FINALIZE_FAILED",
        statusCode: 500,
        cause: err
      });
    }
    return result;
  } catch (err) {
    try {
      await finishOperation(simulationId, operationKey, "FAILED", { error: String(err?.message || "Operation failed") });
    } catch (persistErr) {
      logger.error({ simulationId, operationKey, operationType, err: persistErr }, "Failed to persist failed idempotent operation");
    }
    throw err;
  }
}

module.exports = { runIdempotent };
