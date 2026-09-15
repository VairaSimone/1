const { pool } = require("../db/pool");
const { createEvent } = require("./event-service");
const { uuid } = require("../lib/ids");

async function updateDevelopment(simulationId, entityId, simulationTime) {
  const [rows] = await pool.query(`
    SELECT
      ed.entity_id,
      ed.development_stage_id,
      ed.physical_score,
      ed.cognitive_score,
      ed.social_score,
      ed.emotional_score,
      ed.education_score,
      ed.version,
      e.created_simulation_at,
      p.birth_simulation_at
    FROM entity_development ed
    JOIN entities e
      ON e.id = ed.entity_id
    LEFT JOIN persons p
      ON p.entity_id = ed.entity_id
    WHERE ed.entity_id = UUID_TO_BIN(?)
    LIMIT 1
  `, [entityId]);

  if (!rows.length) return null;

  const d = rows[0];

  const birthAt = d.birth_simulation_at || d.created_simulation_at;

  const ageDays = Math.max(
    0,
    (new Date(simulationTime) - new Date(birthAt)) / 86400000
  );

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

  const cognitive = Math.min(
    1,
    Number(d.cognitive_score) + 0.002
  );

  const social = Math.min(
    1,
    Number(d.social_score) + 0.001
  );

  const education = Math.min(
    1,
    Number(d.education_score) + 0.002
  );

  const emotional = Math.min(
    1,
    Number(d.emotional_score) + 0.001
  );

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
    Number(d.physical_score),
    cognitive,
    social,
    emotional,
    education,
    newStage?.id || null,
    simulationTime,
    entityId,
    d.version
  ]);

  if (!updated.affectedRows) {
    throw Object.assign(
      new Error("Optimistic lock conflict on development"),
      { code: "OPTIMISTIC_LOCK" }
    );
  }

  return {
    ageDays,
    stage: newStage,
    cognitive,
    social,
    education,
    emotional
  };
}

async function getDevelopment(simulationId,entityId){
  const [rows]=await pool.query(`
    SELECT ed.physical_score AS physical,ed.cognitive_score AS cognitive,ed.social_score AS social,
           ed.emotional_score AS emotional,ed.education_score AS education,
           ds.code AS stageCode,ds.name AS stageName,ed.updated_simulation_at AS updatedAt
    FROM entity_development ed
    LEFT JOIN development_stages ds ON ds.id=ed.development_stage_id
    JOIN entities e ON e.id=ed.entity_id
    WHERE e.simulation_id=UUID_TO_BIN(?) AND ed.entity_id=UUID_TO_BIN(?)
  `,[simulationId,entityId]);
  return rows[0]||null;
}

async function getDevelopmentHistory(entityId,limit=100){
  const [rows]=await pool.query(`
    SELECT BIN_TO_UUID(dh.id) AS id,dh.simulation_time AS simulationTime,dh.reason,
           old_s.code AS oldStage,new_s.code AS newStage
    FROM development_history dh
    LEFT JOIN development_stages old_s ON old_s.id=dh.old_stage_id
    LEFT JOIN development_stages new_s ON new_s.id=dh.new_stage_id
    WHERE dh.entity_id=UUID_TO_BIN(?) ORDER BY dh.simulation_time DESC LIMIT ?
  `,[entityId,limit]);
  return rows;
}
module.exports={updateDevelopment,getDevelopment,getDevelopmentHistory};
