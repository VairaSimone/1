const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {RealtimeHub}=require("../src/realtime/hub");

function fakeSocket(sendImpl){
  const ws=new EventEmitter();
  ws.readyState=1;
  ws.send=(message,callback)=>sendImpl(message,callback);
  ws.removeListener=EventEmitter.prototype.removeListener.bind(ws);
  return ws;
}

test("expected websocket disconnect errors remove clients without warning-path exceptions",()=>{
  const hub=new RealtimeHub();
  const ws=fakeSocket((message,callback)=>callback(Object.assign(new Error("connection reset"),{code:"ECONNRESET"})));
  hub.attach(ws,"sim-1");
  assert.equal(hub.clients.size,1);
  assert.doesNotThrow(()=>hub.publish("sim-1","entity_state",{id:"e1"}));
  assert.equal(hub.clients.size,0);
});

test("already closing websocket is discarded before send",()=>{
  const hub=new RealtimeHub();
  const ws=fakeSocket(()=>{throw Object.assign(new Error("socket closed"),{code:"ERR_SOCKET_CLOSED"});});
  ws.readyState=2;
  hub.attach(ws,"sim-2");
  hub.publish("sim-2","simulation_tick",{tick:1});
  assert.equal(hub.clients.size,0);
});
