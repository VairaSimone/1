const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { recallContext, createMemory } = require("./memory-service");
const { ensureEntityState, readNeeds, applyEmotions, getTraits } = require("./state-service");
const { getDashboard } = require("../repositories/entity-repo");
const { createEvent, addEffect } = require("./event-service");
const { upsertInteractionRelationship } = require("./relationship-service");
const { learnFromAction } = require("./action-service");

async function ensureConversation(simulationId, senderEntityId, asamiEntityId, conversationId, simulationTime) {
  if (conversationId) {
    const [rows] = await pool.query(`
      SELECT BIN_TO_UUID(id) AS id FROM conversations
      WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) AND status='ACTIVE'
    `, [simulationId, conversationId]);
    if (!rows.length) throw Object.assign(new Error("Conversation not found"), { code: "NOT_FOUND" });

    for (const entityId of [senderEntityId, asamiEntityId]) {
      await pool.query(`
        INSERT IGNORE INTO conversation_participants
          (conversation_id,simulation_id,entity_id,joined_simulation_at)
        VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
      `, [conversationId, simulationId, entityId, simulationTime]);
    }
    return conversationId;
  }

  const id = uuid();
  await pool.query(`
    INSERT INTO conversations
      (id,simulation_id,channel,created_simulation_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT',?,'ACTIVE',?,1)
  `, [id, simulationId, simulationTime, JSON.stringify({ asamiEntityId, senderEntityId })]);

  for (const entityId of [senderEntityId, asamiEntityId]) {
    await pool.query(`
      INSERT INTO conversation_participants
        (conversation_id,simulation_id,entity_id,joined_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `, [id, simulationId, entityId, simulationTime]);
  }
  return id;
}

async function sendMessage({ simulationId, senderEntityId, asamiEntityId, conversationId, content, simulationTime, gemini, hub }) {
  await ensureEntityState(asamiEntityId, simulationTime);
  const cid = await ensureConversation(simulationId, senderEntityId, asamiEntityId, conversationId, simulationTime);
  const intentId = uuid();

  await pool.query(`
    INSERT INTO communication_intents
      (id,simulation_id,entity_id,target_entity_id,channel,reason_type,priority,status,created_simulation_at,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT','USER_MESSAGE',1,'ATTEMPTING',?,1)
  `, [intentId, simulationId, senderEntityId, asamiEntityId, simulationTime]);

  const attemptId = uuid();
  await pool.query(`
    INSERT INTO communication_attempts
      (id,simulation_id,intent_id,attempted_simulation_at,status,result)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'STARTED',NULL)
  `, [attemptId, simulationId, intentId, simulationTime]);

  const userMessageId = uuid();
  await pool.query(`
    INSERT INTO messages
      (id,simulation_id,conversation_id,sender_entity_id,message_type,content,simulation_created_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'USER',?,?,'DELIVERED',?,1)
  `, [userMessageId, simulationId, cid, senderEntityId, content, simulationTime, JSON.stringify({ source: "frontend" })]);

  hub.publish(simulationId, "message.created", {
    id: userMessageId,
    conversationId: cid,
    senderEntityId,
    type: "USER",
    content
  });

  await pool.query(`
    UPDATE communication_attempts
    SET status='DELIVERED',result=?
    WHERE id=UUID_TO_BIN(?) AND status='STARTED'
  `, [JSON.stringify({ messageId: userMessageId }), attemptId]);

  const context = await buildAsamiConversationContext(simulationId, asamiEntityId, senderEntityId, cid, content);
  const generated = gemini?.client ? await gemini.dialogue(context) : null;
  const reply = generated?.reply || deterministicReply(context, content);

  const eventId = await createEvent({
    simulationId,
    eventTypeCode: "COMMUNICATION",
    title: `${context.entity.displayName} talked with ${context.interlocutor.displayName}`,
    description: "Direct user-to-Asami conversation",
    simulationAt: simulationTime,
    importance: 0.7,
    participants: [
      { entityId: asamiEntityId, role: "ACTOR" },
      { entityId: senderEntityId, role: "PARTICIPANT" }
    ],
    metadata: {
      channel: "CHAT",
      conversationId: cid,
      userMessageId,
      replyGeneratedBy: generated ? "GEMINI" : "DETERMINISTIC"
    }
  });

  const actionId = uuid();
  await pool.query(`
    INSERT INTO actions
      (id,simulation_id,entity_id,decision_id,action_type,source_type,source_event_id,started_simulation_at,
       completed_simulation_at,status,target,parameters,result,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),NULL,'TALKING','USER_TRIGGERED',UUID_TO_BIN(?),?,?,'COMPLETED',NULL,?,?,1)
  `, [
    actionId,
    simulationId,
    asamiEntityId,
    eventId,
    simulationTime,
    simulationTime,
    JSON.stringify({ targetEntityId: senderEntityId, conversationId: cid }),
    JSON.stringify({ eventId, actionType: "TALKING", source: "USER_TRIGGERED" })
  ]);

  await addEffect({
    simulationId,
    eventId,
    effectType: "ACTION_COMPLETED",
    targetActionId: actionId,
    targetEntityId: asamiEntityId,
    afterState: { actionType: "TALKING", status: "COMPLETED", sourceType: "USER_TRIGGERED" },
    magnitude: 1,
    createdSimulationAt: simulationTime
  });

  const interactionHours = 0.05;
  const needChanges = await require("./state-service").updateNeeds(
    asamiEntityId,
    simulationTime,
    interactionHours,
    eventId,
    actionId,
    "TALKING"
  );
  const emotionChanges = await applyEmotions(asamiEntityId, simulationTime, needChanges, eventId, actionId);

  const relationshipId = await upsertInteractionRelationship({
    simulationId,
    sourceEntityId: asamiEntityId,
    targetEntityId: senderEntityId,
    simulationAt: simulationTime,
    sourceEventId: eventId,
    deltas: {
      familiarity: 0.02,
      closeness: 0.012,
      affection: 0.006,
      trust: 0.004,
      irritation: 0
    }
  });

  await learnFromAction(asamiEntityId, "TALKING", simulationTime);

  const aiMeta = generated
    ? {
        cognitive: true,
        responseSource: "GEMINI",
        emotionalTone: generated.emotionalTone,
        rememberedReferences: generated.rememberedReferences,
        stateGrounded: true,
        eventId,
        actionId
      }
    : {
        cognitive: true,
        responseSource: "DETERMINISTIC",
        fallback: true,
        stateGrounded: true,
        eventId,
        actionId
      };

  const assistantId = uuid();
  await pool.query(`
    INSERT INTO messages
      (id,simulation_id,conversation_id,sender_entity_id,message_type,content,simulation_created_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'ASSISTANT',?,?,'DELIVERED',?,1)
  `, [assistantId, simulationId, cid, asamiEntityId, reply, simulationTime, JSON.stringify(aiMeta)]);

  await pool.query(`
    UPDATE communication_intents
    SET status='SENT',version=version+1
    WHERE id=UUID_TO_BIN(?) AND status='ATTEMPTING'
  `, [intentId]);

  await createMemory({
    simulationId,
    entityId: asamiEntityId,
    content: `Conversation with ${context.interlocutor.displayName}: they said "${content}". I replied "${reply}"`,
    importance: 0.75,
    strength: 0.98,
    confidence: generated ? 0.92 : 0.65,
    emotionalIntensity: 0.35,
    simulationAt: simulationTime,
    metadata: {
      kind: "conversation",
      conversationId: cid,
      interlocutorEntityId: senderEntityId,
      eventId,
      actionId,
      rememberedReferences: generated?.rememberedReferences || []
    }
  });

  hub.publish(simulationId, "message.created", {
    id: assistantId,
    conversationId: cid,
    senderEntityId: asamiEntityId,
    type: "ASSISTANT",
    content: reply
  });

  hub.publish(simulationId, "entity.state", {
    entityId: asamiEntityId,
    source: "conversation",
    needs: needChanges,
    emotions: emotionChanges,
    relationshipId,
    actionId,
    eventId
  });

  return {
    conversationId: cid,
    userMessageId,
    assistantMessageId: assistantId,
    reply,
    aiUsed: Boolean(generated),
    asamiEffects: {
      actionId,
      eventId,
      relationshipId,
      needs: needChanges,
      emotions: emotionChanges,
      memoryCreated: true,
      communicationSkillReinforced: true
    }
  };
}

async function buildAsamiConversationContext(simulationId, asamiEntityId, senderEntityId, conversationId, userMessage) {
  const dashboard = await getDashboard(simulationId, asamiEntityId);
  const memories = await recallContext(simulationId, asamiEntityId, 8);
  const traits = dashboard?.traits || await getTraits(asamiEntityId);

  const [messages] = await pool.query(`
    SELECT message_type AS messageType, content
    FROM messages
    WHERE simulation_id=UUID_TO_BIN(?) AND conversation_id=UUID_TO_BIN(?)
    ORDER BY simulation_created_at DESC
    LIMIT 12
  `, [simulationId, conversationId]);

  const entity = dashboard?.entity || { id: asamiEntityId, displayName: "Asami" };
  const [interlocutorRows] = await pool.query(`
    SELECT BIN_TO_UUID(id) AS id, display_name AS displayName, description, attributes
    FROM entities
    WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?)
    LIMIT 1
  `, [simulationId, senderEntityId]);

  return {
    role: "Asami",
    instruction: [
      "Speak as Asami in first person.",
      "You are not a generic assistant and must not mention being an AI, language model, or simulation unless the provided context makes that fact directly relevant.",
      "Your response must be grounded in Asami's current state, memories, personality, goals and relationship with the interlocutor.",
      "Do not invent memories, actions, facts, locations or relationships that are not present in the context.",
      "Show personality naturally; do not expose internal numeric state values unless asked.",
      "The conversation itself is a real experience for Asami and should feel continuous with her previous experiences."
    ].join("\n"),
    entity,
    needs: dashboard?.needs || [],
    emotions: dashboard?.emotions || [],
    traits,
    skills: dashboard?.skills || [],
    goals: dashboard?.goals || [],
    currentAction: dashboard?.currentAction || null,
    location: dashboard?.location || null,
    relationships: dashboard?.relationships || [],
    memories,
    recentConversation: messages.reverse(),
    interlocutor: interlocutorRows[0] || { id: senderEntityId, displayName: "Observer" },
    userMessage
  };
}

function deterministicReply(context, content) {
  const x = content.toLowerCase();
  const emotion = (context.emotions || []).find(e => Number(e.intensity) >= 0.6)?.name || null;
  const relationship = (context.relationships || []).find(r =>
    r.sourceEntityId === context.interlocutor?.id || r.targetEntityId === context.interlocutor?.id
  );

  if (/\bciao|hey|salve\b/.test(x)) {
    if (relationship && Number(relationship.closeness || relationship.closenessScore || 0) > 0.35) return `Ciao. Mi fa piacere sentirti.`;
    return "Ciao. Ti ascolto.";
  }
  if (x.includes("come stai")) {
    if (emotion) return `In questo momento mi sento ${emotion.toLowerCase()}. Sto ancora cercando di capire bene cosa mi sta influenzando.`;
    return "Sto bene. In questo momento sto cercando di capire cosa sento e cosa mi serve.";
  }
  if (x.includes("cosa stai facendo")) {
    const action = context.currentAction?.actionType;
    return action
      ? `In questo momento sto ${action.toLowerCase().replaceAll("_", " ")}. Però posso fermarmi a parlare con te.`
      : "Sto seguendo quello che in questo momento considero più importante per me.";
  }
  return "Ti ho ascoltato. Quello che mi hai detto farà parte di questa esperienza con te.";
}

module.exports = { sendMessage };