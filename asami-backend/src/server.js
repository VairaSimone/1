const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { env } = require("./config/env");
const logger = require("./lib/logger");
const { ping, close } = require("./db/pool");
const { RealtimeHub } = require("./realtime/hub");
const { GeminiService } = require("./ai/gemini");
const { SimulationEngine } = require("./simulation/engine");
const { buildRouter } = require("./api/routes");
const { errorHandler } = require("./api/error-handler");

async function main(){
  await ping();
  const gemini=new GeminiService();
  await gemini.init();
  const hub=new RealtimeHub();
  const app=express();
  app.disable("x-powered-by");
  app.use(express.json({limit:"1mb"}));
  app.use((req,res,next)=>{
    res.header("Access-Control-Allow-Origin",env.CORS_ORIGIN);
    res.header("Access-Control-Allow-Headers","Content-Type,Idempotency-Key");
    res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    if(req.method==="OPTIONS")return res.sendStatus(204);
    next();
  });
  app.use("/api",buildRouter({hub,gemini}));
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

  const shutdown=async(signal)=>{
    logger.info({signal},"shutdown started");
    await engine.stop();
    await new Promise(resolve=>server.close(resolve));
    wss.close();
    await close();
    process.exit(0);
  };
  process.once("SIGINT",()=>shutdown("SIGINT"));
  process.once("SIGTERM",()=>shutdown("SIGTERM"));
}

main().catch(err=>{logger.fatal({err},"startup failed");process.exit(1);});
