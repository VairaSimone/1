const { pool } = require("../db/pool");

const DEFAULT_STATE = {
  startedAt: null,
  lastActivityAt: null,
  lastUserMessageAt: null,
  lastAsamiMessageAt: null,
  currentTopic: null,
  emotionalTone: null,
  unresolvedTopics: [],
  openQuestions: [],
  commitments: [],
  sharedTopics: [],
  interactionCount: 0,
  userInitiatedCount: 0,
  asamiInitiatedCount: 0,
  lastIntent: "UNKNOWN",
  lastInitiator: null,
  innerState: {
    attention: 0.5,
    curiosity: 0.5,
    socialInterest: 0.5,
    emotionalEngagement: 0.5,
    conversationalEnergy: 0.7,
    desireToContinue: 0.5
  }
};

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueStrings(values, max = 8) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v || "").trim()).filter(Boolean))].slice(0, max);
}

function mergeState(base, patch = {}) {
  const current = { ...DEFAULT_STATE, ...(base || {}) };
  const next = { ...current, ...(patch || {}) };
  next.unresolvedTopics = uniqueStrings(patch.unresolvedTopics ?? current.unresolvedTopics, 8);
  next.openQuestions = uniqueStrings(patch.openQuestions ?? current.openQuestions, 8);
  next.commitments = uniqueStrings(patch.commitments ?? current.commitments, 8);
  next.sharedTopics = Array.isArray(patch.sharedTopics ?? current.sharedTopics)
    ? (patch.sharedTopics ?? current.sharedTopics).slice(0, 12)
    : [];
  next.innerState = { ...DEFAULT_STATE.innerState, ...(current.innerState || {}), ...(patch.innerState || {}) };
  return next;
}

async function getConversationState(simulationId, conversationId) {
  const [rows] = await pool.query(
    `SELECT metadata,version,created_simulation_at AS createdAt,status
     FROM conversations
     WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) LIMIT 1`,
    [simulationId, conversationId]
  );
  if (!rows.length) return null;
  const metadata = parseJson(rows[0].metadata, {});
  return {
    conversationId,
    status: rows[0].status,
    version: Number(rows[0].version || 1),
    createdAt: rows[0].createdAt,
    metadata,
    state: mergeState(metadata.conversationState)
  };
}

async function updateConversationState(simulationId, conversationId, patch = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getConversationState(simulationId, conversationId);
    if (!current) return null;
    const metadata = { ...(current.metadata || {}) };
    const nextState = mergeState(current.state, patch);
    metadata.conversationState = nextState;
    const [updated] = await pool.query(
      `UPDATE conversations
       SET metadata=?,version=version+1
       WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) AND version=? AND status='ACTIVE'`,
      [JSON.stringify(metadata), simulationId, conversationId, current.version]
    );
    if (updated.affectedRows) return nextState;
  }
  return null;
}

function topicFromText(content, fallback = null) {
  const text = normalizeText(content);
  const groups = [
    ["FEELINGS", /\b(sentire|sento|senti|emozion|triste|felice|arrabbiat|ansios|paura|fear|feel|feeling|happy|sad|angry)\b/],
    ["RELATIONSHIPS", /\b(amico|amica|amici|famiglia|relazione|fidanz|amicizia|friend|family|relationship|love|loving)\b/],
    ["PLANS", /\b(domani|dopodomani|stasera|prossim|settimana|mese|parto|viaggio|programma|piano|vorrei|voglio|impegno|prometto|tomorrow|next|plan|trip|promise)\b/],
    ["WORK_STUDY", /\b(lavoro|lavorare|ufficio|studio|studiare|esame|scuola|università|work|job|study|school|exam)\b/],
    ["HOBBIES", /\b(gioco|giocare|musica|film|serie|libro|leggere|sport|videogiochi|game|music|movie|book|sport|hobby)\b/],
    ["ANIMALS", /\b(cane|gatto|serpente|rettile|animale|animali|dog|cat|snake|reptile|animal)\b/],
    ["DAILY_LIFE", /\b(mangiare|cibo|acqua|dormire|casa|pranzo|cena|colazione|stanco|oggi|mattina|sera|food|water|sleep|home|lunch|dinner|breakfast|today)\b/]
  ];
  for (const [topic, pattern] of groups) if (pattern.test(text)) return topic;
  const stopWords = new Set(["ciao","salve","hey","buongiorno","buonasera","hello","come","cosa","stai","state","sono","sei","oggi","perché","perche","dove","quando","chi","che","con","questo","questa","that","what","how","are","you","today","hello"]);
  const tokens = [...new Set(text.split(/[^a-zàèéìòù0-9]+/i).filter(t => t.length >= 4 && !stopWords.has(t)))];
  return tokens.slice(0, 2).join(" ") || fallback || null;
}

function deriveConversationIntent(content, { proactive = false, currentTopic = null } = {}) {
  if (proactive) return { type: "PROACTIVE_CONTACT", reason: "autonomous_social_initiative" };
  const text = normalizeText(content);
  if (!text) return { type: "UNKNOWN", reason: "empty_message" };
  if (/^(ciao|hey|salve|buongiorno|buonasera|hello|hi)\b/.test(text)) {
    return { type: "GREETING", reason: "greeting_detected" };
  }
  if (/\b(non sono d'accordo|non credo|ti sbagli|no,|non è vero|i disagree|you are wrong)\b/i.test(text)) {
    return { type: "DISAGREEMENT", reason: "explicit_disagreement" };
  }
  if (/\b(ricord|ti ricordi|te lo avevo detto|remember|do you remember)\b/i.test(text)) {
    return { type: "RECALL_MEMORY", reason: "memory_reference" };
  }
  if (/\b(sono|mi sento|ho paura|mi preoccupa|sono triste|sono felice|I am|i feel|i'm|i am afraid|worried|sad|happy)\b/i.test(text)) {
    return { type: "EMOTIONAL_SHARING", reason: "personal_emotional_disclosure" };
  }
  if (/\b(domani|dopodomani|prossim|vorrei|voglio|penso di|prometto|farò|parto|tomorrow|next week|next month|i want|i will|i'm going to|plan|promise)\b/i.test(text)) {
    return { type: "PLANNING", reason: "future_intent_detected" };
  }
  if (/[?？]$|\b(come|cosa|perché|quando|dove|chi|quanto|how|what|why|when|where|who|how much)\b/i.test(text)) {
    return { type: "QUESTION", reason: "question_detected" };
  }
  if (/\b(aiut|consigli|cosa dovrei|che ne pensi|help|advice|what do you think)\b/i.test(text)) {
    return { type: "SEEK_ADVICE", reason: "advice_request" };
  }
  if (currentTopic) return { type: "CONTINUE_TOPIC", reason: `continuing_${String(currentTopic).toLowerCase()}` };
  return { type: "SHARE", reason: "general_statement" };
}

function deriveInnerState({ needs = [], emotions = [], relationships = [], currentAction = null, conversationState = {} } = {}) {
  const need = code => clamp((needs.find(n => String(n.code || "").toUpperCase() === code)?.value ?? 0));
  const emotion = code => clamp((emotions.find(e => String(e.code || "").toUpperCase() === code)?.intensity ?? 0));
  const relation = relationships[0] || {};
  const socialNeed = Math.max(need("SOCIAL_NEED"), need("BELONGING"));
  const curiosity = need("CURIOSITY");
  const energy = clamp((need("ENERGY") + (1 - need("SLEEPINESS"))) / 2, 0, 1, 0.7);
  const positive = Math.max(emotion("JOY"), emotion("CALM"), emotion("EXCITEMENT"));
  const negative = Math.max(emotion("ANXIETY"), emotion("FEAR"), emotion("FRUSTRATION"), emotion("SADNESS"), emotion("ANGER"));
  const closeness = clamp(Number(relation.closenessScore ?? relation.closeness ?? 0));
  const affection = clamp(Number(relation.affectionScore ?? relation.affection ?? 0));
  const conflict = clamp(Number(relation.conflictScore ?? relation.conflict ?? 0));
  const attention = clamp(.45 + curiosity * .35 + negative * .15 + (currentAction ? .05 : 0));
  const emotionalEngagement = clamp(.30 + positive * .35 + negative * .25 + closeness * .15 + affection * .10 - conflict * .15);
  const socialInterest = clamp(.25 + socialNeed * .6 + closeness * .15 + curiosity * .1 - conflict * .12);
  const desireToContinue = clamp(.15 + socialInterest * .35 + emotionalEngagement * .25 + curiosity * .18 + Math.min(1, Number(conversationState.interactionCount || 0) / 20) * .08);
  return {
    attention: Number(attention.toFixed(4)),
    curiosity: Number(curiosity.toFixed(4)),
    socialInterest: Number(socialInterest.toFixed(4)),
    emotionalEngagement: Number(emotionalEngagement.toFixed(4)),
    conversationalEnergy: Number(energy.toFixed(4)),
    desireToContinue: Number(desireToContinue.toFixed(4))
  };
}

function scoreMessageSignificance(content, { intent = null, topic = null, generated = null } = {}) {
  const text = normalizeText(content);
  let score = .12;
  const reasons = [];
  const markers = [
    [/\b(mi piace|non mi piace|preferisco|adoro|odio|amo|my favorite|i like|i dislike|i prefer|i love|i hate)\b/i, .28, "preference"],
    [/\b(io sono|sono |mi sento|ho paura|mi preoccupa|i am|i feel|i'm|i am afraid|i worry)\b/i, .22, "self_disclosure"],
    [/\b(ricord|ti ricordi|ricorda|remember|you remember)\b/i, .22, "memory_reference"],
    [/\b(domani|prossim|settimana|mese|vorrei|voglio|prometto|farò|parto|tomorrow|next|plan|promise|i will|i'm going to)\b/i, .32, "future_commitment"],
    [/\b(importante|mai|sempre|davvero|speciale|importa|important|never|always|really|special)\b/i, .12, "salience"]
  ];
  for (const [pattern, amount, reason] of markers) {
    if (pattern.test(text)) { score += amount; reasons.push(reason); }
  }
  if (text.length >= 140) { score += .06; reasons.push("detailed_message"); }
  if (intent?.type === "EMOTIONAL_SHARING" || intent?.type === "DISAGREEMENT") { score += .12; reasons.push("emotionally_relevant"); }
  if (topic && topic !== "DAILY_LIFE") score += .04;
  if (Array.isArray(generated?.rememberedReferences) && generated.rememberedReferences.length) {
    score += .35;
    reasons.push("model_marked_reference");
  }
  if (generated?.stateEffects?.goalProposal || generated?.stateEffects?.planProposal) {
    score += .25;
    reasons.push("goal_or_plan_candidate");
  }
  return { score: clamp(score), reasons: uniqueStrings(reasons, 8) };
}

function rememberableTopic(state, topic, simulationAt) {
  if (!topic) return state.sharedTopics || [];
  const existing = Array.isArray(state.sharedTopics) ? [...state.sharedTopics] : [];
  const index = existing.findIndex(item => String(item?.topic || "") === String(topic));
  if (index >= 0) {
    existing[index] = { ...existing[index], count: Number(existing[index].count || 0) + 1, lastAt: simulationAt };
  } else {
    existing.unshift({ topic, count: 1, firstAt: simulationAt, lastAt: simulationAt });
  }
  return existing.slice(0, 12);
}

module.exports = {
  getConversationState,
  updateConversationState,
  topicFromText,
  deriveConversationIntent,
  deriveInnerState,
  scoreMessageSignificance,
  rememberableTopic,
  mergeState
};
