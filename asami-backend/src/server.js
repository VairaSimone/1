const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");
require("./services/runtime-enhancements").install();
require("./services/memory-normalization-bootstrap").install();
require("./services/behavioral-policy-bootstrap").install();
require("./services/behavioral-integrity-bootstrap").install();
require("./services/development-duration-bootstrap").install();
require("./services/decision-sql-compat-bootstrap").install();
require("./services/action-runtime-bootstrap").install();
require("./services/behavior-fix-bootstrap").install();
require("./services/cognitive-causal-api-guard").install();
const { env } = require("./config/env");
const logger = require("./lib/logger");
const { ensureDatabase } = require("./db/database-init");
const { ping, close } = require("./db/pool");
const { bootstrapCoreDefinitions } = require("./services/bootstrap-service");
const { buildCognitiveRouter } = require("./services/cognitive-v2-router");
const cognitiveV2 = require("./services/cognitive-v2-bootstrap");
const cognitiveV3 = require("./services/cognitive-v3-bootstrap");
const { RealtimeHub } = require("./realtime/hub");
const { GeminiService } = require("./ai/gemini");
const { buildRouter } = require("./api/routes");
const { errorHandler } = require("./api/error-handler");

async function main(){
  await ensureDatabase();
  await ping();
  await bootstrapCoreDefinitions();
  const gemini=new GeminiService();
  await gemini.init();
  await cognitiveV2.install({gemini});
  await cognitiveV3.install();
  const { SimulationEngine } = require("./simulation/engine");
  const hub=new RealtimeHub();
  const app=express();
  app.disable("x-powered-by");
  app.use(express.json({limit:"1mb"}));
  app.use((req,res,next)=>{
    req.id=req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("X-Request-Id",req.id);
    next();
  });
  app.use((req,res,next)=>{
    res.header("Access-Control-Allow-Origin",env.CORS_ORIGIN);
    res.header("Access-Control-Allow-Headers","Content-Type,Idempotency-Key,X-Request-Id");
    res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    if(req.method==="OPTIONS")return res.sendStatus(204);
    next();
  });
  app.use("/api",buildRouter({hub,gemini}));
  app.use("/api",buildCognitiveRouter());
  app.use(errorHandler);

  const server=http.createServer(app);
  const wss=new WebSocketServer({noServer:true});
  server.on("upgrade",(req,socket,head)=>{
    try{
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(url.pathname!=="/realtime") return socket.destroy();
      const simulationId=url.searchParams.get("simulationId");
      if(!simulationId)return socket.destroy();
      wss.handleUpgrade(req,socket,head,ws=>{
        hub.attach(ws,simulationId);
        ws.send(JSON.stringify({type:"connected",simulationId,occurredAt:new Date().toISOString()}));
      });
    }catch{socket.destroy();}
  });

  const engine=new SimulationEngine({gemini,hub});
  await engine.start();
  server.listen(env.PORT,env.HOST,()=>logger.info({port:env.PORT,host:env.HOST},"Asami backend listening"));

  let shuttingDown=false;
  const shutdown=async(signal)=>{
    if(shuttingDown)return;
    shuttingDown=true;
    logger.info({signal},"shutdown started");
    try{
      await engine.stop({drainTimeoutMs:5000});
      await new Promise(resolve=>server.close(resolve));
      wss.close();
      await close();
      process.exit(0);
    }catch(err){
      logger.error(logger.contextError({signal,phase:"shutdown"},err,"shutdown failed"));
      try{await close();}catch{}
      process.exit(1);
    }
  };
  process.once("SIGINT",()=>shutdown("SIGINT"));
  process.once("SIGTERM",()=>shutdown("SIGTERM"));
}

main().catch(err=>{logger.fatal(logger.contextError({phase:"startup"},err,"startup failed"));process.exit(1);});