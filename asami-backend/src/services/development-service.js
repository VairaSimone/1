const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

async function updateDevelopment(simulationId, entityId, simulationTime) {
  const [rows] = await pool.query(`
    SELECT
      ed.entity_id,
      BIN_TO_UUID(ed.development_stage_id) AS developmentStageId,
      ed.physical_score,
      ed.cognitive_score,
      ed.social_score,
      ed.emotional_score,
      ed.education_score,
      ed.version,
      e.created_simulation_at,
      p.birth_simulation_at
    FROM entity_development ed
    JOIN entities e ON e.id = ed.entity_id
    LEFT JOIN persons p ON p.entity_id = ed.entity_id
    WHERE ed.entity_id = UUID_TO_BIN(?)
      AND e.simulation_id = UUID_TO_BIN(?)
    LIMIT 1
  `, [entityId, simulationId]);

  if (!rows.length) return null;

  const d = rows[0];
  const birthAt = d.birth_simulation_at || d.created_simulation_at;
  const ageDays = Math.max(0, (new Date(simulationTime) - new Date(birthAt)) / 86400000);

  const [stages] = await pool.query(`
    SELECT
      BIN_TO_UUID(id) AS id,
      code,
      name,
      min_age_days AS minAge,
      max_age_days AS maxAge,
      configuration
    FROM development_stages
    WHERE active = 1
      AND min_age_days <= ?
      AND (max_age_days IS NULL OR max_age_days > ?)
    ORDER BY min_age_days DESC
    LIMIT 1
  `, [ageDays, ageDays]);

  const newStage = stages[0] || null;
  const oldStageId = d.developmentStageId || null;
  const newStageId = newStage?.id || null;

  const physical = Math.min(1, Number(d.physical_score));
  const cognitive = Math.min(1, Number(d.cognitive_score) + 0.002);
  const social = Math.min(1, Number(d.social_score) + 0.001);
  const emotional = Math.min(1, Number(d.emotional_score) + 0.001);
  const education = Math.min(1, Number(d.education_score) + 0.002);

  const [updated] = await pool.query(`
    UPDATE entity_development
    SET
      physical_score = ?,
      cognitive_score = ?,
      social_score = ?,
      emotional_score = ?,
      education_score = ?,
      development_stage_id = UUID_TO_BIN(?),
      updated_simulation_at = ?,
      version = version + 1
    WHERE entity_id = UUID_TO_BIN(?)
      AND version = ?
  `, [
    physical, cognitive, social, emotional, education,
    newStageId, simulationTime, entityId, d.version
  ]);

  if (!updated.affectedRows) {
    throw Object.assign(new Error("Optimistic lock conflict on development"), { code: "OPTIMISTIC_LOCK" });
  }

  if (oldStageId !== newStageId) {
    await pool.query(`
      INSERT INTO development_history
        (id,entity_id,old_stage_id,new_stage_id,simulation_time,reason,source_event_id)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,NULL)
    `, [
      uuid(), entityId, oldStageId, newStageId, simulationTime,
      newStage ? `Development stage changed to ${newStage.name}` : "Development stage recalculated"
    ]);
  }

  return {
    entityId: d.entity_id,
    developmentStageId: newStageId,
    physicalScore: physical,
    cognitiveScore: cognitive,
    socialScore: social,
    emotionalScore: emotional,
    educationScore: education,
    ageDays,
    stage: newStage,
    updatedSimulationAt: simulationTime,
    version: Number(d.version) + 1
  };
}

async function getDevelopment(simulationId, entityId) {
  const [rows] = await pool.query(`
    SELECT
      BIN_TO_UUID(ed.entity_id) AS entityId,
      BIN_TO_UUID(ed.development_stage_id) AS developmentStageId,
      ed.physical_score AS physicalScore,
      ed.cognitive_score AS cognitiveScore,
      ed.social_score AS socialScore,
      ed.emotional_score AS emotionalScore,
      ed.education_score AS educationScore,
      ed.updated_simulation_at AS updatedSimulationAt,
      ed.version
    FROM entity_development ed
    JOIN entities e ON e.id = ed.entity_id
    WHERE e.simulation_id = UUID_TO_BIN(?)
      AND ed.entity_id = UUID_TO_BIN(?)
    LIMIT 1
  `, [simulationId, entityId]);
  return rows[0] || null;
}

async function getDevelopmentHistory(entityId, limit = 100) {
  const [rows] = await pool.query(`
    SELECT
      dh.simulation_time AS simulationAt,
      dh.simulation_time AS updatedSimulationAt,
      BIN_TO_UUID(dh.entity_id) AS entityId,
      BIN_TO_UUID(dh.old_stage_id) AS oldStageId,
      BIN_TO_UUID(dh.new_stage_id) AS newStageId,
      old_s.code AS oldStage,
      new_s.code AS newStage,
      dh.reason
    FROM development_history dh
    LEFT JOIN development_stages old_s ON old_s.id = dh.old_stage_id
    LEFT JOIN development_stages new_s ON new_s.id = dh.new_stage_id
    WHERE dh.entity_id = UUID_TO_BIN(?)
    ORDER BY dh.simulation_time DESC
    LIMIT ?
  `, [entityId, limit]);
  return rows;
}

module.exports = { updateDevelopment, getDevelopment, getDevelopmentHistory };