const express = require("express");
const simRepo = require("../repositories/simulation-repo");
const entityRepo = require("../repositories/entity-repo");
const { listEvents,listTimeline } = require("../services/event-service");
const { listMemories } = require("../services/memory-service");
const { getRelationships } = require("../services/relationship-service");
const { getDevelopment,getDevelopmentHistory } = require("../services/development-service");
const { analyzeSimulation } = require("../services/analysis-service");
const { sendMessage } = require("../services/chat-service");
const { getUsage } = require("../services/gemini-budget-service");
const { simulationCreate, speed, message, uuid, queryLimit } = require("./validation");
const { runIdempotent } = require("../services/idempotency-service");
const { env } = require("../config/env");

function buildRouter({hub,gemini}){
  const router=express.Router();

  router.get("/health",async(req,res)=>res.json({ok:true,service:"asami-backend",engineVersion:env.ENGINE_VERSION}));
  router.get("/simulations",async(req,res)=>res.json(await simRepo.listSimulations()));
  router.get("/gemini/usage",async(req,res)=>res.json(await getUsage()));

  router.post("/simulations",async(req,res)=>{
    const body=simulationCreate.parse(req.body);
    const result=await simRepo.createSimulation(body);
    hub.publish(result.simulation.id,"simulation.status",{status:"RUNNING",asamiEntityId:result.asamiEntityId});
    res.status(201).json(result);
  });

  router.get("/simulations/:simulationId/clock",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId);
    const sim=await simRepo.getSimulation(simulationId);
    if(!sim)return res.status(404).json({error:"Simulation not found"});
    const clock=await simRepo.getActiveClock(simulationId);
    res.json({simulation:sim,clock});
  });

  router.get("/simulations/:simulationId",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const sim=await simRepo.getSimulation(id);
    if(!sim)return res.status(404).json({error:"Simulation not found"});
    res.json(sim);
  });

  router.post("/simulations/:simulationId/pause",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const op=req.header("Idempotency-Key")||`pause:${Date.now()}`;
    const result=await runIdempotent(id,op,"PAUSE",()=>simRepo.setStatus(id,"PAUSED"));
    hub.publish(id,"simulation.status",{status:"PAUSED"});
    res.json(result);
  });
  router.post("/simulations/:simulationId/resume",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const op=req.header("Idempotency-Key")||`resume:${Date.now()}`;
    const result=await runIdempotent(id,op,"RESUME",()=>simRepo.setStatus(id,"RUNNING"));
    hub.publish(id,"simulation.status",{status:"RUNNING"});
    res.json(result);
  });
  router.post("/simulations/:simulationId/stop",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const op=req.header("Idempotency-Key")||`stop:${Date.now()}`;
    const result=await runIdempotent(id,op,"STOP",()=>simRepo.setStatus(id,"STOPPED"));
    hub.publish(id,"simulation.status",{status:"STOPPED"});
    res.json(result);
  });
  router.post("/simulations/:simulationId/speed",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const body=speed.parse(req.body);
    const sim=await simRepo.getSimulation(id);
    if(!sim)return res.status(404).json({error:"Simulation not found"});
    const op=req.header("Idempotency-Key")||`speed:${body.speed}:${Date.now()}`;
    const result=await runIdempotent(id,op,"CHANGE_SPEED",async()=>{
      const clock=await simRepo.getActiveClock(id);
      if(!clock){
        throw Object.assign(new Error("Simulation has no active clock; resume the simulation before changing its speed"),{
          code:"CLOCK_NOT_ACTIVE",
          statusCode:409
        });
      }
      let at = computeCurrentSimulationTime(clock);
      const anchor = new Date(clock.simulationAnchorAt);
      if (at < anchor) at = anchor;
      return simRepo.changeSpeed(id, body.speed, at);
    });
    hub.publish(id,"simulation.speed",{speed:body.speed});
    res.json(result);
  });

  router.get("/simulations/:simulationId/asami",async(req,res)=>{
    const id=uuid.parse(req.params.simulationId);
    const entity=await entityRepo.getAsamiCandidate(id,req.query.entityId?uuid.parse(req.query.entityId):null);
    if(!entity)return res.status(404).json({error:"Asami entity not found"});
    res.json(entity);
  });

  router.get("/simulations/:simulationId/dashboard/:entityId",async(req,res)=>{
    const dashboard=await entityRepo.getDashboard(uuid.parse(req.params.simulationId),uuid.parse(req.params.entityId));
    if(!dashboard)return res.status(404).json({error:"Entity not found"});
    res.json(dashboard);
  });
  router.get("/simulations/:simulationId/analysis",async(req,res)=>{
    res.json(await analyzeSimulation(uuid.parse(req.params.simulationId),{from:req.query.from,to:req.query.to}));
  });
  router.get("/simulations/:simulationId/timeline",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId);
    const entityId=req.query.entityId
      ? uuid.parse(req.query.entityId)
      : (await entityRepo.getAsamiCandidate(simulationId))?.id;
    if(!entityId)return res.status(404).json({error:"No entity available for timeline"});
    const limit=queryLimit(200).parse(req.query.limit);
    res.json(await listTimeline(simulationId,entityId,limit));
  });
  router.get("/simulations/:simulationId/events",async(req,res)=>{
    res.json(await listEvents(uuid.parse(req.params.simulationId),{
      from:req.query.from,to:req.query.to,limit:queryLimit(100).parse(req.query.limit)
    }));
  });
  router.get("/simulations/:simulationId/actions",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId);
    const params=[simulationId]; let where="simulation_id=UUID_TO_BIN(?)";
    if(req.query.entityId){where+=" AND entity_id=UUID_TO_BIN(?)";params.push(uuid.parse(req.query.entityId));}
    params.push(queryLimit(100).parse(req.query.limit));
    const [rows]=await require("../db/pool").pool.query(`
      SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(entity_id) AS entityId,action_type AS actionType,
             source_type AS sourceType,status,started_simulation_at AS startedAt,
             completed_simulation_at AS completedAt,target,parameters,result
      FROM actions WHERE ${where} ORDER BY started_simulation_at DESC LIMIT ?`,params);
    res.json(rows);
  });
  router.get("/simulations/:simulationId/memories/:entityId",async(req,res)=>{
    res.json(await listMemories(uuid.parse(req.params.simulationId),uuid.parse(req.params.entityId),queryLimit(100).parse(req.query.limit)));
  });
  router.get("/simulations/:simulationId/relationships/:entityId",async(req,res)=>{
    res.json(await getRelationships(uuid.parse(req.params.simulationId),uuid.parse(req.params.entityId)));
  });
  router.get("/simulations/:simulationId/development/:entityId",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId),entityId=uuid.parse(req.params.entityId);
    res.json({current:await getDevelopment(simulationId,entityId),history:await getDevelopmentHistory(entityId,100)});
  });

  router.get("/simulations/:simulationId/conversations/:conversationId/messages",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId),conversationId=uuid.parse(req.params.conversationId);
    const [rows]=await require("../db/pool").pool.query(`
      SELECT BIN_TO_UUID(m.id) AS id,BIN_TO_UUID(m.sender_entity_id) AS senderEntityId,
             m.message_type AS messageType,m.content,m.simulation_created_at AS simulationAt,
             m.status,m.metadata
      FROM messages m
      WHERE m.simulation_id=UUID_TO_BIN(?) AND m.conversation_id=UUID_TO_BIN(?)
      ORDER BY m.simulation_created_at ASC
    `,[simulationId,conversationId]);
    res.json(rows);
  });

  router.post("/simulations/:simulationId/conversations/messages",async(req,res)=>{
    const simulationId=uuid.parse(req.params.simulationId);
    const body=message.parse(req.body);
    const sim=await simRepo.getSimulation(simulationId);
    if(!sim)return res.status(404).json({error:"Simulation not found"});
    const asami=await entityRepo.getAsamiCandidate(simulationId,body.asamiEntityId||null);
    if(!asami)return res.status(404).json({error:"Asami entity not found"});
    const sender=await entityRepo.getEntity(simulationId,body.senderEntityId);
    if(!sender)return res.status(400).json({error:"senderEntityId is not an entity in this simulation"});
    if(sender.id===asami.id)return res.status(400).json({error:"senderEntityId must be different from Asami"});
    const result=await sendMessage({
      simulationId,senderEntityId:sender.id,asamiEntityId:asami.id,
      conversationId:body.conversationId,content:body.content,
      simulationTime:sim.currentSimulationAt,gemini,hub
    });
    res.status(201).json(result);
  });

  router.post("/simulations/:simulationId/observer", async (req, res) => {
    const simulationId = uuid.parse(req.params.simulationId);
    const observer = await entityRepo.ensureObserver(simulationId);
    res.json(observer);
  });

  return router;
}

function computeCurrentSimulationTime(clock){
  if(!clock)return new Date();
  return new Date(new Date(clock.simulationAnchorAt).getTime()+
    (Date.now()-new Date(clock.realAnchorAt).getTime())*Number(clock.speed));
}
module.exports={buildRouter};
