const { z } = require("zod");
const { env } = require("../config/env");
const logger = require("../lib/logger");
const budget = require("../services/gemini-budget-service");

const DecisionSchema = z.object({
  selectedActionType: z.string().min(1).max(100),
  targetEntityId: z.string().uuid().nullable().optional(),
  targetLocationId: z.string().uuid().nullable().optional(),
  reason: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1)
});

const DialogueSchema = z.object({
  reply: z.string().min(1).max(4000),
  emotionalTone: z.string().min(1).max(100),
  rememberedReferences: z.array(z.string().max(500)).max(8).default([])
});

class GeminiService {
  constructor() {
    this.client = null;
    this.model = env.GEMINI_MODEL;
  }

  async init() {
    await budget.ensureGeminiUsageTable();
    if (!env.GEMINI_ENABLED || !env.GEMINI_API_KEY) {
      logger.info("Gemini disabled or API key missing; deterministic fallback enabled");
      return false;
    }
    const { GoogleGenAI } = await import("@google/genai");
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    logger.info({
      model: this.model,
      dailyBudgetUsd: env.GEMINI_DAILY_BUDGET_USD,
      monthlyBudgetUsd: env.GEMINI_MONTHLY_BUDGET_USD
    }, "Gemini cognitive budget enabled");
    return true;
  }

  async generateJson(prompt, schema, { kind = "autonomy", thinkingLevel = "low" } = {}) {
    if (!this.client) return null;

    const outputTokenCeiling = kind === "dialogue" ? 900 : 500;
    const reservation = await budget.reserve({ prompt, outputTokenCeiling, kind });
    if (!reservation.allowed) {
      logger.info({ kind, reason: reservation.reason }, "Gemini budget reached; deterministic fallback used");
      return null;
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("Gemini timeout"), { code: "AI_TIMEOUT" })), env.GEMINI_TIMEOUT_MS)
    );

    const responseSchema = schema === DialogueSchema
      ? {
          type: "object",
          properties: {
            reply: { type: "string" },
            emotionalTone: { type: "string" },
            rememberedReferences: { type: "array", items: { type: "string" } }
          },
          required: ["reply", "emotionalTone", "rememberedReferences"]
        }
      : schema === DecisionSchema
        ? {
            type: "object",
            properties: {
              selectedActionType: { type: "string" },
              targetEntityId: { type: "string", nullable: true },
              targetLocationId: { type: "string", nullable: true },
              reason: { type: "string" },
              confidence: { type: "number" }
            },
            required: ["selectedActionType", "reason", "confidence"]
          }
        : undefined;

    let responseReceived = false;
    try {
      const responsePromise = this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          thinkingConfig: { thinkingLevel }
        }
      });

      const response = await Promise.race([
        responsePromise.then(value => { responseReceived = true; return value; }),
        timeoutPromise
      ]);
      const raw = typeof response.text === "string" ? response.text : "";
      const parsed = JSON.parse(raw);
      await budget.finalize(reservation, response.usageMetadata);
      return schema.parse(parsed);
    } catch (err) {
      if (!responseReceived) await budget.release(reservation);
      logger.warn({ err, kind }, "Gemini request failed; deterministic fallback will be used");
      return null;
    } finally {
      clearTimeout(timeoutPromise);
    }
  }

  async chooseDecision(context) {
    return this.generateJson(
      [
        "You are the cognitive layer of an autonomous life simulation.",
        "Return JSON only. Never invent IDs. Select only one action type from allowedActionTypes.",
        "Only influence the decision; do not replace the simulation's deterministic rules.",
        JSON.stringify(context)
      ].join("\n"),
      DecisionSchema,
      { kind: "autonomy", thinkingLevel: "low" }
    );
  }

  async dialogue(context) {
    return this.generateJson(
      [
        "You are generating a dialogue response for the autonomous entity Asami.",
        "Speak in Asami's first person.",
        "Use only provided state, memories, personality traits, goals, relationship and conversation history.",
        "Do not invent actions, facts or memories.",
        JSON.stringify(context)
      ].join("\n"),
      DialogueSchema,
      { kind: "dialogue", thinkingLevel: "medium" }
    );
  }
}

module.exports = { GeminiService };
