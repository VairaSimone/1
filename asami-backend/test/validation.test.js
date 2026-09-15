const test=require("node:test");
const assert=require("node:assert/strict");
const { queryLimit }=require("../src/api/validation");

test("pagination limit accepts bounded integers",()=>{
  assert.equal(queryLimit(100,500).parse("25"),25);
  assert.equal(queryLimit(100,500).parse(undefined),100);
});

test("invalid pagination limits fall back safely",()=>{
  assert.equal(queryLimit(100,500).parse("0"),100);
  assert.equal(queryLimit(100,500).parse("-10"),100);
  assert.equal(queryLimit(100,500).parse("not-a-number"),100);
  assert.equal(queryLimit(100,500).parse("9999"),100);
});
