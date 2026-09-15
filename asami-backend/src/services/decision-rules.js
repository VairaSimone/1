const ACTIONS = [
  "SLEEPING","EATING","DRINKING","TALKING","PLAYING","RESTING",
  "STUDYING","READING","EXPLORING","WALKING","WORKING","WATCHING"
];

const actionNeeds = {
  EATING:{HUNGER:2.4},
  DRINKING:{THIRST:2.8},
  TALKING:{SOCIAL_NEED:1.8,BELONGING:1.1},
  PLAYING:{FUN:1.6},
  STUDYING:{ACHIEVEMENT:0.9,CURIOSITY:0.5},
  READING:{CURIOSITY:0.8,ACHIEVEMENT:0.3},
  EXPLORING:{CURIOSITY:1.4},
  WALKING:{FUN:0.3,CURIOSITY:0.3},
  WORKING:{ACHIEVEMENT:1.0},
  WATCHING:{FUN:0.9}
};

function needValue(needs, code) {
  const need = needs.find(x => x.code === code);
  return need ? Number(need.value) : 0;
}

function needWeight(needs, code) {
  const need = needs.find(x => x.code === code);
  return Number(need?.priorityWeight || 1);
}

function scoreAction(action,needs,traits){
  let score=0;

  if(action === "SLEEPING"){
    // Needs represent unmet pressure: high sleepiness and low energy should
    // increase the motivation to sleep, while high energy should reduce it.
    const sleepiness = needValue(needs, "SLEEPINESS");
    const energy = needValue(needs, "ENERGY");
    score += sleepiness * 2.0 * needWeight(needs, "SLEEPINESS");
    score += (1 - energy) * 1.4 * needWeight(needs, "ENERGY");

    // Once sleepiness is low and energy is high, sleeping should no longer
    // remain the dominant action simply because sleep itself restores energy.
    if(sleepiness < 0.18 && energy > 0.72) score *= 0.15;
  } else if(action === "RESTING"){
    const energy = needValue(needs, "ENERGY");
    const comfort = needValue(needs, "COMFORT");
    score += (1 - energy) * 1.0 * needWeight(needs, "ENERGY");
    score += comfort * 0.7 * needWeight(needs, "COMFORT");
  } else {
    for(const [code,w] of Object.entries(actionNeeds[action]||{})){
      score += needValue(needs, code) * w * needWeight(needs, code);
    }
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