const { pool } = require("../db/pool");
const logger = require("../lib/logger");

const CHECK_INTERVAL_HOURS=6;
const lastCheckSimulationAt=new Map();

function parseSimulationMs(value){
  const ms=new Date(value).getTime();
  return Number.isFinite(ms)?ms:null;
}

async function runSimulationIntegrityCheck(simulationId,simulationTime,{force=false}={}) {
  if(!simulationId)return{skipped:true,reason:"missing_simulation"};
  const now=parseSimulationMs(simulationTime);
  const last=lastCheckSimulationAt.get(simulationId);
  if(!force&&now!==null&&last!==undefined&&now-last<CHECK_INTERVAL_HOURS*3600000){
    return{skipped:true,reason:"interval"};
  }
  const checks=[
    {
      name:"actions_decision_scope",
      sql:`SELECT COUNT(*) AS count
           FROM actions a
           JOIN decisions d ON d.id=a.decision_id
           WHERE a.simulation_id=UUID_TO_BIN(?)
             AND (d.simulation_id<>a.simulation_id OR d.entity_id<>a.entity_id)`
    },
    {
      name:"actions_goal_scope",
      sql:`SELECT COUNT(*) AS count
           FROM actions a
           JOIN goals g ON g.id=a.source_goal_id
           WHERE a.simulation_id=UUID_TO_BIN(?)
             AND (g.entity_id<>a.entity_id)`
    },
    {
      name:"plans_goal_scope",
      sql:`SELECT COUNT(*) AS count
           FROM plans p
           JOIN goals g ON g.id=p.goal_id
           WHERE p.simulation_id=UUID_TO_BIN(?)
             AND p.entity_id<>g.entity_id`
    },
    {
      name:"decisions_selected_option",
      sql:`SELECT COUNT(*) AS count
           FROM decisions d
           LEFT JOIN decision_options o ON o.id=d.selected_option_id
           WHERE d.simulation_id=UUID_TO_BIN(?)
             AND d.selected_option_id IS NOT NULL
             AND o.id IS NULL`
    },
    {
      name:"events_source_action_scope",
      sql:`SELECT COUNT(*) AS count
           FROM events e
           JOIN actions a ON a.id=e.source_action_id
           WHERE e.simulation_id=UUID_TO_BIN(?)
             AND (a.simulation_id<>e.simulation_id)`
    },
    {
      name:"memories_source_event_scope",
      sql:`SELECT COUNT(*) AS count
           FROM memories m
           JOIN events e ON e.id=m.source_event_id
           WHERE e.simulation_id=UUID_TO_BIN(?)
             AND EXISTS(
               SELECT 1 FROM entities me
               WHERE me.id=m.entity_id
                 AND me.simulation_id<>e.simulation_id
             )`
    }
  ];

  const violations=[];
  for(const check of checks){
    const [rows]=await pool.query(check.sql,[simulationId]);
    const count=Number(rows[0]?.count||0);
    if(count)violations.push({check:check.name,count});
  }

  if(now!==null)lastCheckSimulationAt.set(simulationId,now);
  const result={
    simulationId,
    simulationTime,
    checkedAt:new Date().toISOString(),
    violations,
    healthy:violations.length===0
  };
  if(violations.length){
    logger.error(result,"simulation integrity violations detected");
  }else{
    logger.debug(result,"simulation integrity check passed");
  }
  return result;
}

module.exports={runSimulationIntegrityCheck,CHECK_INTERVAL_HOURS};
