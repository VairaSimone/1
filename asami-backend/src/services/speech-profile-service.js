const { pool } = require("../db/pool");
const { withEntityStateLock } = require("./state-service");

const DEFAULT_SPEECH_PROFILE = {
  version: 1,
  sampleCount: 0,
  metrics: {
    averageReplyWords: 22,
    averageSentenceWords: 11,
    fragmentation: 0.08,
    questionFrequency: 0.12,
    exclamationFrequency: 0.03,
    ellipsisFrequency: 0.02,
    emojiFrequency: 0.01,
    firstPersonFrequency: 0.05,
    hedgingFrequency: 0.05,
    selfCorrectionFrequency: 0.01,
    emotionalDisclosureFrequency: 0.08,
    lowercaseStartFrequency: 0,
    parentheticalFrequency: 0.01
  },
  voice: {
    rhythm: "medium",
    stance: "balanced",
    openness: "balanced",
    punctuation: "reserved",
    inquisitiveness: "moderate"
  },
  voiceExamples: [],
  lastSource: null,
  updatedSimulationAt: null
};

const METRIC_LIMITS = {
  averageReplyWords: [1, 120],
  averageSentenceWords: [1, 40],
  fragmentation: [0, 1],
  questionFrequency: [0, 1],
  exclamationFrequency: [0, 1],
  ellipsisFrequency: [0, 1],
  emojiFrequency: [0, 1],
  firstPersonFrequency: [0, 1],
  hedgingFrequency: [0, 1],
  selfCorrectionFrequency: [0, 1],
  emotionalDisclosureFrequency: [0, 1],
  lowercaseStartFrequency: [0, 1],
  parentheticalFrequency: [0, 1]
};

const FEATURE_KEYS = [
  "averageReplyWords",
  "averageSentenceWords",
  "fragmentation",
  "questionFrequency",
  "exclamationFrequency",
  "ellipsisFrequency",
  "emojiFrequency",
  "firstPersonFrequency",
  "hedgingFrequency",
  "selfCorrectionFrequency",
  "emotionalDisclosureFrequency",
  "lowercaseStartFrequency",
  "parentheticalFrequency"
];

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function safeText(value, max = 800) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return fallback;
}

function countMatches(text, regex) {
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
}

function extractWords(text) {
  return String(text || "").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function splitSentences(text) {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .replace(/\n+/g, ". ")
    .trim();
  if (!normalized) return [];
  return normalized.split(/[.!?…]+/u).map(item => item.trim()).filter(Boolean);
}

function analyzeSpeech(text) {
  const value = safeText(text, 4000);
  const words = extractWords(value);
  const sentences = splitSentences(value);
  const sentenceWordCounts = sentences.map(sentence => extractWords(sentence).length).filter(count => count > 0);
  const sentenceCount = Math.max(1, sentenceWordCounts.length);
  const averageSentenceWords = sentenceWordCounts.length
    ? sentenceWordCounts.reduce((sum, count) => sum + count, 0) / sentenceWordCounts.length
    : words.length;
  const shortSentences = sentenceWordCounts.filter(count => count <= 5).length;
  const lowercaseStarts = sentences.filter(sentence => /^[a-zàèéìòù]/u.test(sentence)).length;

  return {
    wordCount: words.length,
    sentenceCount: sentenceWordCounts.length,
    averageReplyWords: words.length,
    averageSentenceWords,
    fragmentation: shortSentences / sentenceCount,
    questionFrequency: countMatches(value, /\?/g) / sentenceCount,
    exclamationFrequency: countMatches(value, /!/g) / sentenceCount,
    ellipsisFrequency: countMatches(value, /(…|\.{2,})/gu) / sentenceCount,
    emojiFrequency: countMatches(value, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) / Math.max(1, words.length),
    firstPersonFrequency: countMatches(
      value,
      /\b(io|me|mi|mio|mia|miei|mie|sono|ho|credo|penso|I|me|my|mine|i'm|i've|i'll)\b/giu
    ) / Math.max(1, words.length),
    hedgingFrequency: countMatches(
      value,
      /\b(forse|magari|credo|penso|mi sembra|non lo so|non sono sicur[oa]|potrei|direi|suppongo|maybe|perhaps|i think|i guess|i'm not sure|not sure|might|could be)\b/giu
    ) / sentenceCount,
    selfCorrectionFrequency: countMatches(
      value,
      /\b(no,?\s*(?:aspetta|cioè|anzi)|aspetta,?\s*no|anzi|cioè|intendo|mi correggo|actually|wait|no wait|I mean|let me rephrase)\b/giu
    ) / sentenceCount,
    emotionalDisclosureFrequency: countMatches(
      value,
      /\b(mi sento|sento|ho paura|sono felice|sono triste|mi fa arrabbiare|mi irrita|mi preoccupa|mi piace|mi manca|I feel|I'm sad|I'm happy|I'm afraid|I'm worried|I miss|I love|I hate|it hurts)\b/giu
    ) / sentenceCount,
    lowercaseStartFrequency: lowercaseStarts / sentenceCount,
    parentheticalFrequency: countMatches(value, /\(/g) / sentenceCount
  };
}

function normalizeMetrics(input) {
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(
    FEATURE_KEYS.map(key => {
      const [min, max] = METRIC_LIMITS[key];
      return [key, clamp(source[key], min, max, DEFAULT_SPEECH_PROFILE.metrics[key])];
    })
  );
}

function deriveVoice(metrics) {
  const rhythm = metrics.averageReplyWords < 12
    ? "short"
    : metrics.averageReplyWords < 28
      ? "medium"
      : "long";
  const stance = metrics.hedgingFrequency >= 0.16
    ? "tentative"
    : metrics.hedgingFrequency <= 0.04
      ? "direct"
      : "balanced";
  const openness = metrics.emotionalDisclosureFrequency >= 0.18
    ? "open"
    : metrics.emotionalDisclosureFrequency <= 0.05
      ? "guarded"
      : "balanced";
  const punctuation = (
    metrics.questionFrequency +
    metrics.exclamationFrequency +
    metrics.ellipsisFrequency
  ) >= 0.24 ? "expressive" : "reserved";
  const inquisitiveness = metrics.questionFrequency >= 0.28
    ? "high"
    : metrics.questionFrequency >= 0.12
      ? "moderate"
      : "low";
  return { rhythm, stance, openness, punctuation, inquisitiveness };
}

function normalizeExample(example) {
  const source = example && typeof example === "object" ? example : {};
  const text = safeText(source.text, 800);
  if (!text) return null;
  const features = source.features && typeof source.features === "object"
    ? Object.fromEntries(FEATURE_KEYS.map(key => [
        key,
        clamp(source.features[key], ...METRIC_LIMITS[key], DEFAULT_SPEECH_PROFILE.metrics[key])
      ]))
    : normalizeMetrics(analyzeSpeech(text));
  return {
    text,
    simulationAt: source.simulationAt || null,
    source: source.source || "GEMINI",
    features
  };
}

function normalizeSpeechProfile(input) {
  const source = parseJson(input, {});
  const metrics = normalizeMetrics(source.metrics);
  const examples = Array.isArray(source.voiceExamples)
    ? source.voiceExamples.map(normalizeExample).filter(Boolean).slice(0, 4)
    : [];
  return {
    version: 1,
    sampleCount: Math.max(0, Number(source.sampleCount) || 0),
    metrics,
    voice: deriveVoice(metrics),
    voiceExamples: examples,
    lastSource: source.lastSource || null,
    updatedSimulationAt: source.updatedSimulationAt || null
  };
}

function getSpeechProfile(attributes) {
  return normalizeSpeechProfile(parseJson(attributes, {}).speechProfile);
}

function pickRepresentativeExamples(existingExamples, currentExample) {
  const current = normalizeExample(currentExample);
  const existing = Array.isArray(existingExamples)
    ? existingExamples.map(normalizeExample).filter(Boolean)
    : [];
  if (!current) return existing.slice(0, 4);

  const candidates = [
    { ...current, _recency: 1 },
    ...existing.map((example, index) => ({
      ...example,
      _recency: Math.max(0.1, 0.8 - index * 0.15)
    }))
  ];

  const selected = [candidates[0]];
  while (selected.length < 4 && selected.length < candidates.length) {
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const diversity = selected.reduce((sum, chosen) => sum + featureDistance(candidate.features, chosen.features), 0) / selected.length;
      const score = diversity * 0.8 + candidate._recency * 0.2;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    selected.push(best);
  }

  return selected.map(({ _recency, ...example }) => example);
}

function featureDistance(a, b) {
  const left = a || {};
  const right = b || {};
  if (!Object.keys(left).length || !Object.keys(right).length) return 0;
  let total = 0;
  for (const key of FEATURE_KEYS) total += Math.abs(Number(left[key] || 0) - Number(right[key] || 0));
  return total / FEATURE_KEYS.length;
}

async function recordSpeechSample({
  simulationId,
  entityId,
  simulationTime,
  text,
  source = "GEMINI"
}) {
  const reply = safeText(text, 4000);
  if (!reply || !simulationId || !entityId) return null;
  const analysis = analyzeSpeech(reply);
  const observedMetrics = normalizeMetrics(analysis);
  const weight = String(source).toUpperCase() === "GEMINI" ? 1 : 0.2;

  return withEntityStateLock(entityId, async db => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [rows] = await db.query(
        "SELECT attributes,version FROM entities WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1",
        [simulationId, entityId]
      );
      if (!rows.length) return null;

      const attributes = parseJson(rows[0].attributes, {});
      const previous = normalizeSpeechProfile(attributes.speechProfile);
      const nextSampleCount = previous.sampleCount + weight;
      const alpha = weight * (
        nextSampleCount < 8
          ? 0.18
          : nextSampleCount < 30
            ? 0.10
            : 0.05
      );

      const metrics = Object.fromEntries(
        FEATURE_KEYS.map(key => {
          const previousValue = Number(previous.metrics[key] || 0);
          const observedValue = Number(observedMetrics[key] || 0);
          return [key, clamp(
            previousValue + (observedValue - previousValue) * alpha,
            ...METRIC_LIMITS[key],
            previousValue
          )];
        })
      );

      const sourceName = String(source || "GEMINI").toUpperCase();
      const voiceExamples = sourceName === "GEMINI"
        ? pickRepresentativeExamples(previous.voiceExamples, {
            text: reply,
            simulationAt: simulationTime,
            source: sourceName,
            features: observedMetrics
          })
        : previous.voiceExamples;

      const next = {
        version: 1,
        sampleCount: Number(nextSampleCount.toFixed(3)),
        metrics,
        voice: deriveVoice(metrics),
        voiceExamples,
        lastSource: sourceName,
        updatedSimulationAt: simulationTime
      };

      attributes.speechProfile = next;
      const [updated] = await db.query(
        "UPDATE entities SET attributes=?,version=version+1 WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) AND version=?",
        [JSON.stringify(attributes), simulationId, entityId, rows[0].version]
      );
      if (updated.affectedRows) return next;
    }
    return null;
  });
}

module.exports = {
  DEFAULT_SPEECH_PROFILE,
  analyzeSpeech,
  normalizeSpeechProfile,
  getSpeechProfile,
  recordSpeechSample
};
