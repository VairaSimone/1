const ACTION_SCALAR_KEYS = [
  "outcome",
  "success",
  "completed",
  "actionId",
  "decisionId",
  "entityId",
  "actionType",
  "locationId",
  "targetEntityId",
  "targetLocationId",
  "failureReason",
  "reason",
  "status"
];

const RESOURCE_KEYS = [
  "ok",
  "resource",
  "consumed",
  "remaining",
  "available",
  "required",
  "failureReason",
  "actionType"
];

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactString(value, maxLength = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function compactActionResult(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;

  const out = {};
  for (const key of ACTION_SCALAR_KEYS) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = typeof source[key] === "string" ? compactString(source[key]) : source[key];
    }
  }

  if (source.resource && typeof source.resource === "object" && !Array.isArray(source.resource)) {
    const resource = {};
    for (const key of RESOURCE_KEYS) {
      if (source.resource[key] !== undefined && source.resource[key] !== null) {
        resource[key] = typeof source.resource[key] === "string"
          ? compactString(source.resource[key], 120)
          : source.resource[key];
      }
    }
    if (Object.keys(resource).length) out.resource = resource;
  }

  if (Array.isArray(source.needChanges)) {
    out.needChanges = source.needChanges.slice(0, 16).map(change => ({
      code: change?.code ?? null,
      old: Number.isFinite(Number(change?.old)) ? Number(change.old) : null,
      new: Number.isFinite(Number(change?.new)) ? Number(change.new) : null,
      delta: Number.isFinite(Number(change?.delta)) ? Number(change.delta) : null
    }));
  }

  if (source.error && typeof source.error === "object") {
    out.error = {
      code: compactString(source.error.code, 120),
      name: compactString(source.error.name, 120),
      message: compactString(source.error.message, 240)
    };
  }

  return out;
}

function compactActionTarget(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;
  const out = {};
  for (const key of [
    "targetEntityId", "targetLocationId", "locationId", "entityId",
    "id", "name", "type", "resource"
  ]) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = typeof source[key] === "string" ? compactString(source[key], 160) : source[key];
    }
  }
  return out;
}

function compactActionParameters(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;
  const out = {};
  for (const key of [
    "actionType", "targetEntityId", "targetLocationId", "locationId",
    "resource", "requiredResource", "amount", "quantity", "durationMinutes",
    "entityId", "goalId", "planId", "planStepId", "failureReason", "reason"
  ]) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = typeof source[key] === "string" ? compactString(source[key], 160) : source[key];
    }
  }
  return out;
}

function compactPlanStepResult(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;
  const out = {};

  for (const key of [
    "actionType", "outcome", "attempts", "completions", "requiredCompletions",
    "progressModel", "completedAt", "lastCompletedAt", "lastAttemptAt",
    "blockedReason", "resource", "retryWhenResourceAvailable"
  ]) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }

  for (const key of ["avoidLocationIds", "avoidTargetEntityIds"]) {
    if (Array.isArray(source[key])) out[key] = source[key].slice(0, 8);
  }

  if (source.actionResult !== undefined) out.actionResult = compactActionResult(source.actionResult);
  if (source.lastActionResult !== undefined) out.lastActionResult = compactActionResult(source.lastActionResult);

  return out;
}

function compactDecisionActionSummary(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;

  return {
    schemaVersion: 2,
    actionId: source.actionId || null,
    decisionId: source.decisionId || null,
    actionType: source.actionType || null,
    sourceType: source.sourceType || null,
    status: source.status || null,
    startedSimulationAt: source.startedSimulationAt || null,
    completedSimulationAt: source.completedSimulationAt || null,
    target: compactActionTarget(source.target),
    parameters: compactActionParameters(source.parameters),
    result: compactActionResult(source.result)
  };
}

function compactDecisionActualOutcome(value) {
  const source = parseJson(value, null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return source ?? null;
  if (!source.actionSummary) return source;
  return {
    ...source,
    actionSummary: compactDecisionActionSummary(source.actionSummary)
  };
}

module.exports = {
  parseJson,
  compactActionResult,
  compactActionTarget,
  compactActionParameters,
  compactPlanStepResult,
  compactDecisionActionSummary,
  compactDecisionActualOutcome
};
