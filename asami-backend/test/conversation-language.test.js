const test=require("node:test");
const assert=require("node:assert/strict");
const {detectConversationLanguage}=require("../src/services/chat-service");

test("detectConversationLanguage identifies Italian user messages",()=>{
  assert.equal(detectConversationLanguage("Se dovessi descrivere chi sei in questo momento, quali sono le tre caratteristiche che ti definiscono di più?"),"it");
  assert.equal(detectConversationLanguage("Qual è la cosa più importante che vuoi ottenere nella tua vita in questo momento?"),"it");
});

test("detectConversationLanguage identifies English user messages",()=>{
  assert.equal(detectConversationLanguage("What are the three things you like most about your life right now?"),"en");
  assert.equal(detectConversationLanguage("How old are you and what do you want to achieve?"),"en");
});

test("detectConversationLanguage defaults empty input to Italian",()=>{
  assert.equal(detectConversationLanguage(""),"it");
});
