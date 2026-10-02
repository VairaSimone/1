const { pool } = require("../db/pool");
const { evolveOpenEnded, getOpenEndedSnapshot } = require("./open-emergence-service");

function parseJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function progressEmergence(simulationId, simulationTime, { gemini = null } = {}) {
  return evolveOpenEnded(simulationId, simulationTime, { gemini });
}

async function getEmergentSnapshot(simulationId) {
  const result = await Promise.all([
    pool.query(
      "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(scope_location_id) scopeLocationId," +
      "project_type projectType,issue_code issueCode,title,description,status,support_score supportScore,required_support requiredSupport," +
      "proposal,created_simulation_at createdAt,completed_simulation_at completedAt " +
      "FROM emergent_projects WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 80",
      [simulationId]
    ),
    pool.query(
      "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(project_id) projectId,BIN_TO_UUID(entity_id) entityId,structure_type structureType,name," +
      "BIN_TO_UUID(scope_location_id) scopeLocationId,activities,attributes,created_simulation_at createdAt " +
      "FROM emergent_structures WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 80",
      [simulationId]
    ),
    pool.query(
      "SELECT BIN_TO_UUID(id) id,system_type systemType,name,BIN_TO_UUID(scope_location_id) scopeLocationId,stage,attributes," +
      "created_simulation_at createdAt,updated_simulation_at updatedAt " +
      "FROM emergent_systems WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 40",
      [simulationId]
    ),
    pool.query(
      "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(proposer_entity_id) proposerEntityId,BIN_TO_UUID(governance_system_id) governanceSystemId," +
      "BIN_TO_UUID(scope_location_id) scopeLocationId,issue_code issueCode,title,statement,parameters,support_score supportScore," +
      "opposition_score oppositionScore,status,created_simulation_at createdAt " +
      "FROM emergent_policies WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 80",
      [simulationId]
    ),
    pool.query(
      "SELECT BIN_TO_UUID(id) id,BIN_TO_UUID(scope_location_id) scopeLocationId,conflict_type conflictType,left_type leftType," +
      "BIN_TO_UUID(left_id) leftId,right_type rightType,BIN_TO_UUID(right_id) rightId,intensity,status,metadata," +
      "created_simulation_at createdAt,resolved_simulation_at resolvedAt " +
      "FROM emergent_conflicts WHERE simulation_id=UUID_TO_BIN(?) ORDER BY created_simulation_at DESC LIMIT 80",
      [simulationId]
    ),
    getOpenEndedSnapshot(simulationId)
  ]);

  const decode = rows => rows.map(row => {
    for (const key of ["proposal", "activities", "attributes", "parameters", "metadata"]) {
      if (row[key] !== undefined) row[key] = parseJson(row[key], row[key]);
    }
    return row;
  });

  return {
    projects: decode(result[0][0]),
    structures: decode(result[1][0]),
    systems: decode(result[2][0]),
    policies: decode(result[3][0]),
    conflicts: decode(result[4][0]),
    openEnded: result[5]
  };
}

module.exports = { progressEmergence, getEmergentSnapshot };