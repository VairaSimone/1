const memoryService = require("./memory-service");

let installed = false;
const ACTIONS = new Set(["SLEEPING","RESTING","EATING","DRINKING","TALKING","PLAYING","STUDYING","READING","WORKING","EXPLORING","WALKING","WATCHING"]);

function normalizeActionFromContent(content) {
  const text = String(content || "").trim().toUpperCase();
  const match = text.match(/^COMPLETED\s+([A-Z_]+)/);
  if (!match) return null;
  const normalized = match[1].replaceAll("-", "_");
  return ACTIONS.has(normalized) ? normalized : null;
}

function install() {
  if (installed) return;
  const previousCreateMemory = memoryService.createMemory;
  memoryService.createMemory = async function normalizedCreateMemory(args) {
    const next = { ...(args || {}) };
    const metadata = next.metadata && typeof next.metadata === "object" ? { ...next.metadata } : {};
    const inferredAction = next.actionType || metadata.actionType || normalizeActionFromContent(next.content);
    const perception = metadata.perceptionSummary && typeof metadata.perceptionSummary === "object" ? metadata.perceptionSummary : null;
    if (inferredAction) metadata.actionType = inferredAction;
    if (!metadata.kind && inferredAction && String(next.type || "EPISODIC").toUpperCase() === "EPISODIC") metadata.kind = "action_outcome";
    if (!metadata.outcome && metadata.kind === "action_outcome") metadata.outcome = "SUCCESS";
    if (!metadata.locationId && perception?.locationId) metadata.locationId = perception.locationId;
    if (!metadata.location && perception) metadata.location = {
      id: perception.locationId || null,
      type: perception.locationType || null,
      label: perception.addressData?.name || perception.addressData?.label || perception.locationType || perception.locationId || "unknown location"
    };
    if (metadata.relationshipIntent && !metadata.targetEntityId && metadata.relationship?.targetEntityId) metadata.targetEntityId = metadata.relationship.targetEntityId;
    next.metadata = metadata;
    return previousCreateMemory(next);
  };
  installed = true;
}

module.exports = { install, normalizeActionFromContent };
