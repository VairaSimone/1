const causal = require('./cognitive-causal-service');

let installed = false;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLink(link = {}) {
  return {
    ...link,
    weight: toNumber(link.weight),
    polarity: toNumber(link.polarity),
    confidence: toNumber(link.confidence),
    evidenceCount: toNumber(link.evidenceCount),
  };
}

function normalizeActivation(activation = {}) {
  return {
    ...activation,
    activation: toNumber(activation.activation),
    depth: Math.max(0, Math.round(toNumber(activation.depth))),
  };
}

function install() {
  if (installed || typeof causal.getCausalMind !== 'function') return;
  const original = causal.getCausalMind;
  causal.getCausalMind = async function normalizedCausalMind(...args) {
    const mind = await original.apply(this, args);
    return {
      ...mind,
      links: Array.isArray(mind?.links) ? mind.links.map(normalizeLink) : [],
      activations: Array.isArray(mind?.activations) ? mind.activations.map(normalizeActivation) : [],
    };
  };
  installed = true;
}

module.exports = { install, normalizeLink, normalizeActivation };
