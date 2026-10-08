const { z } = require("zod");

const MIN_PROVIDER_DEADLINE_MS = 10000;
const { env } = require("../config/env");
const logger = require("../lib/logger");
const budget = require("../services/gemini-budget-service");

const looseObject = z.object({}).catchall(z.unknown());
const optionalUuid = z.string().uuid().nullable().optional().catch(null);
const DecisionSchema = z.object({selectedActionType:z.string().min(1).max(100),targetEntityId:optionalUuid,targetLocationId:optionalUuid,reason:z.string().min(1).max(360),confidence:z.number().min(0).max(1)});
const AdvancedDecisionSchema = DecisionSchema.extend({
  strategy:z.object({
    objective:z.string().max(160).optional(),
    rationale:z.string().max(220).optional(),
    constraints:z.array(z.string().max(100)).max(3).default([]),
    fallbackActionType:z.string().max(60).nullable().optional()
  }).nullable().optional(),
  planProposal:z.object({
    title:z.string().min(1).max(160),
    strategy:looseObject.optional(),
    steps:z.array(z.object({
      title:z.string().min(1).max(160),
      description:z.string().max(180).optional(),
      actionType:z.string().max(60).optional()
    })).min(1).max(3)
  }).nullable().optional()
});
const DialogueStateEffectsSchema=z.object({
  needs:z.array(z.object({code:z.string(),delta:z.number()})).max(6).default([]),
  emotions:z.array(z.object({code:z.string(),delta:z.number()})).max(6).default([]),
  traits:z.array(z.object({code:z.string(),delta:z.number()})).max(4).default([]),
  relationship:z.object({
    trust:z.number().optional(),affection:z.number().optional(),respect:z.number().optional(),
    familiarity:z.number().optional(),attraction:z.number().optional(),conflict:z.number().optional(),
    fear:z.number().optional(),admiration:z.number().optional(),jealousy:z.number().optional(),
    dependence:z.number().optional(),closeness:z.number().optional(),irritation:z.number().optional()
  }).nullable().default(null),
  communicationStyle:z.object({
    formality:z.number().optional(),warmth:z.number().optional(),directness:z.number().optional(),
    verbosity:z.number().optional(),humor:z.number().optional(),emojiUse:z.number().optional(),
    emotionalOpenness:z.number().optional(),argumentativeDepth:z.number().optional()
  }).nullable().default(null),
  reflection:z.object({
    thought:z.string().nullable().optional(),
    currentFocus:z.string().nullable().optional(),
    currentConcern:z.string().nullable().optional(),
    mentalLoad:z.number().optional(),
    rumination:z.number().optional(),
    certainty:z.number().optional()
  }).nullable().default(null)
});

const AdvancedDialogueStateEffectsSchema=DialogueStateEffectsSchema.extend({
  goalProposal:z.object({
    title:z.string().min(1),description:z.string().optional(),priority:z.number().optional(),reason:z.string().optional()
  }).nullable().default(null),
  preferences:z.array(z.object({
    targetType:z.string(),targetEntityId:optionalUuid,value:z.number(),strength:z.number(),confidence:z.number(),topic:z.string().optional()
  })).max(6).default([]),
  beliefs:z.array(z.object({
    predicate:z.string().min(1),subjectEntityId:optionalUuid,objectValue:z.unknown(),confidence:z.number(),importance:z.number()
  })).max(5).default([]),
  knowledge:z.array(z.object({
    knowledgeType:z.string(),content:z.string().min(1),subjectEntityId:optionalUuid,objectEntityId:optionalUuid,
    predicate:z.string().nullable().optional(),confidence:z.number(),importance:z.number()
  })).max(5).default([]),
  habitCandidate:z.object({
    name:z.string().min(1),description:z.string().optional(),frequency:z.string().optional(),
    triggerDefinition:z.unknown().optional(),actionDefinition:z.unknown().optional(),confidence:z.number()
  }).nullable().default(null),
  planProposal:z.object({
    title:z.string(),strategy:looseObject.optional(),
    steps:z.array(z.object({title:z.string().min(1),description:z.string().optional(),actionType:z.string().optional()})).min(1).max(8)
  }).nullable().default(null)
});

const DialogueSchema=z.object({
  reply:z.string().min(1).max(4000),
  emotionalTone:z.string().min(1).max(100),
  rememberedReferences:z.array(z.string()).max(8).default([]),
  stateEffects:DialogueStateEffectsSchema.default({
    needs:[],emotions:[],traits:[],relationship:null,communicationStyle:null,reflection:null
  })
});

const AdvancedDialogueSchema=DialogueSchema.extend({
  stateEffects:AdvancedDialogueStateEffectsSchema.default({
    needs:[],emotions:[],traits:[],relationship:null,communicationStyle:null,reflection:null,
    goalProposal:null,preferences:[],beliefs:[],knowledge:[],habitCandidate:null,planProposal:null
  })
});

function decisionNeedsAdvancedCognition(context){
  const type=String(context?.geminiTrigger?.type||"");
  return ["PLAN_DELIBERATION","AMBIGUITY","FAILURE_REFLECTION","UNCERTAINTY","SOCIAL_CONFLICT","NEW_RELATIONSHIP"].includes(type);
}

function normalizeProviderSchemaNode(node, root, resolving = new Set()) {
  if (node === true || node === false || node === null || typeof node !== "object") return node;
  if (node.$ref) {
    const ref = String(node.$ref);
    const prefix = "#/$defs/";
    if (!ref.startsWith(prefix)) return node;
    const name = ref.slice(prefix.length);
    if (!root.$defs?.[name] || resolving.has(name)) return node;
    const next = new Set(resolving);
    next.add(name);
    return normalizeProviderSchemaNode(root.$defs[name], root, next);
  }
  const allowed = new Set([
    "type","nullable","properties","required","additionalProperties","items","anyOf","allOf","oneOf",
    "enum","const","description","format","pattern","minLength","maxLength","minimum","maximum",
    "multipleOf","minItems","maxItems","uniqueItems"
  ]);
  const providerSupportedStringFormats = new Set(["date-time","date","time"]);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (!allowed.has(key)) continue;
    // Gemini Structured Outputs supports only a subset of JSON Schema string
    // formats. Zod's z.string().uuid() becomes format:"uuid", which is valid
    // JSON Schema but is not a supported Gemini response-schema format.
    // Passing it through makes the autonomy decision request provider-specific
    // and can surface as a generic 503, while dialogue schemas do not contain
    // UUID-formatted response fields.
    if (key === "format" && !providerSupportedStringFormats.has(String(value))) continue;
    if (key === "properties") {
      out.properties = {};
      for (const [property, propertySchema] of Object.entries(value || {})) {
        out.properties[property] = normalizeProviderSchemaNode(propertySchema, root, resolving);
      }
      continue;
    }
    if (key === "items" || key === "additionalProperties") {
      out[key] = typeof value === "object" ? normalizeProviderSchemaNode(value, root, resolving) : value;
      continue;
    }
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out[key] = Array.isArray(value) ? value.map(item => normalizeProviderSchemaNode(item, root, resolving)) : value;
      continue;
    }
    out[key] = value;
  }
  if (Array.isArray(out.type) && out.type.includes("null")) {
    const nonNullTypes = out.type.filter(type => type !== "null");
    if (nonNullTypes.length === 1) {
      out.type = nonNullTypes[0];
      out.nullable = true;
    }
  }
  if (Array.isArray(out.anyOf) && out.anyOf.length === 2) {
    const nullIndex = out.anyOf.findIndex(item => item && item.type === "null");
    if (nullIndex >= 0) {
      const valueIndex = nullIndex === 0 ? 1 : 0;
      const candidate = out.anyOf[valueIndex];
      if (candidate && typeof candidate === "object" && !candidate.anyOf && !candidate.oneOf && !candidate.allOf) {
        const nullableCandidate = { ...candidate, nullable: true };
        delete out.anyOf;
        Object.assign(out, nullableCandidate);
      }
    }
  }
  return out;
}

function toProviderJsonSchema(schema) {
  if (!schema || typeof z.toJSONSchema !== "function") {
    throw Object.assign(new Error("Zod JSON Schema conversion is unavailable"), { code: "AI_SCHEMA_CONVERSION_UNAVAILABLE" });
  }
  const root = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    reused: "inline",
    cycles: "throw",
    unrepresentable: "throw"
  });
  return normalizeProviderSchemaNode(root, root);
}
function compactDecisionContext(context,{advanced=false}={}){
  const compactList=(items,mapper,limit)=>Array.isArray(items)?items.slice(0,limit).map(mapper):[];
  const candidates=compactList(context?.candidates,c=>({
    action:c.action,
    score:Number(c.score||0),
    targetLocationId:c.targetLocationId||null,
    targetEntityId:c.targetEntityId||null,
    resourceIntent:c.resourceIntent?{
      resource:c.resourceIntent.resource||null,
      reason:c.resourceIntent.reason||null,
      expectedTravelMinutes:Number(c.resourceIntent.expectedTravelMinutes||0)
    }:null,
    explorationIntent:c.explorationIntent?{
      reason:c.explorationIntent.reason||null,
      novelty:Number(c.explorationIntent.novelty||0),
      interest:Number(c.explorationIntent.interest||0)
    }:null,
    socialTarget:Boolean(c.socialTarget),
    planCommitted:Boolean(c.planCommitted),
    recoveryBlocked:Boolean(c.recoveryBlocked)
  }),10);
  const compact={
    simulationTime:context?.simulationTime||null,
    entity:{
      id:context?.entity?.id||null,
      displayName:context?.entity?.displayName||""
    },
    needs:compactList(context?.needs,n=>({code:n.code,value:Number(n.value||0),priorityWeight:Number(n.priorityWeight||1)}),12),
    traits:compactList(context?.traits,t=>({code:t.code,value:Number(t.value??0)}),12),
    currentAction:context?.currentAction?{
      actionType:context.currentAction.actionType||null,
      status:context.currentAction.status||null
    }:null,
    location:context?.location?{
      locationId:context.location.locationId||null,
      locationType:context.location.locationType||null,
      name:context.location.name||context.location.displayName||null
    }:null,
    goals:compactList(context?.goals,g=>({
      id:g.id||null,title:g.title||null,status:g.status||null,
      goalType:g.goalType||null,priority:Number(g.priority||0),progress:Number(g.progress||0),
      motivation:g.motivation||null
    }),8),
    candidates,
    allowedActionTypes:compactList(context?.allowedActionTypes,a=>String(a),16),
    recentActions:compactList(context?.recentActions,a=>({
      actionType:a.actionType||a,
      outcome:a.outcome||a.status||null,
      at:a.completedSimulationAt||a.startedSimulationAt||a.at||null
    }),12),
    recoveryBlocks:compactList(context?.recoveryBlocks,b=>({
      code:b.code||null,needValue:Number(b.needValue||0),
      blockedActions:Array.isArray(b.blockedActions)?b.blockedActions.slice(0,8):[]
    }),8),
    resourceContext:context?.resourceContext?{
      currentLocationId:context.resourceContext.currentLocationId||null,
      currentResources:context.resourceContext.currentResources||{},
      blockedResources:context.resourceContext.blockedResources||{},
      nearestResources:{
        water:context.resourceContext.nearestResources?.water||null,
        food:context.resourceContext.nearestResources?.food||null
      },
      emergencyResources:compactList(context.resourceContext.emergencyResources,e=>({
        resource:e.resource||null,locationId:e.locationId||null,reason:e.reason||null
      }),6)
    }:null,
    social:context?.social?{
      candidates:compactList(context.social.candidates,c=>({
        id:c.id||null,name:c.name||null,
        familiarity:Number(c.familiarity||0),closeness:Number(c.closeness||0),
        affection:Number(c.affection||0),trust:Number(c.trust||0),
        compatibility:Number(c.compatibility||0)
      }),8)
    }:null,
    proactivity:context?.proactivity||null,
    geminiTrigger:context?.geminiTrigger||null
  };
  if(advanced){
    compact.cognitiveProfile={
      mentalState:context?.cognitiveProfile?.mentalState||null,
      preferences:compactList(context?.cognitiveProfile?.preferences,p=>({
        targetType:p.targetType,targetEntityId:p.targetEntityId||null,
        value:Number(p.preferenceValue||0),strength:Number(p.strength||0),confidence:Number(p.confidence||0),topic:p.topic||null
      }),6),
      beliefs:compactList(context?.cognitiveProfile?.beliefs,b=>({
        predicate:b.predicate,subjectEntityId:b.subjectEntityId||null,objectValue:b.objectValue,
        confidence:Number(b.confidence||0),importance:Number(b.importance||0)
      }),6),
      knowledge:compactList(context?.cognitiveProfile?.knowledge,k=>({
        knowledgeType:k.knowledgeType,content:String(k.content||"").slice(0,350),
        subjectEntityId:k.subjectEntityId||null,objectEntityId:k.objectEntityId||null,
        predicate:k.predicate||null,confidence:Number(k.confidence||0),importance:Number(k.importance||0)
      }),6),
      habits:compactList(context?.cognitiveProfile?.habits,h=>({
        name:h.name,description:String(h.description||"").slice(0,180),strength:Number(h.strength||0),frequency:h.frequency||null
      }),4),
      plans:compactList(context?.cognitiveProfile?.plans,p=>({
        title:p.title,status:p.status,goalId:p.goalId||null,
        steps:compactList(p.steps,s=>({title:s.title,status:s.status,actionType:s.result?.actionType||null}),3)
      }),3)
    };
  }
  return compact;
}

function calculateDynamicStructuredOutputTokenCeiling({kind="autonomy",prompt,schema,thinkingLevel="low",configuredCeiling,minimumOutputTokenCeiling=512}={}){
  const configured=Math.max(1,Math.floor(Number(configuredCeiling)||1));
  const minimum=Math.max(1,Math.min(configured,Math.floor(Number(minimumOutputTokenCeiling)||1)));
  let schemaTokens=0;
  try{schemaTokens=budget.estimateInputTokens(JSON.stringify(toProviderJsonSchema(schema)));}catch{}
  const promptTokens=budget.estimateInputTokens(prompt);
  const reasoningReserve=thinkingLevel==="medium"?1024:thinkingLevel==="low"?640:384;
  const schemaReserve=Math.min(768,Math.max(128,Math.ceil(schemaTokens*.65)));
  const contextReserve=Math.min(768,Math.max(128,Math.ceil(promptTokens/8)));
  const naturalNeed=minimum+reasoningReserve+schemaReserve+contextReserve;
  const hardCap=kind==="autonomy"?4096:4096;
  return Math.min(hardCap,Math.max(configured,naturalNeed));
}

function dialogueNeedsAdvancedCognition(context){
  const type=String(context?.conversationIntent?.type||"");
  if(["PLANNING","EMOTIONAL_SHARING","DISAGREEMENT"].includes(type))return true;
  const text=String(context?.userMessage||"");
  return /\b(mi piace|non mi piace|preferisco|adoro|odio|amo|mi preoccupa|credo|penso che|so che|sai che|di solito|sempre|mai|vorrei|voglio|prometto|futuro|i like|i dislike|i prefer|i love|i hate|i think|i believe|i know|usually|always|never|plan|promise)\b/i.test(text);
}

function compactDialogueContext(context,{advanced=false}={}){
  const compactList=(items,mapper,limit)=>Array.isArray(items)?items.slice(0,limit).map(mapper):[];
  const recent=Array.isArray(context?.recentConversation)?context.recentConversation.slice(-10):[];
  const memories=Array.isArray(context?.memories)?context.memories.slice(0,6):[];
  const compact={
    simulationTime:context?.simulationTime||null,
    role:"Asami",
    entity:{
      displayName:context?.entity?.displayName||"Asami"
    },
    communicationStyle:context?.communicationStyle||null,
    speechProfile:context?.speechProfile?{
      sampleCount:Number(context.speechProfile.sampleCount||0),
      metrics:Number(context.speechProfile.sampleCount||0)>0?context.speechProfile.metrics||null:null,
      voice:Number(context.speechProfile.sampleCount||0)>0?context.speechProfile.voice||null:null,
      voiceExamples:Array.isArray(context.speechProfile.voiceExamples)
        ?context.speechProfile.voiceExamples.slice(0,4).map(example=>({
            text:String(example?.text||"").slice(0,800),
            simulationAt:example?.simulationAt||null
          }))
        :[]
    }:null,
    identity:context?.identity||null,
    mentalState:context?.mentalState||null,
    needs:compactList(context?.needs,n=>({code:n.code,value:Number(n.value||0)}),12),
    emotions:compactList(context?.emotions,e=>({code:e.code,name:e.name,intensity:Number(e.intensity||0)}),12),
    traits:compactList(context?.traits,t=>({code:t.code,name:t.name,value:Number(t.value??t.strength??0)}),12),
    currentAction:context?.currentAction?{
      actionType:context.currentAction.actionType||null,
      status:context.currentAction.status||null
    }:null,
    location:context?.location?{
      locationId:context.location.locationId||null,
      locationType:context.location.locationType||null,
      name:context.location.name||context.location.displayName||null
    }:null,
    relevantRelationship:context?.relevantRelationship?{
      closenessScore:Number(context.relevantRelationship.closenessScore??context.relevantRelationship.closeness??0),
      affectionScore:Number(context.relevantRelationship.affectionScore??context.relevantRelationship.affection??0),
      trustScore:Number(context.relevantRelationship.trustScore??context.relevantRelationship.trust??0),
      conflictScore:Number(context.relevantRelationship.conflictScore??context.relevantRelationship.conflict??0)
    }:null,
    goals:compactList(context?.goals,g=>({title:g.title,status:g.status,priority:g.priority}),8),
    conversationState:{
      currentTopic:context?.conversationState?.currentTopic||null,
      unresolvedTopics:Array.isArray(context?.conversationState?.unresolvedTopics)?context.conversationState.unresolvedTopics.slice(0,6):[],
      openQuestions:Array.isArray(context?.conversationState?.openQuestions)?context.conversationState.openQuestions.slice(0,6):[],
      commitments:Array.isArray(context?.conversationState?.commitments)?context.conversationState.commitments.slice(0,6):[],
      interactionCount:Number(context?.conversationState?.interactionCount||0),
      lastIntent:context?.conversationState?.lastIntent||null
    },
    conversationIntent:context?.conversationIntent||null,
    conversationTopic:context?.conversationTopic||null,
    conversationInnerState:context?.conversationInnerState||null,
    timeSinceLastActivityHours:context?.timeSinceLastActivityHours??null,
    memories:memories.map(m=>({
      id:m.id||null,
      type:m.memoryType||m.type||null,
      content:String(m.content||m.summary||"").slice(0,500),
      importance:Number(m.importance||0),
      simulationAt:m.simulationAt||m.createdAt||null,
      metadata:m.metadata&&typeof m.metadata==="object"?{
        kind:m.metadata.kind||null,
        actionType:m.metadata.actionType||m.metadata.action||null,
        outcome:m.metadata.outcome||null,
        locationId:m.metadata.locationId||m.metadata.location?.id||null,
        targetEntityId:m.metadata.targetEntityId||m.metadata.interlocutorEntityId||null
      }:null
    })),
    recentConversation:recent.map(m=>({
      messageType:m.messageType,
      content:String(m.content||"").slice(0,700),
      simulationAt:m.simulationAt||null
    })),
    conversationTimeline:(Array.isArray(context?.conversationTimeline)?context.conversationTimeline:recent).slice(0,15).map(m=>({
      messageType:m.messageType,
      content:String(m.content||"").slice(0,700),
      simulationAt:m.simulationAt||null
    })),
    interlocutor:{
      displayName:context?.interlocutor?.displayName||"Observer"
    },
    userMessage:String(context?.userMessage||""),
    responseLanguage:context?.responseLanguage||"it"
  };

  if(advanced){
    compact.entity.id=context?.entity?.id||null;
    compact.interlocutor.id=context?.interlocutor?.id||null;
    compact.cognitiveProfile={
      preferences:compactList(context?.cognitiveProfile?.preferences,p=>({
        targetType:p.targetType,targetEntityId:p.targetEntityId||null,value:Number(p.preferenceValue||0),
        strength:Number(p.strength||0),confidence:Number(p.confidence||0),topic:p.topic||null
      }),8),
      beliefs:compactList(context?.cognitiveProfile?.beliefs,b=>({
        predicate:b.predicate,subjectEntityId:b.subjectEntityId||null,objectValue:b.objectValue,
        confidence:Number(b.confidence||0),importance:Number(b.importance||0)
      }),8),
      knowledge:compactList(context?.cognitiveProfile?.knowledge,k=>({
        knowledgeType:k.knowledgeType,content:String(k.content||"").slice(0,600),
        subjectEntityId:k.subjectEntityId||null,objectEntityId:k.objectEntityId||null,
        predicate:k.predicate||null,confidence:Number(k.confidence||0),importance:Number(k.importance||0)
      }),8),
      habits:compactList(context?.cognitiveProfile?.habits,h=>({
        name:h.name,description:String(h.description||"").slice(0,300),
        strength:Number(h.strength||0),frequency:h.frequency||null
      }),6),
      plans:compactList(context?.cognitiveProfile?.plans,p=>({
        title:p.title,status:p.status,goalId:p.goalId||null,
        steps:Array.isArray(p.steps)?p.steps.slice(0,4).map(step=>({title:step.title,status:step.status,actionType:step.result?.actionType||null})):[],
      }),4)
    };
  }
  return compact;
}

function dialogueProviderSchema({advanced=false}={}){
  const numberArray=items=>({type:"array",items:{type:"object",properties:items}});
  const stateProperties={
    needs:numberArray({code:{type:"string"},delta:{type:"number"}}),
    emotions:numberArray({code:{type:"string"},delta:{type:"number"}}),
    traits:numberArray({code:{type:"string"},delta:{type:"number"}}),
    relationship:{type:"object",nullable:true,properties:{trust:{type:"number"},affection:{type:"number"},respect:{type:"number"},familiarity:{type:"number"},attraction:{type:"number"},conflict:{type:"number"},fear:{type:"number"},admiration:{type:"number"},jealousy:{type:"number"},dependence:{type:"number"},closeness:{type:"number"},irritation:{type:"number"}}},
    communicationStyle:{type:"object",nullable:true,properties:{formality:{type:"number"},warmth:{type:"number"},directness:{type:"number"},verbosity:{type:"number"},humor:{type:"number"},emojiUse:{type:"number"},emotionalOpenness:{type:"number"},argumentativeDepth:{type:"number"}}},
    reflection:{type:"object",nullable:true,properties:{thought:{type:"string",nullable:true},currentFocus:{type:"string",nullable:true},currentConcern:{type:"string",nullable:true},mentalLoad:{type:"number"},rumination:{type:"number"},certainty:{type:"number"}}}
  };
  if(advanced){
    Object.assign(stateProperties,{
      goalProposal:{type:"object",nullable:true,properties:{title:{type:"string"},description:{type:"string"},priority:{type:"number"},reason:{type:"string"}}},
      preferences:numberArray({targetType:{type:"string"},targetEntityId:{type:"string",nullable:true},value:{type:"number"},strength:{type:"number"},confidence:{type:"number"},topic:{type:"string"}}),
      beliefs:numberArray({predicate:{type:"string"},subjectEntityId:{type:"string",nullable:true},objectValue:{type:"string"},confidence:{type:"number"},importance:{type:"number"}}),
      knowledge:numberArray({knowledgeType:{type:"string"},content:{type:"string"},subjectEntityId:{type:"string",nullable:true},objectEntityId:{type:"string",nullable:true},predicate:{type:"string",nullable:true},confidence:{type:"number"},importance:{type:"number"}}),
      habitCandidate:{type:"object",nullable:true,properties:{name:{type:"string"},description:{type:"string"},frequency:{type:"string"},confidence:{type:"number"}}},
      planProposal:{
        type:"object",
        nullable:true,
        properties:{
          title:{type:"string"},
          strategy:{type:"object"},
          steps:{
            type:"array",
            items:{
              type:"object",
              properties:{
                title:{type:"string"},
                description:{type:"string"},
                actionType:{type:"string"}
              }
            }
          }
        }
      }
    });
  }
  return {
    type:"object",
    properties:{
      reply:{type:"string"},
      emotionalTone:{type:"string"},
      rememberedReferences:{type:"array",items:{type:"string"}},
      stateEffects:{type:"object",properties:stateProperties}
    },
    required:["reply","emotionalTone","stateEffects"]
  };
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET","ECONNREFUSED","EPIPE","ETIMEDOUT","EAI_AGAIN","ENETUNREACH",
  "EHOSTUNREACH","ENOTFOUND","FETCH_FAILED","UND_ERR_CONNECT_TIMEOUT","UND_ERR_SOCKET"
]);

function createGeminiCodedError(message,code,details={},cause=null){
  const error=new Error(String(message||"Gemini request failed"));
  error.name="GeminiServiceError";
  error.code=String(code||"GEMINI_ERROR");
  if(details&&typeof details==="object")Object.assign(error,details);
  if(cause)error.cause=cause;
  return error;
}

function summarizeProviderError(err,failure={}){
  return {
    name:err?.name||null,
    code:err?.code||null,
    status:Number.isFinite(Number(failure?.status))?Number(failure.status):(
      Number.isFinite(Number(err?.status))?Number(err.status):null
    ),
    statusText:err?.statusText||err?.response?.statusText||null,
    message:String(err?.message||err||"").slice(0,600)
  };
}

function classifyGeminiError(err) {
  const status=Number(err?.status||err?.statusCode||err?.response?.status||(
    typeof err?.code==="number" ? err.code : 0
  ));
  const code=String(err?.code||"").toUpperCase();
  const message=String(err?.message||"");
  const providerText=message.toUpperCase();
  const explicitQuota=/RESOURCE_EXHAUSTED|QUOTA EXCEEDED|DAILY QUOTA|MONTHLY QUOTA|EXCEEDED.*QUOTA/.test(providerText);
  const explicitRate=/RATE.?LIMIT|TOO MANY REQUESTS/.test(providerText);
  const isQuota=explicitQuota;
  const isRateLimited=!isQuota && (status===429 || explicitRate);
  const retryMatch=message.match(/retryDelay[^0-9]*(\d+(?:\.\d+)?)s/i);
  const retryAfterHeader=typeof err?.response?.headers?.get==="function"
    ? err.response.headers.get("retry-after")
    : err?.response?.headers?.["retry-after"];
  const retryAfterSeconds=Number(retryAfterHeader);
  const retryAfterMs=Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0
    ? Math.ceil(retryAfterSeconds*1000)
    : 0;
  const retryMs=retryAfterMs || (retryMatch ? Math.ceil(Number(retryMatch[1])*1000) : 0);
  const isTimeout=code==="AI_TIMEOUT" ||
    /TIMEOUT|TIMED OUT|DEADLINE EXCEEDED/.test(providerText);
  const isInvalidOutput=code==="AI_INVALID_OUTPUT" ||
    /UNTERMINATED STRING|UNEXPECTED END OF JSON|UNEXPECTED TOKEN/.test(providerText);
  const isTransientHttp=[408,500,502,503,504].includes(status) ||
    /\b503\b.*(?:UNAVAILABLE|SERVICE UNAVAILABLE)|\bUNAVAILABLE\b/.test(providerText);
  const isNetwork=TRANSIENT_NETWORK_CODES.has(code) ||
    /FETCH FAILED|FAILED TO FETCH|NETWORK ERROR|SOCKET|CONNECT(?:ION)? .*FAILED|DNS/.test(providerText);
  if(isQuota)return{kind:"QUOTA",retryAfterMs:retryMs};
  if(isRateLimited)return{kind:"RATE_LIMIT",retryAfterMs:retryMs};
  if(isTimeout)return{kind:"TIMEOUT",retryAfterMs:Math.max(0,retryMs)};
  if(isInvalidOutput)return{kind:"INVALID_OUTPUT",retryAfterMs:retryMs};
  if(isTransientHttp)return{kind:"TRANSIENT",retryAfterMs:retryMs,status};
  if(isNetwork)return{kind:"NETWORK",retryAfterMs:retryMs};
  return{kind:"ERROR",retryAfterMs:0};
}

function computeProviderBackoffMs({
  failureStreak=1,
  retryAfterMs=0,
  baseMs=env.GEMINI_PROVIDER_FAILURE_BASE_COOLDOWN_MS,
  maxMs=env.GEMINI_PROVIDER_FAILURE_MAX_COOLDOWN_MS,
  jitter=env.GEMINI_PROVIDER_FAILURE_JITTER,
  random=Math.random
}={}) {
  const streak=Math.max(1,Math.floor(Number(failureStreak)||1));
  const base=Math.max(1000,Number(baseMs)||10000);
  const cap=Math.max(base,Number(maxMs)||120000);
  const exponent=Math.min(8,streak-1);
  const exponential=Math.min(cap,base*(2**exponent));
  const jitterFraction=Math.max(0,Math.min(1,Number(jitter)||0));
  const jitterMultiplier=1+(Math.max(0,Math.min(1,Number(random())||0))*jitterFraction);
  const delayed=Math.min(cap,Math.ceil(exponential*jitterMultiplier));
  return Math.max(Math.ceil(Number(retryAfterMs)||0),delayed);
}

class GeminiService {
  constructor(){
    this.client=null;
    this.model=env.GEMINI_MODEL;
    this.models=[this.model,"gemini-3.1-flash-lite",...(Array.isArray(env.GEMINI_FALLBACK_MODELS)?env.GEMINI_FALLBACK_MODELS:[])]
      .map(model=>String(model||"").trim())
      .filter(Boolean)
      .filter((model,index,self)=>self.indexOf(model)===index);
    this.dialogueModels=[env.GEMINI_DIALOGUE_MODEL,...(Array.isArray(env.GEMINI_DIALOGUE_FALLBACK_MODELS)?env.GEMINI_DIALOGUE_FALLBACK_MODELS:[])]
      .map(model=>String(model||"").trim())
      .filter(Boolean)
      .filter((model,index,self)=>self.indexOf(model)===index);
    this.modelStates=new Map();
    this.dialogueModelStates=new Map();
    for(const model of this.models)this.modelStates.set(model,{failureStreak:0,blockedUntil:0,reason:null});
    for(const model of this.dialogueModels)this.dialogueModelStates.set(model,{failureStreak:0,blockedUntil:0,reason:null});
    this.lastAutonomyDecisionAt=new Map();
    this.lastRequestStatus={status:"IDLE",source:"NONE"};
    this.providerFailureStreak=0;
    this.activeControllers=new Set();
    this.shuttingDown=false;
  }
  abortAllRequests(reason="shutdown"){
    this.shuttingDown=true;
    for(const controller of [...this.activeControllers]){
      try{controller.abort(reason);}catch{try{controller.abort();}catch{}}
    }
    return this.activeControllers.size;
  }
  resume(){this.shuttingDown=false;}
  _stateMap(kind="autonomy"){
    return kind==="dialogue"?this.dialogueModelStates:this.modelStates;
  }
  _modelState(model,kind="autonomy"){
    const states=this._stateMap(kind);
    let state=states.get(model);
    if(!state){
      state={failureStreak:0,blockedUntil:0,reason:null};
      states.set(model,state);
    }
    return state;
  }
  _modelBlockRemainingMs(model,kind="autonomy"){
    return Math.max(0,Number(this._modelState(model,kind).blockedUntil||0)-Date.now());
  }
  _availableModels(kind="autonomy"){
    const configured=kind==="dialogue"?this.dialogueModels:this.models;
    return configured.filter(model=>this._modelBlockRemainingMs(model,kind)<=0);
  }
  _hasAvailableModel(kind="autonomy"){
    return this._availableModels(kind).length>0;
  }
  _blockModel(model,delayMs,reason,kind="autonomy"){
    const state=this._modelState(model,kind);
    const delay=Math.max(10000,Number(delayMs)||10000);
    state.blockedUntil=Date.now()+delay;
    state.reason=reason||"PROVIDER_TRANSIENT_FAILURE";
    return state;
  }
  _resetModel(model,kind="autonomy"){
    const state=this._modelState(model,kind);
    state.failureStreak=0;
    state.blockedUntil=0;
    state.reason=null;
  }
  modelStatus(kind="autonomy"){
    const configured=kind==="dialogue"?this.dialogueModels:this.models;
    return configured.map(model=>{
      const state=this._modelState(model,kind);
      const blockedForMs=this._modelBlockRemainingMs(model,kind);
      return {
        model,
        available:blockedForMs<=0,
        blockedForMs,
        failureStreak:state.failureStreak,
        reason:state.reason
      };
    });
  }
  async init(){
    await budget.ensureGeminiUsageTable();
    if(!env.GEMINI_ENABLED||!env.GEMINI_API_KEY){
      logger.info("Gemini disabled or API key missing; deterministic fallback enabled");
      return false;
    }
    const {GoogleGenAI}=await import("@google/genai");
    this.client=new GoogleGenAI({apiKey:env.GEMINI_API_KEY});
    logger.info({
      model:this.model,
      fallbacks:this.models.slice(1),
      dailyBudgetUsd:env.GEMINI_DAILY_BUDGET_USD,
      monthlyBudgetUsd:env.GEMINI_MONTHLY_BUDGET_USD,
      autonomyDailyBudgetUsd:env.GEMINI_AUTONOMY_DAILY_BUDGET_USD,
      dialogueDailyBudgetUsd:env.GEMINI_DIALOGUE_DAILY_BUDGET_USD,
      autonomyMonthlyBudgetUsd:env.GEMINI_AUTONOMY_MONTHLY_BUDGET_USD,
      dialogueMonthlyBudgetUsd:env.GEMINI_DIALOGUE_MONTHLY_BUDGET_USD,
      timeoutMs:env.GEMINI_TIMEOUT_MS,
      autonomyOutputTokenCeiling:env.GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING,
      autonomyCompactOutputTokenCeiling:env.GEMINI_AUTONOMY_COMPACT_OUTPUT_TOKEN_CEILING,
      autonomyIntervalMinutes:env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES,
      autonomyMaxModels:env.GEMINI_AUTONOMY_MAX_MODELS,
      dialogueModel:env.GEMINI_DIALOGUE_MODEL,
      dialogueFallbacks:this.dialogueModels.slice(1),
      dialogueTimeoutMs:env.GEMINI_DIALOGUE_TIMEOUT_MS,
      dialogueCompactOutputTokenCeiling:env.GEMINI_DIALOGUE_COMPACT_OUTPUT_TOKEN_CEILING,
      dialogueMaxModels:env.GEMINI_DIALOGUE_MAX_MODELS
    },"Gemini cognitive budget enabled");
    return true;
  }
  canUseAutonomyDecision(entityId,simulationTime,{highValue=false}={}){
    if(!this._hasAvailableModel("autonomy"))return false;
    const previous=this.lastAutonomyDecisionAt.get(entityId);
    if(!previous){
      this.lastAutonomyDecisionAt.set(entityId,new Date(simulationTime).getTime());
      return true;
    }
    const elapsedMinutes=(new Date(simulationTime).getTime()-previous)/60000,
      configuredInterval=Number(env.GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES),
      normalInterval=Math.max(60,Number.isFinite(configuredInterval)?configuredInterval:60),
      intervalMinutes=highValue?Math.min(30,normalInterval):normalInterval;
    if(elapsedMinutes<intervalMinutes)return false;
    this.lastAutonomyDecisionAt.set(entityId,new Date(simulationTime).getTime());
    return true;
  }
  async generateJson(prompt,schema,{kind="autonomy",thinkingLevel="low",maxModels=null,timeoutMsOverride=null,outputTokenCeilingOverride=null,deadlineAt=null,simulationId=null,entityId=null,simulationTime=null,highValue=false,minimumOutputTokenCeiling=512}={}){
    if(!this.client||this.shuttingDown){
      this.lastRequestStatus={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:this.shuttingDown?"ENGINE_SHUTDOWN":"GEMINI_DISABLED",attempted:false,retryAfterMs:0,kind};
      return null;
    }

    const configuredMaxLatencyMs=kind==="dialogue"
      ?Number(env.GEMINI_DIALOGUE_MAX_LATENCY_MS)
      :Number(env.GEMINI_AUTONOMY_MAX_LATENCY_MS);
    // Autonomy may need one provider retry after a transient failure. Keep
    // enough total budget for the primary request plus the bounded fallback.
    const minimumAutonomyLatencyMs=MIN_PROVIDER_DEADLINE_MS*2;
    const effectiveMaxLatencyMs=kind==="autonomy"
      ?Math.max(minimumAutonomyLatencyMs,Number.isFinite(configuredMaxLatencyMs)?configuredMaxLatencyMs:minimumAutonomyLatencyMs)
      :Math.max(MIN_PROVIDER_DEADLINE_MS,Number.isFinite(configuredMaxLatencyMs)?configuredMaxLatencyMs:12000);
    const requestDeadlineAt=Number.isFinite(Number(deadlineAt))&&Number(deadlineAt)>Date.now()
      ?Number(deadlineAt)
      :Date.now()+effectiveMaxLatencyMs;

    const configuredOutputTokenCeiling=Number(outputTokenCeilingOverride)||(
      kind==="dialogue"
        ?Number(env.GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING)
        :Number(env.GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING)
    );
    const requestedOutputTokenCeiling=calculateDynamicStructuredOutputTokenCeiling({
      kind,
      prompt,
      schema,
      thinkingLevel,
      configuredCeiling:configuredOutputTokenCeiling,
      minimumOutputTokenCeiling
    });
    const configuredModels=kind==="dialogue"?this.dialogueModels:this.models;
    const availableModels=this._availableModels(kind);
    const requestedMaxModels=Number(maxModels);
    const models=Number.isFinite(requestedMaxModels)&&requestedMaxModels>0
      ?availableModels.slice(0,Math.floor(requestedMaxModels))
      :availableModels;
    if(!models.length){
      const blocked=configuredModels
        .map(model=>this._modelBlockRemainingMs(model,kind))
        .filter(value=>value>0);
      const retryAfterMs=blocked.length?Math.min(...blocked):0;
      this.lastRequestStatus={
        status:"FALLBACK",
        source:"DETERMINISTIC_FALLBACK",
        reason:"ALL_GEMINI_MODELS_BLOCKED",
        attempted:false,
        retryAfterMs,
        kind
      };
      logger.debug({kind,retryAfterMs},"all Gemini models unavailable; deterministic fallback used");
      return null;
    }

    let responseSchema;
    try{
      responseSchema=toProviderJsonSchema(schema);
    }catch(error){
      this.lastRequestStatus={
        status:"FALLBACK",
        source:"DETERMINISTIC_FALLBACK",
        reason:"AI_SCHEMA_CONVERSION_FAILED",
        attempted:false,
        retryAfterMs:0,
        kind
      };
      logger.error({
        kind,
        error:String(error?.message||error),
        errorCode:String(error?.code||"UNKNOWN_SCHEMA_ERROR")
      },"Gemini provider schema conversion failed; deterministic fallback used");
      return null;
    }

    let lastTransientFailure=null;
    for(let modelIndex=0;modelIndex<models.length;modelIndex++){
      const model=models[modelIndex];
      const remainingBudgetMs=requestDeadlineAt-Date.now();
      if(remainingBudgetMs<MIN_PROVIDER_DEADLINE_MS){
        this.lastRequestStatus={
          status:"FALLBACK",
          source:"DETERMINISTIC_FALLBACK",
          reason:"GEMINI_DEADLINE_TOO_SHORT",
          attempted:modelIndex>0,
          retryAfterMs:0,
          kind,
          model
        };
        logger.debugThrottled(
          `gemini:deadline-too-short:${kind}`,
          60000,
          {kind,model,remainingBudgetMs,minProviderDeadlineMs:MIN_PROVIDER_DEADLINE_MS},
          "Gemini request skipped because less than the provider minimum deadline remained; deterministic fallback used"
        );
        return null;
      }
      if(this.shuttingDown){
        this.lastRequestStatus={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"ENGINE_SHUTDOWN",attempted:modelIndex>0,retryAfterMs:0,kind};
        return null;
      }
      if(remainingBudgetMs<=0){
        this.lastRequestStatus={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"GEMINI_HARD_DEADLINE",attempted:modelIndex>0,retryAfterMs:0,kind};
        logger.warnThrottled(
          `gemini:deadline:${kind}`,
          60000,
          {kind,models},
          "Gemini total request deadline reached; deterministic fallback used"
        );
        return null;
      }
      const reservation=await budget.reserve({prompt,outputTokenCeiling:requestedOutputTokenCeiling,minimumOutputTokenCeiling,highValue,kind,simulationId,entityId,simulationTime});
      if(!reservation.allowed){
        this.lastRequestStatus={
          status:"FALLBACK",
          source:"DETERMINISTIC_FALLBACK",
          reason:reservation.reason,
          attempted:false,
          retryAfterMs:Number(reservation.retryAfterMs||0),
          kind
        };
        logger.debugThrottled(
          `gemini:budget:${kind}:${reservation.reason}`,
          60000,
          {
            kind,
            reason:reservation.reason,
            retryAfterMs:Number(reservation.retryAfterMs||0),
            estimatedUsd:Number(reservation.estimatedUsd||0),
            pacedDailyLimit:Number(reservation.pacedDailyLimit||0)
          },
          "Gemini request skipped by local budget/provider gate; deterministic fallback used"
        );
        return null;
      }

      const outputTokenCeiling=Math.max(1,Number(reservation.outputTokenCeiling)||requestedOutputTokenCeiling);
      const configuredTimeoutMs=Number(timeoutMsOverride)||Number(env.GEMINI_TIMEOUT_MS)||30000;
      const timeoutBudgetMs=requestDeadlineAt-Date.now();
      if(timeoutBudgetMs<MIN_PROVIDER_DEADLINE_MS){
        this.lastRequestStatus={
          status:"FALLBACK",
          source:"DETERMINISTIC_FALLBACK",
          reason:"GEMINI_DEADLINE_TOO_SHORT",
          attempted:modelIndex>0,
          retryAfterMs:0,
          kind,
          model
        };
        return null;
      }
      const timeoutMs=kind==="dialogue"
        ?Math.max(MIN_PROVIDER_DEADLINE_MS,Math.min(30000,configuredTimeoutMs,timeoutBudgetMs))
        :Math.max(MIN_PROVIDER_DEADLINE_MS,Math.min(configuredTimeoutMs,timeoutBudgetMs));
      const startedAt=Date.now();
      const controller=new AbortController();
      this.activeControllers.add(controller);
      const timeoutId=setTimeout(()=>controller.abort("request-timeout"),timeoutMs);
      let finalized=false;
      let raw="";

      try{
        const response=await this.client.models.generateContent({
          model,
          contents:prompt,
          config:{
            responseMimeType:"application/json",
            responseSchema,
            maxOutputTokens:outputTokenCeiling,
            thinkingConfig:{thinkingLevel},
            abortSignal:controller.signal,
            httpOptions:{
              timeout:timeoutMs,
              retryOptions:{attempts:1,initialDelay:0}
            }
          }
        });
        raw=typeof response.text==="string"?response.text:"";
        const finishReason=String(
          response?.candidates?.[0]?.finishReason ||
          response?.candidates?.[0]?.finish_reason ||
          ""
        ).toUpperCase();

        // maxOutputTokens is a hard ceiling that can truncate JSON, so treat
        // MAX_TOKENS/LENGTH as invalid structured output and fail over.
        await budget.finalize(reservation,response.usageMetadata);
        finalized=true;

        let parsed;
        try{
          if(finishReason==="MAX_TOKENS"||finishReason==="LENGTH"){
            throw new Error("Gemini structured output truncated");
          }
          parsed=schema.parse(JSON.parse(raw));
        }catch(parseError){
          throw createGeminiCodedError(
            parseError?.message||"Gemini produced invalid structured output",
            "AI_INVALID_OUTPUT",
            {finishReason:finishReason||null,rawPreview:raw.slice(0,500)},
            parseError
          );
        }

        this._resetModel(model,kind);
        this.providerFailureStreak=0;
        this.lastRequestStatus={
          status:"SUCCESS",
          source:"GEMINI",
          reason:"PROVIDER_SUCCESS",
          attempted:true,
          retryAfterMs:0,
          kind,
          model,
          fallbackDepth:modelIndex
        };
        const usage=response.usageMetadata||{};
        const outputTokens=Number(usage.candidatesTokenCount||0)+Number(usage.thoughtsTokenCount||0);
        logger.debug({
          kind,
          model,
          fallbackDepth:modelIndex,
          latencyMs:Date.now()-startedAt,
          inputTokens:Number(usage.promptTokenCount||reservation.inputTokens||0),
          outputTokens,
          selectedActionType:kind==="autonomy"?parsed.selectedActionType:undefined
        },"Gemini request succeeded");
        return parsed;
      }catch(err){
        if(controller.signal.aborted){
          if(this.shuttingDown||String(controller.signal.reason||"").toLowerCase().includes("shutdown")){
            this.lastRequestStatus={status:"FALLBACK",source:"DETERMINISTIC_FALLBACK",reason:"ENGINE_SHUTDOWN",attempted:true,retryAfterMs:0,kind,model,fallbackDepth:modelIndex};
            return null;
          }
          err=createGeminiCodedError(
            "Gemini request timed out",
            "AI_TIMEOUT",
            {reason:controller.signal.reason||"request-timeout"},
            err||null
          );
        }
        const failure=classifyGeminiError(err);
        const isProviderRejection=failure.kind==="RATE_LIMIT"||failure.kind==="QUOTA";
        const fallbackReason=failure.kind==="RATE_LIMIT"
          ?"PROVIDER_RATE_LIMIT"
          :failure.kind==="QUOTA"
            ?"PROVIDER_QUOTA_EXHAUSTED"
            :failure.kind==="TIMEOUT"
              ?"AI_TIMEOUT"
              :failure.kind==="TRANSIENT"
                ?"PROVIDER_TRANSIENT_FAILURE"
                :failure.kind==="NETWORK"
                  ?"PROVIDER_NETWORK_FAILURE"
                  :"PROVIDER_ERROR";

        if(!finalized){
          try{
            await budget.release(reservation);
            if(isProviderRejection)await budget.restoreRejectedRequest(reservation);
          }catch(releaseErr){
            logger.error({err:releaseErr,kind,model},"Failed to release Gemini budget reservation");
          }
        }

        if(failure.kind==="INVALID_OUTPUT"){
          const fallbackModel=models[modelIndex+1]||null;
          lastTransientFailure={
            reason:"AI_INVALID_OUTPUT",
            retryAfterMs:0,
            model
          };
          this.lastRequestStatus={
            status:"FALLBACK",
            source:"DETERMINISTIC_FALLBACK",
            reason:"AI_INVALID_OUTPUT",
            attempted:true,
            retryAfterMs:0,
            kind,
            model,
            fallbackDepth:modelIndex
          };
          logger.warnThrottled(
            `gemini:invalid-output:${kind}:${model}`,
            60000,
            {
              kind,
              model,
              finishReason:err?.finishReason||null,
              error:err?.message||String(err),
              rawPreview:typeof raw==="string"?raw.slice(0,500):"",
              fallbackTo:fallbackModel,
              latencyMs:Date.now()-startedAt,
              providerError:summarizeProviderError(err,failure)
            },
            fallbackModel
              ? "Gemini produced invalid structured output; trying fallback model"
              : "Gemini produced invalid structured output; deterministic fallback will be used"
          );
          continue;
        }

        if(failure.kind==="RATE_LIMIT"||failure.kind==="QUOTA"){
          const state=this._modelState(model,kind);
          state.failureStreak=0;
          const configuredCooldown=failure.kind==="QUOTA"
            ?Number(env.GEMINI_PROVIDER_QUOTA_COOLDOWN_MS)
            :Number(env.GEMINI_PROVIDER_RATE_LIMIT_COOLDOWN_MS);
          const modelCooldown=Math.max(failure.retryAfterMs||0,configuredCooldown||0);
          this._blockModel(model,modelCooldown,fallbackReason,kind);
          this.lastRequestStatus={
            status:"FALLBACK",
            source:"DETERMINISTIC_FALLBACK",
            reason:fallbackReason,
            attempted:true,
            retryAfterMs:modelCooldown,
            kind,
            model,
            fallbackDepth:modelIndex
          };
          const fallbackModel=models[modelIndex+1]||null;
          lastTransientFailure={
            reason:fallbackReason,
            retryAfterMs:modelCooldown,
            model
          };
          logger.warnThrottled(
            `gemini:provider-limit:${kind}:${fallbackReason}`,
            900000,
            {
              kind,
              model,
              reason:fallbackReason,
              retryAfterMs:modelCooldown,
              fallbackTo:fallbackModel
            },
            fallbackModel
              ? "Gemini model limit reached; trying fallback model"
              : "Gemini model limit reached; deterministic fallback will be used"
          );
          continue;
        }

        if(failure.kind==="TIMEOUT"||failure.kind==="TRANSIENT"||failure.kind==="NETWORK"){
          const state=this._modelState(model,kind);
          state.failureStreak=Math.min(16,state.failureStreak+1);
          const transientCooldown=computeProviderBackoffMs({
            failureStreak:state.failureStreak,
            retryAfterMs:failure.retryAfterMs
          });
          this._blockModel(model,transientCooldown,fallbackReason,kind);
          this.providerFailureStreak=state.failureStreak;
          lastTransientFailure={
            reason:fallbackReason,
            retryAfterMs:transientCooldown,
            model
          };
          const fallbackModel=models[modelIndex+1]||null;
          logger.warnThrottled(
            `gemini:provider-failure:${kind}`,
            300000,
            {
              kind,
              model,
              status:failure.status||null,
              reason:fallbackReason,
              failureStreak:state.failureStreak,
              retryAfterMs:transientCooldown,
              fallbackTo:fallbackModel,
              latencyMs:Date.now()-startedAt,
              providerError:summarizeProviderError(err,failure)
            },
            fallbackModel
              ? "Gemini model unavailable; trying fallback model"
              : "Gemini model unavailable; deterministic fallback will be used"
          );
          continue;
        }

        this.lastRequestStatus={
          status:"FALLBACK",
          source:"DETERMINISTIC_FALLBACK",
          reason:fallbackReason,
          attempted:true,
          retryAfterMs:0,
          kind,
          model,
          fallbackDepth:modelIndex
        };
        logger.warnThrottled(
          `gemini:request-failed:${kind}:${model}`,
          60000,
          {err,kind,model},
          "Gemini request failed; deterministic fallback will be used"
        );
        return null;
      }finally{
        clearTimeout(timeoutId);
        this.activeControllers.delete(controller);
      }
    }

    this.lastRequestStatus={
      status:"FALLBACK",
      source:"DETERMINISTIC_FALLBACK",
      reason:lastTransientFailure?.reason||"ALL_GEMINI_MODELS_FAILED",
      attempted:true,
      retryAfterMs:Number(lastTransientFailure?.retryAfterMs||0),
      kind,
      model:lastTransientFailure?.model||null,
      fallbackDepth:models.length
    };
    const finalReason=lastTransientFailure?.reason||"ALL_GEMINI_MODELS_FAILED";
    const finalMessage=
      finalReason==="AI_INVALID_OUTPUT"
        ? (models.length>1
            ? "all attempted Gemini models returned invalid structured output; deterministic fallback used"
            : "Gemini structured output was invalid; deterministic fallback used")
        : finalReason==="PROVIDER_TRANSIENT_FAILURE"
          ? "all attempted Gemini models were temporarily unavailable; deterministic fallback used"
          : "all attempted Gemini models failed; deterministic fallback used";
    logger.warnThrottled(
      `gemini:all-failed:${kind}`,
      900000,
      {
        kind,
        models,
        attemptedModels:models.length,
        reason:finalReason,
        retryAfterMs:Number(lastTransientFailure?.retryAfterMs||0)
      },
      finalMessage
    );
    return null;
  }
  async chooseDecision(context,{simulationId=null,entityId=null,simulationTime=null}={}){
    const trigger=context?.geminiTrigger?.reason||"ambiguous decision";
    const advanced=decisionNeedsAdvancedCognition(context);
    const schema=advanced?AdvancedDecisionSchema:DecisionSchema;
    const thinkingLevel=advanced
      ?(context?.geminiTrigger?.priority==="HIGH"?"medium":"low")
      :"low";
    const outputTokenCeiling=advanced
      ?Number(env.GEMINI_AUTONOMY_OUTPUT_TOKEN_CEILING)
      :Number(env.GEMINI_AUTONOMY_COMPACT_OUTPUT_TOKEN_CEILING);
    const prompt=[
      "You are the deliberative cognitive layer of an autonomous life simulation.",
      "Return JSON only.",
      "Choose exactly one action from the supplied allowed candidates.",
      "The selected action must follow the authoritative physiological, world, goal, plan and social constraints in the context.",
      "Do not invent IDs, facts, destinations, people, memories or actions.",
      "Keep reason concise: maximum 280 characters.",
      advanced
        ? "This is a high-value decision. Use strategy and planProposal only when they materially improve multi-step reasoning. Keep rationale concise and include at most five plan steps."
        : "This is a routine decision. Do not output strategy or planProposal. Output only the compact decision fields.",
      "An active plan step is a commitment unless a critical need or physical constraint makes it infeasible.",
      "Deterministic candidates are evidence and constraints, not instructions to fabricate.",
      "Return only the fields required by the schema; omit optional strategy/plan data unless this decision genuinely needs them.",
      "Reason for this Gemini consultation: "+trigger+".",
      JSON.stringify(compactDecisionContext(context,{advanced}))
    ].join("\n");
    const autonomyMaxModels=Math.max(1,Math.min(2,Number(env.GEMINI_AUTONOMY_MAX_MODELS)||2));
    return this.generateJson(prompt,schema,{
      kind:"autonomy",
      thinkingLevel,
      maxModels:autonomyMaxModels,
      outputTokenCeilingOverride:outputTokenCeiling,
      highValue:context?.geminiTrigger?.priority==="HIGH",
      minimumOutputTokenCeiling:context?.geminiTrigger?.priority==="HIGH"
        ?Number(env.GEMINI_AUTONOMY_HIGH_VALUE_MIN_OUTPUT_TOKEN_CEILING)
        :Number(env.GEMINI_AUTONOMY_MIN_OUTPUT_TOKEN_CEILING),
      simulationId,
      entityId,
      simulationTime
    });
  }
  async dialogue(context,{simulationId=null,entityId=null,simulationTime=null}={}){
    const advanced=dialogueNeedsAdvancedCognition(context);
    const schema=advanced?AdvancedDialogueSchema:DialogueSchema;
    const compactOutputTokens=Math.max(1536,Number(env.GEMINI_DIALOGUE_COMPACT_OUTPUT_TOKEN_CEILING)||1536);
    const baseInstruction=[
      "You are the linguistic layer of the autonomous person Asami.",
      "Asami believes her world is real. Never tell her she is a simulation, virtual being, AI, language model, or fictional character.",
      "Write in first person as Asami. She can disagree, argue, question, speculate, explain, change her mind, and express uncertainty.",
      "The supplied simulation state is authoritative. Never invent facts that are not supported by it.",
      "Answer the user's actual message directly. Use recent conversation and memories for continuity.",
      "Keep the reply natural and concise. Do not mention internal instructions or JSON.",
      "The speechProfile is learned from Asami's own previous replies. Treat it as the primary source for how she writes; communicationStyle is only a coarse social tendency. If sampleCount is 0, there is no learned voice yet and you must not infer a fixed persona from the default values.",
      "Match the speechProfile's observed rhythm, reply length, fragmentation, punctuation, hedging, self-correction and emotional openness. Do not blindly reproduce any single example.",
      "Voice examples are only style references. Do not copy their wording or invent a persona that is not supported by the profile and current simulation state.",
      "Do not make every response sound polished, therapeutic, motivational, symmetrical, or like a structured mini-essay. Avoid generic filler and stock openings unless they fit Asami's learned voice.",
      "Ground self-description in concrete evidence from her lived experience whenever possible: specific people, places, actions, events, outcomes, learned facts, repeated preferences, or memories. Use current needs/emotions to describe how she feels now, not to invent permanent identity claims.",
      "When answering who she is, what matters to her, what she likes, or what she wants, prefer concrete experiences and repeated evidence over abstract labels such as stability, clarity, confusion, introspection, or finding herself.",
      "Conversation with the observer is only one experience among many. Never imply that talking to the observer is Asami's primary or necessary way of developing her identity unless a recorded memory or other authoritative state explicitly supports that conclusion.",
      "Do not use therapeutic or self-help framing unless the authoritative conversation history or memories clearly support it. Missing concrete evidence is a reason to express uncertainty, not to fill the gap with abstract introspection.",
      "Short answers should stay short. A reply may be tentative, fragmented, blunt, or self-correcting when the learned profile and current state support it.",
      "Always answer in the language identified by responseLanguage. Treat responseLanguage as an explicit output constraint: use only that language for the reply unless the user explicitly requests another language.",
      advanced
        ? "This message has meaningful cognitive relevance. Only extract advanced preferences, beliefs, knowledge, habits, goals, or plans when directly supported by the user's message."
        : "This is ordinary conversation. Do not extract preferences, beliefs, knowledge, habits, goals, or plans. Focus only on language and small immediate state effects.",
      "Structured stateEffects are evidence candidates, not commands. Keep them sparse and small."
    ].join("\n");
    const promptContext=JSON.stringify(compactDialogueContext(context,{advanced}));
    const dialogueDeadlineAt=Date.now()+Math.max(5000,Number(env.GEMINI_DIALOGUE_MAX_LATENCY_MS)||12000);
    const generated=await this.generateJson(
      [baseInstruction,promptContext].join("\n"),
      schema,
      {
        kind:"dialogue",
        thinkingLevel:advanced?"low":"minimal",
        maxModels:1,
        timeoutMsOverride:env.GEMINI_DIALOGUE_TIMEOUT_MS,
        outputTokenCeilingOverride:advanced?Number(env.GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING):compactOutputTokens,
        deadlineAt:dialogueDeadlineAt,
        simulationId,
        entityId,
        simulationTime
      }
    );
    if(generated)return generated;

    if(this.lastRequestStatus.reason==="AI_INVALID_OUTPUT"){
      logger.warn({
        kind:"dialogue",
        model:this.lastRequestStatus.model||null,
        reason:"AI_INVALID_OUTPUT",
        retry:"COMPACT_DIALOGUE_SCHEMA"
      },"Retrying Gemini dialogue with compact schema");
      const retryContext=JSON.stringify(compactDialogueContext(context,{advanced:false}));
      const retryDeadlineAt=Date.now()+10000;
      const retry=await this.generateJson(
        [
          "You are Asami. Reply naturally in first person to the user's message.",
          "Use only the supplied state. Do not invent memories, actions, goals or facts.",
          "Use speechProfile and its voice examples to preserve Asami's learned writing rhythm; do not copy their wording.",
          "Do not default to polished, therapeutic, generic assistant-like prose.",
          "Always answer in the language identified by responseLanguage. Treat responseLanguage as an explicit output constraint.",
          "Return the compact dialogue JSON only.",
          retryContext
        ].join("\n"),
        DialogueSchema,
        {
          kind:"dialogue",
          thinkingLevel:"low",
          maxModels:1,
          timeoutMsOverride:10000,
          outputTokenCeilingOverride:compactOutputTokens,
          deadlineAt:retryDeadlineAt,
          simulationId,
          entityId,
          simulationTime
        }
      );
      if(retry)return retry;
    }

    const fallbackReason=this.lastRequestStatus.reason;
    if(fallbackReason==="PROVIDER_TRANSIENT_FAILURE"||fallbackReason==="AI_TIMEOUT"||fallbackReason==="PROVIDER_NETWORK_FAILURE"||fallbackReason==="PROVIDER_RATE_LIMIT"||fallbackReason==="PROVIDER_QUOTA_EXHAUSTED"){
      const fallbackContext=JSON.stringify(compactDialogueContext(context,{advanced}));
      const fallbackDeadlineAt=Date.now()+10000;
      return this.generateJson(
        [baseInstruction,fallbackContext].join("\n"),
        schema,
        {
          kind:"dialogue",
          thinkingLevel:"low",
          maxModels:env.GEMINI_DIALOGUE_MAX_MODELS,
          timeoutMsOverride:env.GEMINI_DIALOGUE_TIMEOUT_MS,
          outputTokenCeilingOverride:advanced?Number(env.GEMINI_DIALOGUE_OUTPUT_TOKEN_CEILING):compactOutputTokens,
          deadlineAt:fallbackDeadlineAt,
          simulationId,
          entityId,
          simulationTime
        }
      );
    }
    return null;
  }

}
module.exports={GeminiService,DecisionSchema,AdvancedDecisionSchema,DialogueSchema,AdvancedDialogueSchema,decisionNeedsAdvancedCognition,dialogueNeedsAdvancedCognition,compactDialogueContext,compactDecisionContext,calculateDynamicStructuredOutputTokenCeiling,classifyGeminiError,computeProviderBackoffMs,toProviderJsonSchema};
