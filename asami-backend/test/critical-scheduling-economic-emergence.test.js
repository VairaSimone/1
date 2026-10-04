const test=require('node:test');
const assert=require('node:assert/strict');
const {criticalNeedAction,criticalNeedTemporalSignal}=require('../src/services/decision-service');
const {economicSeedDefinition,ensureEconomicSeed}=require('../src/services/society-service');
const {definitionTargetsNeed,countRecentStructuralPressureProposals,NEED_STRUCTURE_COOLDOWN_HOURS}=require('../src/services/open-emergence-service');

const SIM_TIME='2026-12-17T08:30:54.600Z';
const TIED_NEEDS=[
  {code:'THIRST',value:1,priorityWeight:1.1},
  {code:'HUNGER',value:1,priorityWeight:1},
  {code:'SLEEPINESS',value:1,priorityWeight:1.1},
  {code:'ENERGY',value:.50,priorityWeight:1},
  {code:'SAFETY',value:.80,priorityWeight:1.2}
];

test('critical scheduler does not let a physiological tie default to THIRST for every entity',()=>{
  const actions=new Set();
  for(let i=0;i<24;i++){
    actions.add(criticalNeedAction(TIED_NEEDS,{entityId:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),recentActions:[],simulationTime:SIM_TIME}));
  }
  assert.ok(actions.size>1,'expected more than one critical action under a population tie, got '+[...actions].join(','));
});

test('critical scheduler gives a recently unsatisfied need debt and penalizes a just-satisfied need',()=>{
  const recent=[{actionType:'DRINKING',completedSimulationAt:'2026-12-17T07:30:54.600Z'}];
  const thirsty=criticalNeedTemporalSignal('THIRST',recent,SIM_TIME);
  const hungry=criticalNeedTemporalSignal('HUNGER',recent,SIM_TIME);
  assert.ok(thirsty.recentPenalty>0);
  assert.ok(thirsty.debtBonus<hungry.debtBonus);
  assert.equal(thirsty.lastSatisfiedAt,'2026-12-17T07:30:54.600Z');
});

test('economic seed definitions are materially economic and target their intended pressure',()=>{
  const market=economicSeedDefinition('MARKET');
  const producer=economicSeedDefinition('PRODUCER');
  assert.equal(market.market,true);
  assert.equal(market.production,false);
  assert.ok(definitionTargetsNeed(market,'HUNGER'));
  assert.equal(producer.production,true);
  assert.equal(producer.market,false);
  assert.ok(definitionTargetsNeed(producer,'ACHIEVEMENT'));
  assert.equal(NEED_STRUCTURE_COOLDOWN_HOURS,72);
});

test('economic seed and structural proposal maintenance are exported for runtime maintenance',()=>{
  assert.equal(typeof ensureEconomicSeed,'function');
  assert.equal(typeof countRecentStructuralPressureProposals,'function');
});

test('rebuildDecisionCandidates uses the context simulation time without throwing',()=>{
  const {rebuildDecisionCandidates}=require('../src/services/decision-service');
  assert.doesNotThrow(()=>rebuildDecisionCandidates({
    simulationTime:SIM_TIME,
    needs:[
      {code:'THIRST',value:1,priorityWeight:1},
      {code:'HUNGER',value:1,priorityWeight:1}
    ],
    traits:[],
    goals:[],
    recentActions:[],
    recoveryBlocks:[],
    resourceContext:{},
    activityTypes:[{code:'DRINKING'},{code:'EATING'},{code:'WALKING'}],
    cognitiveProfile:{}
  },'00000000-0000-4000-8000-000000000001'));
});
