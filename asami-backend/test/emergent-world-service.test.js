const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROJECT_RULES,
  candidateProjectRule,
  buildProjectName,
  buildProjectProposal
} = require("../src/services/emergent-world-service");

function actor(entityId, locationId, needs) {
  return { entityId, displayName: entityId, locationId, needs };
}

test("collective hunger can generate a market project", () => {
  const actors = [
    actor("a","loc",{HUNGER:.80,ACHIEVEMENT:.60,SOCIAL_NEED:.50,BELONGING:.40}),
    actor("b","loc",{HUNGER:.72,ACHIEVEMENT:.55,SOCIAL_NEED:.52,BELONGING:.45}),
    actor("c","loc",{HUNGER:.68,ACHIEVEMENT:.48,SOCIAL_NEED:.48,BELONGING:.42})
  ];
  const result = candidateProjectRule(actors);
  assert.ok(result);
  assert.equal(result.rule.projectType,"LOCAL_MARKET");
  assert.equal(result.qualifying,3);
  assert.ok(result.score>0);
});

test("collective low pressure generates no project", () => {
  const actors = [
    actor("a","loc",{HUNGER:.20,ACHIEVEMENT:.20,SOCIAL_NEED:.20,BELONGING:.20}),
    actor("b","loc",{HUNGER:.18,ACHIEVEMENT:.22,SOCIAL_NEED:.25,BELONGING:.18}),
    actor("c","loc",{HUNGER:.21,ACHIEVEMENT:.24,SOCIAL_NEED:.22,BELONGING:.16})
  ];
  assert.equal(candidateProjectRule(actors),null);
});

test("project type is chosen from the strongest collective pressure", () => {
  const actors = [
    actor("a","loc",{HUNGER:.30,BELONGING:.85,SOCIAL_NEED:.82,FUN:.70}),
    actor("b","loc",{HUNGER:.28,BELONGING:.78,SOCIAL_NEED:.80,FUN:.72}),
    actor("c","loc",{HUNGER:.25,BELONGING:.76,SOCIAL_NEED:.74,FUN:.68})
  ];
  const result = candidateProjectRule(actors);
  assert.equal(result?.rule.projectType,"COMMUNITY_HUB");
});

test("project names and activities are generated without player input", () => {
  const rule = PROJECT_RULES.find(x=>x.projectType==="WORKSHOP_COOPERATIVE");
  const proposal = buildProjectProposal(rule,{
    proposer:{entityId:"x",displayName:"Luca Bianchi"},
    scope:{locationId:"loc",name:"Central Square",locationType:"SQUARE"},
    qualifyingPeople:4,
    score:.81
  });
  assert.equal(buildProjectName(rule,"Luca Bianchi","Central Square"),"Officina Luca");
  assert.equal(proposal.generatedWithoutPlayerInput,true);
  assert.equal(proposal.origin,"EMERGENT_NEED");
  assert.deepEqual(proposal.activities,rule.activities);
});
