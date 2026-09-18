const { pool } = require('../db/pool');
const logger = require('../lib/logger');
const { uuid } = require('../lib/ids');

let installed = false;

const SQL = [
  `CREATE TABLE IF NOT EXISTS self_models (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,identity_summary VARCHAR(500) NOT NULL,self_concept VARCHAR(1000) NOT NULL,capabilities JSON NULL,aspirations JSON NULL,limitations JSON NULL,current_self_view VARCHAR(1000) NULL,version BIGINT NOT NULL DEFAULT 1,created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,UNIQUE KEY uq_self_models_entity (simulation_id,entity_id),KEY idx_self_models_entity (entity_id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS identity_values (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,code VARCHAR(80) NOT NULL,label VARCHAR(120) NOT NULL,importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,confidence DECIMAL(6,5) NOT NULL DEFAULT 0.5,origin VARCHAR(40) NOT NULL DEFAULT 'INITIAL',salience DECIMAL(6,5) NOT NULL DEFAULT 0.5,version BIGINT NOT NULL DEFAULT 1,created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,UNIQUE KEY uq_identity_value (simulation_id,entity_id,code)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS self_beliefs (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,belief_key VARCHAR(80) NOT NULL,statement VARCHAR(500) NOT NULL,confidence DECIMAL(6,5) NOT NULL DEFAULT 0.5,importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,source_type VARCHAR(60) NOT NULL DEFAULT 'EXPERIENCE',source_ref BINARY(16) NULL,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_self_belief (simulation_id,entity_id,belief_key)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS long_term_desires (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,desire_key VARCHAR(100) NOT NULL,title VARCHAR(255) NOT NULL,description VARCHAR(1000) NULL,desire_type VARCHAR(60) NOT NULL,priority DECIMAL(6,5) NOT NULL DEFAULT 0.5,persistence DECIMAL(6,5) NOT NULL DEFAULT 0.5,progress DECIMAL(6,5) NOT NULL DEFAULT 0,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',origin VARCHAR(60) NOT NULL DEFAULT 'EXPERIENCE',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_long_term_desire (simulation_id,entity_id,desire_key),KEY idx_long_term_desire_active (simulation_id,entity_id,status,priority)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS life_narratives (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,chapter_index INT NOT NULL,title VARCHAR(180) NOT NULL,summary TEXT NOT NULL,importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,event_id BINARY(16) NULL,created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_life_narrative (simulation_id,entity_id,chapter_index)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cognitive_states (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,simulation_time DATETIME(3) NOT NULL,attention JSON NOT NULL,interpretation JSON NOT NULL,conflicts JSON NOT NULL,created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),KEY idx_cognitive_states_latest (simulation_id,entity_id,simulation_time)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cognitive_conflicts (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,fingerprint VARCHAR(255) NOT NULL,left_driver JSON NOT NULL,right_driver JSON NOT NULL,intensity DECIMAL(6,5) NOT NULL DEFAULT 0,resolution JSON NULL,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_cognitive_conflict (simulation_id,entity_id,fingerprint),KEY idx_cognitive_conflict_active (simulation_id,entity_id,status,intensity)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cognitive_expectations (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,decision_id BINARY(16) NOT NULL,action_type VARCHAR(100) NOT NULL,expected_utility DECIMAL(8,5) NOT NULL DEFAULT 0.5,expected_success_probability DECIMAL(8,5) NOT NULL DEFAULT 0.5,prediction JSON NULL,actual_outcome JSON NULL,prediction_error DECIMAL(8,5) NULL,regret_score DECIMAL(8,5) NULL,status VARCHAR(20) NOT NULL DEFAULT 'OPEN',created_simulation_at DATETIME(3) NOT NULL,resolved_simulation_at DATETIME(3) NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_expectations_open (simulation_id,entity_id,status,created_simulation_at),KEY idx_expectations_decision (decision_id)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS counterfactuals (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,decision_id BINARY(16) NOT NULL,alternative_action VARCHAR(100) NOT NULL,predicted_outcome JSON NOT NULL,predicted_utility DECIMAL(8,5) NOT NULL DEFAULT 0,regret_score DECIMAL(8,5) NOT NULL DEFAULT 0,created_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_counterfactual_decision (decision_id),KEY idx_counterfactual_entity (simulation_id,entity_id,created_simulation_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS social_groups (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,name VARCHAR(180) NOT NULL,group_type VARCHAR(60) NOT NULL DEFAULT 'COMMUNITY',description VARCHAR(1000) NULL,reputation_importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_social_group (simulation_id,name)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS social_group_members (group_id BINARY(16) NOT NULL,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,role VARCHAR(80) NULL,status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',joined_simulation_at DATETIME(3) NOT NULL,left_simulation_at DATETIME(3) NULL,PRIMARY KEY (group_id,entity_id),KEY idx_group_members_entity (simulation_id,entity_id,status)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS reputations (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,subject_entity_id BINARY(16) NOT NULL,observer_entity_id BINARY(16) NULL,group_id BINARY(16) NULL,score DECIMAL(6,5) NOT NULL DEFAULT 0.5,reliability DECIMAL(6,5) NOT NULL DEFAULT 0.3,context VARCHAR(80) NOT NULL DEFAULT 'GROUP',status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_reputation_observer_context (simulation_id,subject_entity_id,observer_entity_id,context),KEY idx_reputation_subject (simulation_id,subject_entity_id,score)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS social_obligations (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,entity_id BINARY(16) NOT NULL,title VARCHAR(180) NOT NULL,description VARCHAR(1000) NULL,type VARCHAR(60) NOT NULL,priority DECIMAL(6,5) NOT NULL DEFAULT 0.5,due_simulation_at DATETIME(3) NULL,status VARCHAR(20) NOT NULL DEFAULT 'OPEN',created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_social_obligation_entity (simulation_id,entity_id,status,priority)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS promises (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,issuer_entity_id BINARY(16) NOT NULL,title VARCHAR(180) NOT NULL,description VARCHAR(1000) NULL,target_entity_id BINARY(16) NULL,due_simulation_at DATETIME(3) NULL,status VARCHAR(20) NOT NULL DEFAULT 'OPEN',importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,source_message_id BINARY(16) NULL,created_simulation_at DATETIME(3) NOT NULL,updated_simulation_at DATETIME(3) NOT NULL,version BIGINT NOT NULL DEFAULT 1,KEY idx_promises_issuer (simulation_id,issuer_entity_id,status,importance),KEY idx_promises_due (simulation_id,due_simulation_at,status)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS social_norms (id BINARY(16) NOT NULL PRIMARY KEY,simulation_id BINARY(16) NOT NULL,code VARCHAR(80) NOT NULL,title VARCHAR(180) NOT NULL,description VARCHAR(500) NULL,importance DECIMAL(6,5) NOT NULL DEFAULT 0.5,violation_cost DECIMAL(6,5) NOT NULL DEFAULT 0.2,active TINYINT(1) NOT NULL DEFAULT 1,version BIGINT NOT NULL DEFAULT 1,UNIQUE KEY uq_social_norm (simulation_id,code)) ENGINE=InnoDB`,
];

const NORMS = [
  ['KEEP_PROMISES','Keep promises','A commitment should normally be respected unless a stronger reason makes it impossible.',0.86,0.55],
  ['HONESTY','Honesty','Avoid deliberately misleading people when there is no compelling reason to do so.',0.78,0.42],
  ['RESPECT_BOUNDARIES','Respect boundaries','Respect another person’s space, consent and stated limits.',0.84,0.52],
  ['RECIPROCITY','Reciprocity','Meaningful relationships benefit from balanced care and cooperation.',0.66,0.30],
];
const WORLD2_ACTIVITIES = [
  ['COOKING','Cooking','PRACTICAL'],['DRAWING','Drawing','CREATIVE'],['WRITING','Writing','CREATIVE'],['LISTENING_MUSIC','Listening to music','LEISURE'],['USING_DEVICE','Using a device','LEISURE'],['CLEANING','Cleaning','PRACTICAL'],['BATHING','Bathing','BIOLOGICAL'],['CREATING','Creating','CREATIVE'],['SHOPPING','Shopping','PRACTICAL'],['HELPING','Helping','SOCIAL'],['TEACHING','Teaching','EDUCATION'],['LEARNING','Learning','EDUCATION'],['ARGUING','Arguing','SOCIAL'],['APOLOGIZING','Apologizing','SOCIAL'],['GIVING','Giving','SOCIAL'],['RECEIVING','Receiving','SOCIAL'],['ATTENDING_EVENT','Attending an event','SOCIAL'],
];

async function ensureNormsForSimulation(simulationId, db = pool) {
  if (!simulationId) return 0;
  for (const [code,title,description,importance,violationCost] of NORMS) {
    await db.query(
      `INSERT INTO social_norms
        (id,simulation_id,code,title,description,importance,violation_cost,active,version)
       VALUES(UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,1,1)
       ON DUPLICATE KEY UPDATE
         title=VALUES(title),
         description=VALUES(description),
         importance=VALUES(importance),
         violation_cost=VALUES(violation_cost),
         active=1`,
      [uuid(),simulationId,code,title,description,importance,violationCost]
    );
  }
  return NORMS.length;
}

async function ensureNorms() {
  const [simulations] = await pool.query(`SELECT BIN_TO_UUID(id) AS id FROM simulations`);
  for (const sim of simulations) await ensureNormsForSimulation(sim.id);
}

async function ensureWorld2Activities() {
  for (let i=0;i<WORLD2_ACTIVITIES.length;i+=1) {
    const [code,name,category]=WORLD2_ACTIVITIES[i];
    const id=`00000000-0000-4010-8005-${String(i+1).padStart(12,'0')}`;
    await pool.query(`INSERT INTO activity_types(id,code,name,category,parameters,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),active=1`,[id,code,name,category]);
  }
}

function install() {
  if (installed) return;
  installed = true;
  return (async () => {
    const started=Date.now();
    for (const statement of SQL) await pool.query(statement);
    await ensureNorms();
    await ensureWorld2Activities();
    logger.info({durationMs:Date.now()-started},'Cognitive v2 schema ready');
  })().catch(err=>{installed=false;logger.error(logger.contextError({phase:'cognitive-v2-schema'},err,'Cognitive v2 schema migration failed'));throw err;});
}

module.exports={install,ensureNormsForSimulation};
