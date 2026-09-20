const logger=require("./lib/logger");
const { env }=require("./config/env");
require("./services/runtime-enhancements").install();
require("./services/memory-normalization-bootstrap").install();
require("./services/behavioral-policy-bootstrap").install();
require("./services/behavioral-integrity-bootstrap").install();
require("./services/development-duration-bootstrap").install();
require("./services/decision-sql-compat-bootstrap").install();
require("./services/action-runtime-bootstrap").install();
require("./services/behavior-fix-bootstrap").install();
const { ensureDatabaseWithRetry }=require("./db/database-init");
const { pingWithRetry,close }=require("./db/pool");
const { ensurePlanningStatusMigrations }=require("./db/schema-migrations");
const { bootstrapCoreDefinitions }=require("./services/bootstrap-service");
const { GeminiService }=require("./ai/gemini");
const { RealtimeHub }=require("./realtime/hub");
const cognitiveV2=require("./services/cognitive-v2-bootstrap");
const cognitiveV3=require("./services/cognitive-v3-bootstrap");

async function main(){
  await ensureDatabaseWithRetry();
  await pingWithRetry({ attempts: env.DB_STARTUP_RETRY_ATTEMPTS });
  const planningMigration = await ensurePlanningStatusMigrations();
  if (planningMigration.changed.length) {
    logger.info({ changed: planningMigration.changed }, "planning status schema migrations applied");
  }
  const staleTicks=await require("./repositories/simulation-repo").reconcileStaleRunningTicks();
  if(staleTicks) logger.warn({staleTicks},"stale simulation ticks reconciled at startup");
  await bootstrapCoreDefinitions();
  const gemini=new GeminiService(); await gemini.init();
  await cognitiveV2.install({gemini});
  await cognitiveV3.install();
  const { SimulationEngine }=require("./simulation/engine");
  const engine=new SimulationEngine({gemini,hub:new RealtimeHub()});
  await engine.start();
  logger.info("Asami simulation worker started");
  let shuttingDown=false;
  const shutdown=async(signal)=>{if(shuttingDown)return;shuttingDown=true;logger.info({signal},"worker shutdown started");try{await engine.stop({drainTimeoutMs:5000});await close();process.exit(0);}catch(err){logger.error({err,signal},"worker shutdown failed");try{await close();}catch{}process.exit(1);}};
  process.once("SIGINT",()=>shutdown("SIGINT"));process.once("SIGTERM",()=>shutdown("SIGTERM"));
}
main().catch(err=>{logger.fatal({err},"worker startup failed");process.exit(1);});
