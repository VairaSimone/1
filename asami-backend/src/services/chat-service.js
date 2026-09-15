const { pool } = require("../db/pool");
const { uuid } = require("../lib/ids");
const { recallContext, createMemory } = require("./memory-service");
const { getTraits } = require("./state-service");

async function ensureConversation(simulationId,senderEntityId,asamiEntityId,conversationId,simulationTime){
  if(conversationId){
    const [rows]=await pool.query(`
      SELECT BIN_TO_UUID(id) AS id FROM conversations
      WHERE simulation_id=UUID_TO_BIN(?) AND id=UUID_TO_BIN(?) AND status='ACTIVE'
    `,[simulationId,conversationId]);
    if(!rows.length) throw Object.assign(new Error("Conversation not found"),{code:"NOT_FOUND"});
    await pool.query(`
      INSERT IGNORE INTO conversation_participants(conversation_id,simulation_id,entity_id,joined_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[conversationId,simulationId,senderEntityId,simulationTime]);
    await pool.query(`
      INSERT IGNORE INTO conversation_participants(conversation_id,simulation_id,entity_id,joined_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[conversationId,simulationId,asamiEntityId,simulationTime]);
    return conversationId;
  }
  const id=uuid();
  await pool.query(`
    INSERT INTO conversations(id,simulation_id,channel,created_simulation_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT',?,'ACTIVE',?,1)
  `,[id,simulationId,simulationTime,JSON.stringify({asamiEntityId,senderEntityId})]);
  for(const entityId of [senderEntityId,asamiEntityId]){
    await pool.query(`
      INSERT INTO conversation_participants(conversation_id,simulation_id,entity_id,joined_simulation_at)
      VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?)
    `,[id,simulationId,entityId,simulationTime]);
  }
  return id;
}

async function sendMessage({simulationId,senderEntityId,asamiEntityId,conversationId,content,simulationTime,gemini,hub}){
  const cid=await ensureConversation(simulationId,senderEntityId,asamiEntityId,conversationId,simulationTime);
  const intentId=uuid();
  await pool.query(`
    INSERT INTO communication_intents
      (id,simulation_id,entity_id,target_entity_id,channel,reason_type,priority,status,created_simulation_at,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'CHAT','USER_MESSAGE',1,'ATTEMPTING',?,1)
  `,[intentId,simulationId,senderEntityId,asamiEntityId,simulationTime]);
  const attemptId=uuid();
  await pool.query(`
    INSERT INTO communication_attempts
      (id,simulation_id,intent_id,attempted_simulation_at,status,result)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'STARTED',NULL)
  `,[attemptId,simulationId,intentId,simulationTime]);

  const userMessageId=uuid();
  await pool.query(`
    INSERT INTO messages(id,simulation_id,conversation_id,sender_entity_id,message_type,content,simulation_created_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'USER',?,?,'DELIVERED',?,1)
  `,[userMessageId,simulationId,cid,senderEntityId,content,simulationTime,JSON.stringify({source:"frontend"})]);
  hub.publish(simulationId,"message.created",{id:userMessageId,conversationId:cid,senderEntityId,type:"USER",content});

  await pool.query(`
    UPDATE communication_attempts SET status='DELIVERED',result=?
    WHERE id=UUID_TO_BIN(?) AND status='STARTED'
  `,[JSON.stringify({messageId:userMessageId}),attemptId]);
  const memories=await recallContext(simulationId,asamiEntityId,8);
  const traits=await getTraits(asamiEntityId);
  let generated=gemini?.client ? await gemini.dialogue({
    entityId:asamiEntityId,memoryContext:memories,traits,userMessage:content
  }) : null;
  const reply=generated?.reply || deterministicReply(content);
  const aiMeta=generated
    ? {cognitive:true,emotionalTone:generated.emotionalTone,rememberedReferences:generated.rememberedReferences}
    : {cognitive:false,fallback:true};

  const assistantId=uuid();
  await pool.query(`
    INSERT INTO messages(id,simulation_id,conversation_id,sender_entity_id,message_type,content,simulation_created_at,status,metadata,version)
    VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'ASSISTANT',?,?,'DELIVERED',?,1)
  `,[assistantId,simulationId,cid,asamiEntityId,reply,simulationTime,JSON.stringify(aiMeta)]);
  await pool.query(`UPDATE communication_intents SET status='SENT',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ATTEMPTING'`,[intentId]);
  await createMemory({
    simulationId,entityId:asamiEntityId,content:`Conversation: user said "${content}". I replied "${reply}"`,
    importance:0.65,strength:0.95,confidence:generated?0.9:0.6,emotionalIntensity:0.25,
    simulationAt:simulationTime,metadata:{kind:"conversation",conversationId:cid}
  });
  hub.publish(simulationId,"message.created",{id:assistantId,conversationId:cid,senderEntityId:asamiEntityId,type:"ASSISTANT",content:reply});
  return {conversationId:cid,userMessageId,assistantMessageId:assistantId,reply,aiUsed:Boolean(generated)};
}

function deterministicReply(content){
  const x=content.toLowerCase();
  if(/\bciao|hey|salve\b/.test(x)) return "Ciao. Ti ascolto.";
  if(x.includes("come stai")) return "Sto bene, per quanto possa dirlo attraverso ciò che sto vivendo e ricordando.";
  if(x.includes("cosa stai facendo")) return "Sto seguendo ciò che in questo momento considero più importante per i miei bisogni e i miei obiettivi.";
  return "Ho ricevuto quello che mi hai detto. Lo terrò in considerazione nelle prossime esperienze.";
}
module.exports={sendMessage};
