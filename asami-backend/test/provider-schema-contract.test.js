const test=require("node:test");
const assert=require("node:assert/strict");
const {toProviderJsonSchema,DecisionSchema,AdvancedDecisionSchema}=require("../src/ai/gemini");
const {ProposalSchema}=require("../src/services/open-emergence-service");

test("Gemini provider schema is derived from the same Zod contract",()=>{
  const schema=toProviderJsonSchema(ProposalSchema);
  assert.equal(schema.type,"object");
  for(const field of ["kind","code","name","category","purpose","activities"]){
    assert.ok(schema.properties?.[field],field+" missing from provider schema");
  }
  for(const field of ["kind","code","name","category","purpose","activities"]){
    assert.ok(schema.required?.includes(field),field+" missing from provider required list");
  }
  assert.equal(schema.properties.activities.type,"array");
  assert.ok(schema.properties.activities.items?.properties?.durationMinutes);
  assert.ok(schema.properties.activities.items?.properties?.effects?.items?.properties?.type);
});

test("Decision provider contracts remain Zod-derived rather than hand-maintained",()=>{
  for(const schema of [DecisionSchema,AdvancedDecisionSchema]){
    const provider=toProviderJsonSchema(schema);
    for(const field of ["selectedActionType","reason","confidence"]){
      assert.ok(provider.properties?.[field],field+" missing from provider schema");
      assert.ok(provider.required?.includes(field),field+" missing from provider required list");
    }
    assert.ok(provider.properties.targetEntityId);
    assert.ok(provider.properties.targetLocationId);
  }
});

test("provider schema conversion fails closed for unsupported schema types",()=>{
  const {z}=require("zod");
  assert.throws(
    ()=>toProviderJsonSchema(z.object({when:z.date()})),
    /not representable|representable|JSON Schema/i
  );
});
