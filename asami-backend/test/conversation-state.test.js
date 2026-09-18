const test=require("node:test");
const assert=require("node:assert/strict");

const conversation=require("../src/services/conversation-state-service");
const chat=require("../src/services/chat-service");

test("conversation intent distinguishes questions, planning and emotional sharing",()=>{
  assert.equal(conversation.deriveConversationIntent("Come stai?").type,"QUESTION");
  assert.equal(conversation.deriveConversationIntent("Domani voglio andare al mare").type,"PLANNING");
  assert.equal(conversation.deriveConversationIntent("Sono un po' triste oggi").type,"EMOTIONAL_SHARING");
  assert.equal(conversation.deriveConversationIntent("Non sono d'accordo con te").type,"DISAGREEMENT");
});

test("conversation topic remains coherent and shared topics can accumulate",()=>{
  const state={sharedTopics:[]};
  const first=conversation.rememberableTopic(state,"ANIMALS","2026-09-18T10:00:00.000Z");
  const second=conversation.rememberableTopic({...state,sharedTopics:first},"ANIMALS","2026-09-18T11:00:00.000Z");
  assert.equal(second[0].topic,"ANIMALS");
  assert.equal(second[0].count,2);
  assert.equal(conversation.topicFromText("Il mio cane oggi ha fatto una cosa buffa"),"ANIMALS");
});

test("inner conversation state reacts to social need and energy",()=>{
  const engaged=conversation.deriveInnerState({
    needs:[
      {code:"SOCIAL_NEED",value:.9},
      {code:"BELONGING",value:.8},
      {code:"CURIOSITY",value:.8},
      {code:"ENERGY",value:.9},
      {code:"SLEEPINESS",value:.1}
    ],
    emotions:[{code:"JOY",intensity:.7}],
    relationships:[{closenessScore:.8,affectionScore:.8,conflictScore:.05}]
  });
  const exhausted=conversation.deriveInnerState({
    needs:[
      {code:"SOCIAL_NEED",value:.2},
      {code:"BELONGING",value:.2},
      {code:"CURIOSITY",value:.2},
      {code:"ENERGY",value:.2},
      {code:"SLEEPINESS",value:.9}
    ],
    emotions:[{code:"ANXIETY",intensity:.6}],
    relationships:[{closenessScore:.2,affectionScore:.1,conflictScore:.2}]
  });
  assert.ok(engaged.socialInterest>exhausted.socialInterest);
  assert.ok(engaged.desireToContinue>exhausted.desireToContinue);
  assert.ok(engaged.conversationalEnergy>exhausted.conversationalEnergy);
});

test("message significance separates disposable chat from meaningful life information",()=>{
  const trivial=conversation.scoreMessageSignificance("ok");
  const meaningful=conversation.scoreMessageSignificance("Domani voglio portare il mio cane al parco, è una cosa importante per me",{
    intent:{type:"PLANNING"},
    topic:"ANIMALS",
    generated:{rememberedReferences:["the dog and the plan for tomorrow"]}
  });
  assert.ok(trivial.score<.55);
  assert.ok(meaningful.score>=.55);
  assert.ok(meaningful.reasons.includes("future_commitment"));
});

test("Gemini dialogue effects are bounded and goals are evidence-gated",()=>{
  const generated={stateEffects:{
    needs:[{code:"HUNGER",delta:1}],
    emotions:[{code:"JOY",delta:-1}],
    traits:[{code:"EMPATHY",delta:.8}],
    relationship:{trust:1,conflict:-1},
    communicationStyle:{warmth:1},
    goalProposal:{title:"Become a great guitarist",priority:1},
    planProposal:{title:"Guitar plan",steps:[{title:"Practice",actionType:"PLAYING"}]}
  }};
  const normal=chat.sanitizeDialogueEffects(generated,"ok",{type:"SHARE"});
  assert.equal(normal.needs[0].delta,.06);
  assert.equal(normal.emotions[0].delta,-.10);
  assert.equal(normal.traits[0].delta,.01);
  assert.equal(normal.relationship.trust,.08);
  assert.equal(normal.goalProposal,null);
  assert.equal(normal.planProposal,null);

  const planning=chat.sanitizeDialogueEffects(generated,"Domani voglio imparare la chitarra",{type:"PLANNING"});
  assert.ok(planning.goalProposal);
  assert.ok(planning.planProposal);
});

test("future-intent detection covers Italian and English planning cues",()=>{
  assert.equal(chat.hasFutureIntent("Domani vado al parco"),true);
  assert.equal(chat.hasFutureIntent("I will call you tomorrow"),true);
  assert.equal(chat.hasFutureIntent("Questo film mi piace"),false);
});
