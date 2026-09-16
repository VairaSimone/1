const { pool } = require("../db/pool");
const logger = require("../lib/logger");

const ENTITY_TYPES = [
  ["00000000-0000-4000-8000-000000000001","PERSON","Person","ACTOR"],
  ["00000000-0000-4000-8000-000000000002","ANIMAL","Animal","ACTOR"],
  ["00000000-0000-4000-8000-000000000003","LOCATION","Location","WORLD"],
  ["00000000-0000-4000-8000-000000000004","OBJECT","Object","WORLD"],
  ["00000000-0000-4000-8000-000000000005","ORGANIZATION","Organization","SOCIAL"]
];
const NEEDS = [
  ["00000000-0000-4000-8001-000000000001","HUNGER","Hunger",0,1,0,0.08,0.5,1],
  ["00000000-0000-4000-8001-000000000002","THIRST","Thirst",0,1,0,0.12,0.6,1.1],
  ["00000000-0000-4000-8001-000000000003","SLEEPINESS","Sleepiness",0,1,0,0.06,0.7,1.1],
  ["00000000-0000-4000-8001-000000000004","ENERGY","Energy",0,1,1,0.05,0.6,1],
  ["00000000-0000-4000-8001-000000000005","SOCIAL_NEED","Social Need",0,1,0.3,0.03,0.3,0.7],
  ["00000000-0000-4000-8001-000000000006","FUN","Fun",0,1,0.5,0.04,0.4,0.6],
  ["00000000-0000-4000-8001-000000000007","COMFORT","Comfort",0,1,0.6,0.02,0.2,0.5],
  ["00000000-0000-4000-8001-000000000008","SAFETY","Safety",0,1,1,0.02,0.5,1.2],
  ["00000000-0000-4000-8001-000000000009","CURIOSITY","Curiosity Drive",0,1,0.3,0.025,0.2,0.7],
  ["00000000-0000-4000-8001-000000000010","ACHIEVEMENT","Achievement",0,1,0.3,0.02,0.2,0.6],
  ["00000000-0000-4000-8001-000000000011","BELONGING","Belonging",0,1,0.4,0.025,0.25,0.9]
];
const EMOTIONS = [
  ["00000000-0000-4000-8002-000000000001","JOY","Joy",0.18],
  ["00000000-0000-4000-8002-000000000002","SADNESS","Sadness",0.12],
  ["00000000-0000-4000-8002-000000000003","ANGER","Anger",0.22],
  ["00000000-0000-4000-8002-000000000004","FEAR","Fear",0.16],
  ["00000000-0000-4000-8002-000000000005","ANXIETY","Anxiety",0.08],
  ["00000000-0000-4000-8002-000000000006","FRUSTRATION","Frustration",0.20],
  ["00000000-0000-4000-8002-000000000007","EXCITEMENT","Excitement",0.25],
  ["00000000-0000-4000-8002-000000000008","CALM","Calm",0.10],
  ["00000000-0000-4000-8002-000000000009","DISGUST","Disgust",0.15],
  ["00000000-0000-4000-8002-000000000010","SHAME","Shame",0.10]
];
const TRAITS = [
  ["00000000-0000-4000-8003-000000000001","OPENNESS","Openness",0.08,1],
  ["00000000-0000-4000-8003-000000000002","CONSCIENTIOUSNESS","Conscientiousness",0.08,1.1],
  ["00000000-0000-4000-8003-000000000003","EXTRAVERSION","Extraversion",0.08,0.9],
  ["00000000-0000-4000-8003-000000000004","AGREEABLENESS","Agreeableness",0.08,1],
  ["00000000-0000-4000-8003-000000000005","NEUROTICISM","Neuroticism",0.08,0.9],
  ["00000000-0000-4000-8003-000000000006","CURIOSITY","Curiosity",0.12,1.2],
  ["00000000-0000-4000-8003-000000000007","IMPULSIVITY","Impulsivity",0.10,0.9],
  ["00000000-0000-4000-8003-000000000008","EMPATHY","Empathy",0.08,1.1],
  ["00000000-0000-4000-8003-000000000009","CONFIDENCE","Confidence",0.12,1],
  ["00000000-0000-4000-8003-000000000010","PATIENCE","Patience",0.08,0.9],
  ["00000000-0000-4000-8003-000000000011","AGGRESSIVENESS","Aggressiveness",0.09,0.9],
  ["00000000-0000-4000-8003-000000000012","RISK_TAKING","Risk Taking",0.10,0.9],
  ["00000000-0000-4000-8003-000000000013","SOCIABILITY","Sociability",0.09,0.9],
  ["00000000-0000-4000-8003-000000000014","INDEPENDENCE","Independence",0.10,1],
  ["00000000-0000-4000-8003-000000000015","DISCIPLINE","Discipline",0.08,1],
  ["00000000-0000-4000-8003-000000000016","CREATIVITY","Creativity",0.10,1.1]
];
const SKILLS = [
  ["00000000-0000-4000-8004-000000000001","READING","Reading","ACADEMIC"],["00000000-0000-4000-8004-000000000002","WRITING","Writing","ACADEMIC"],["00000000-0000-4000-8004-000000000003","DRAWING","Drawing","CREATIVE"],["00000000-0000-4000-8004-000000000004","COOKING","Cooking","PRACTICAL"],["00000000-0000-4000-8004-000000000005","COMMUNICATION","Communication","SOCIAL"],["00000000-0000-4000-8004-000000000006","PROBLEM_SOLVING","Problem Solving","COGNITIVE"],["00000000-0000-4000-8004-000000000007","MEMORY","Memory","COGNITIVE"],["00000000-0000-4000-8004-000000000008","MATH","Mathematics","ACADEMIC"],["00000000-0000-4000-8004-000000000009","MUSIC","Music","CREATIVE"],["00000000-0000-4000-8004-000000000010","SPORTS","Sports","PHYSICAL"],["00000000-0000-4000-8004-000000000011","SELF_CARE","Self Care","PRACTICAL"],["00000000-0000-4000-8004-000000000012","NAVIGATION","Navigation","PRACTICAL"]
];
const ACTIVITIES=[["SLEEPING","Sleeping","BIOLOGICAL"],["EATING","Eating","BIOLOGICAL"],["DRINKING","Drinking","BIOLOGICAL"],["SCHOOL","School","EDUCATION"],["STUDYING","Studying","EDUCATION"],["PLAYING","Playing","LEISURE"],["WALKING","Walking","MOVEMENT"],["TALKING","Talking","SOCIAL"],["TRAVELLING","Travelling","MOVEMENT"],["WATCHING","Watching","LEISURE"],["READING","Reading","LEISURE"],["WORKING","Working","WORK"],["RESTING","Resting","BIOLOGICAL"],["EXPLORING","Exploring","EXPLORATION"]];
const EVENT_TYPES=[["PERSONAL","Personal Event","PERSONAL"],["SOCIAL","Social Event","SOCIAL"],["FAMILY","Family Event","FAMILY"],["SCHOOL","School Event","SCHOOL"],["ENVIRONMENTAL","Environmental Event","ENVIRONMENTAL"],["RELATIONSHIP","Relationship Event","RELATIONSHIP"],["INTERNAL","Internal Event","INTERNAL"],["RANDOM","Random Event","RANDOM"],["COMMUNICATION","Communication Event","SOCIAL"]];
const RELATIONSHIPS=[["PARENT","Parent",0],["CHILD","Child",0],["SIBLING","Sibling",1],["FRIEND","Friend",1],["ACQUAINTANCE","Acquaintance",1],["TEACHER","Teacher",0],["STUDENT","Student",0],["CAREGIVER","Caregiver",0],["EMPLOYER","Employer",0],["COLLEAGUE","Colleague",1]];
// development_stages stores simulated age in days, so convert human-year boundaries to days.
const DAY_PER_YEAR=365.25;
const DEVELOPMENT_STAGES=[["INFANT","Infant",0,7*DAY_PER_YEAR],["CHILD","Child",7*DAY_PER_YEAR,13*DAY_PER_YEAR],["ADOLESCENT","Adolescent",13*DAY_PER_YEAR,18*DAY_PER_YEAR],["YOUNG_ADULT","Young Adult",18*DAY_PER_YEAR,30*DAY_PER_YEAR],["ADULT","Adult",30*DAY_PER_YEAR,65*DAY_PER_YEAR],["ELDER","Elder",65*DAY_PER_YEAR,null]];

async function ensureEntityTypes(){for(const [id,code,name,category] of ENTITY_TYPES)await pool.query(`INSERT INTO entity_types(id,code,name,category,schema_definition,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),active=1`,[id,code,name,category]);}
async function ensureNeeds(){for(const [id,code,name,min,max,def,decay,recovery,priority] of NEEDS)await pool.query(`INSERT INTO need_definitions(id,code,name,min_value,max_value,default_value,decay_rate,recovery_rate,priority_weight,parameters,active) VALUES(UUID_TO_BIN(?),?,?,?,?,?,?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),min_value=VALUES(min_value),max_value=VALUES(max_value),default_value=VALUES(default_value),decay_rate=VALUES(decay_rate),recovery_rate=VALUES(recovery_rate),priority_weight=VALUES(priority_weight),active=1`,[id,code,name,min,max,def,decay,recovery,priority]);}
async function ensureEmotions(){for(const [id,code,name,defaultValue] of EMOTIONS){const decayRate=defaultValue*0.5;await pool.query(`INSERT INTO emotion_definitions(id,code,name,min_value,max_value,default_value,decay_rate,parameters,active) VALUES(UUID_TO_BIN(?),?,?,0,1,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),min_value=0,max_value=1,default_value=VALUES(default_value),decay_rate=VALUES(decay_rate),active=1`,[id,code,name,defaultValue,decayRate]);}}
async function ensureTraits(){for(const [id,code,name,volatility,developmentWeight] of TRAITS)await pool.query(`INSERT INTO trait_definitions(id,code,name,min_value,max_value,default_value,volatility,decay_rate,development_weight,parameters,active) VALUES(UUID_TO_BIN(?),?,?,0,1,0.5,?,0,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),min_value=0,max_value=1,default_value=0.5,volatility=VALUES(volatility),decay_rate=0,development_weight=VALUES(development_weight),active=1`,[id,code,name,volatility,developmentWeight]);}

async function bootstrapCoreDefinitions(){
  const started=Date.now();
  await ensureEntityTypes(); await ensureNeeds(); await ensureEmotions(); await ensureTraits();
  for(const [id,code,name,category] of SKILLS)await pool.query(`INSERT INTO skill_definitions(id,code,name,category,parameters,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),active=1`,[id,code,name,category]);
  for(let i=0;i<ACTIVITIES.length;i++){const [code,name,category]=ACTIVITIES[i],id=`00000000-0000-4000-8005-${String(i+1).padStart(12,"0")}`;await pool.query(`INSERT INTO activity_types(id,code,name,category,parameters,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),active=1`,[id,code,name,category]);}
  for(let i=0;i<EVENT_TYPES.length;i++){const [code,name,category]=EVENT_TYPES[i],id=`00000000-0000-4000-8006-${String(i+1).padStart(12,"0")}`;await pool.query(`INSERT INTO event_types(id,code,name,category,configuration,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),active=1`,[id,code,name,category]);}
  for(let i=0;i<RELATIONSHIPS.length;i++){const [code,name,symmetric]=RELATIONSHIPS[i],id=`00000000-0000-4000-8007-${String(i+1).padStart(12,"0")}`;await pool.query(`INSERT INTO relationship_types(id,code,name,symmetric,configuration,active) VALUES(UUID_TO_BIN(?),?,?,?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),symmetric=VALUES(symmetric),active=1`,[id,code,name,symmetric]);}
  for(let i=0;i<DEVELOPMENT_STAGES.length;i++){const [code,name,minAge,maxAge]=DEVELOPMENT_STAGES[i],id=`00000000-0000-4000-8008-${String(i+1).padStart(12,"0")}`;await pool.query(`INSERT INTO development_stages(id,code,name,min_age_days,max_age_days,configuration,active) VALUES(UUID_TO_BIN(?),?,?,?, ?,NULL,1) ON DUPLICATE KEY UPDATE name=VALUES(name),min_age_days=VALUES(min_age_days),max_age_days=VALUES(max_age_days),active=1`,[id,code,name,minAge,maxAge]);}
  logger.info({durationMs:Date.now()-started},"Core simulation definitions verified");
}
module.exports={bootstrapCoreDefinitions};
