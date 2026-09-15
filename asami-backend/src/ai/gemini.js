const { z } = require("zod");
const { env } = require("../config/env");
const logger = require("../lib/logger");

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
    if (!env.GEMINI_ENABLED || !env.GEMINI_API_KEY) {
      logger.info("Gemini disabled or API key missing; deterministic fallback enabled");
      return false;
    }
    const { GoogleGenAI } = await import("@google/genai");
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    return true;
  }

  async generateJson(prompt, schema) {
    if (!this.client) return null;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("Gemini timeout"), { code: "AI_TIMEOUT" })), env.GEMINI_TIMEOUT_MS)
    );
    try {
      const responsePromise = this.client.models.generateContent({
        model: this.model,
        contents: prompt,
config: {
  responseMimeType: "application/json",
  responseSchema: schema === DialogueSchema
    ? {
        type: "object",
        properties: {
          reply: { type: "string" },
          emotionalTone: { type: "string" },
          rememberedReferences: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["reply", "emotionalTone", "rememberedReferences"]
      }
    : undefined
}      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      const raw = typeof response.text === "string" ? response.text : "";
      const parsed = JSON.parse(raw);
      return schema.parse(parsed);
    } catch (err) {
      logger.warn({ err }, "Gemini request failed; deterministic fallback will be used");
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
        JSON.stringify(context)
      ].join("\n"),
      DecisionSchema
    );
  }

  async dialogue(context) {
    return this.generateJson(
      [
        "You are generating a dialogue response for an autonomous life simulation.",
        "Use only the provided facts, memories and personality traits.",
        "Do not claim actions that were not performed.",
        JSON.stringify(context)
      ].join("\n"),
      DialogueSchema
    );
  }
}

module.exports = { GeminiService };
