const logger=require("./lib/logger");
const { ensureDatabase }=require("./db/database-init");
const { ping,close }=require("./db/pool");
const { GeminiService }=require("./ai/gemini");
const { RealtimeHub }=require("./realtime/hub");
const { SimulationEngine }=require("./simulation/engine");

async function main(){
  await ensureDatabase();
  await ping();
  const gemini=new GeminiService(); await gemini.init();
  const engine=new SimulationEngine({gemini,hub:new RealtimeHub()});
  await engine.start();
  logger.info("Asami simulation worker started");
  const shutdown=async()=>{await engine.stop();await close();process.exit(0);};
  process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
}
main().catch(err=>{logger.fatal({err},"worker startup failed");process.exit(1);});
