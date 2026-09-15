const ACTIONS = [
  "SLEEPING","EATING","DRINKING","TALKING","PLAYING","RESTING",
  "STUDYING","READING","EXPLORING","WALKING","WORKING","WATCHING"
];

const actionNeeds = {
  SLEEPING:{SLEEPINESS:2.0,ENERGY:1.4}, EATING:{HUNGER:2.4}, DRINKING:{THIRST:2.8},
  TALKING:{SOCIAL_NEED:1.8,BELONGING:1.1}, PLAYING:{FUN:1.6},
  RESTING:{ENERGY:1.0,COMFORT:0.7}, STUDYING:{ACHIEVEMENT:0.9,CURIOSITY:0.5},
  READING:{CURIOSITY:0.8,ACHIEVEMENT:0.3}, EXPLORING:{CURIOSITY:1.4},
  WALKING:{FUN:0.3,CURIOSITY:0.3}, WORKING:{ACHIEVEMENT:1.0}, WATCHING:{FUN:0.9}
};

function scoreAction(action,needs,traits){
  let score=0;
  for(const [code,w] of Object.entries(actionNeeds[action]||{})){
    const n=needs.find(x=>x.code===code);
    if(n) score+=Number(n.value)*w*Number(n.priorityWeight||1);
  }
  const t=new Map(traits.map(x=>[x.code,Number(x.value)]));
  if(action==="TALKING") score+=((t.get("EXTRAVERSION")||0.5)+(t.get("SOCIABILITY")||0.5))*0.2;
  if(action==="EXPLORING") score+=((t.get("OPENNESS")||0.5)+(t.get("CURIOSITY")||0.5))*0.2;
  if(action==="STUDYING") score+=((t.get("CONSCIENTIOUSNESS")||0.5)+(t.get("DISCIPLINE")||0.5))*0.2;
  if(action==="PLAYING") score+=(1-(t.get("NEUROTICISM")||0.5))*0.1;
  if(action==="WORKING") score+=(t.get("CONSCIENTIOUSNESS")||0.5)*0.25;
  return score;
}
module.exports={ACTIONS,scoreAction};
