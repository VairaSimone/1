const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");

const DEVELOPMENT_ACTION_MINUTES = {
  SLEEPING: 480, RESTING: 60, EATING: 30, DRINKING: 10, TALKING: 20,
  PLAYING: 60, STUDYING: 90, READING: 45, WORKING: 240, EXPLORING: 60,
  WALKING: 30, WATCHING: 45
};

const DEVELOPMENT_PROFILE = {
  STUDYING: { cognitive: 1.25, education: 1.35 },
  READING: { cognitive: 1.1, education: 1.15 },
  WORKING: { cognitive: 0.9, education: 0.85 },
  EXPLORING: { cognitive: 0.75, social: 0.2, emotional: 0.15 },
  TALKING: { social: 1.0, emotional: 0.8 },
  PLAYING: { social: 0.65, emotional: 0.65 },
  WALKING: { physical: 0.25, emotional: 0.15 },
  WATCHING: { emotional: 0.15 },
  EATING: { physical: 0.1 },
  DRINKING: { physical: 0.05 },
  SLEEPING: { physical: 0.15, emotional: 0.2 },
  RESTING: { physical: 0.1, emotional: 0.15 }
};

function developmentDelta(actionType, baseHours) {
  const action = String(actionType || "").toUpperCase();
  const hours = Math.min(2, Math.max(0.25, Number(baseHours) || 0.5));
  const profile = DEVELOPMENT_PROFILE[action] || {};
  const perHour = {
    physical: 0.00025,
    cognitive: 0.00075,
    social: 0.00045,
    emotional: 0.0004,
    education: 0.00075
  };
  return {
    physical: Math.min(0.002, perHour.physical * hours * (profile.physical || 0)),
    cognitive: perHour.cognitive * hours * (profile.cognitive || 0),
    social: perHour.social * hours * (profile.social || 0),
    emotional: perHour.emotional * hours * (profile.emotional || 0),
    education: perHour.education * hours * (profile.education || 0)
  };
}

function actionDurationMinutes(actionType) {
  return DEVELOPMENT_ACTION_MINUTES[String(actionType || "").toUpperCase()] || 30;
}

async function updateDevelopment(simulationId, entityId, simulationTime, actionType = "") {
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
  const delta = developmentDelta(actionType, actionDurationMinutes(actionType) / 60);

  const physical = Math.min(1, Number(d.physical_score) + delta.physical);
  const cognitive = Math.min(1, Number(d.cognitive_score) + delta.cognitive);
  const social = Math.min(1, Number(d.social_score) + delta.social);
  const emotional = Math.min(1, Number(d.emotional_score) + delta.emotional);
  const education = Math.min(1, Number(d.education_score) + delta.education);

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

module.exports = { updateDevelopment, getDevelopment, getDevelopmentHistory, developmentDelta, actionDurationMinutes };
