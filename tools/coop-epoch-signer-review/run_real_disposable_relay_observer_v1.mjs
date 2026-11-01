// Real disposable co-op relay acceptance on localhost, source-copy only.
// Requires Node 24 for TypeScript stripping. No existing port, service, lock,
// or repository source file is modified.
import {mkdtempSync,cpSync,symlinkSync,readFileSync,writeFileSync,
  rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import assert from "node:assert/strict";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
const lab=dirname(fileURLToPath(import.meta.url));
const repo=join(lab,"../..");
const scratch=mkdtempSync(join(tmpdir(),"sam-isolated-relay-"));
const work=join(scratch,"coop-server");
const delays=ms=>new Promise(r=>setTimeout(r,ms));
let server,clients=[];
function ensureReplacement(original,oldCode,newCode){
 const count=original.split(oldCode).length-1;
 if(count!==1)throw Error("Relay source anchor drifted: "+count);
 return original.replace(oldCode,newCode);
}
function transportFrame(seat,index=0,n=1,hash="0123456789abcd"){
 return JSON.stringify({n,b:{kind:"CHECKPOINT",key:null,author:seat,
  payload:{index,kind:index===0?"waveStart":"turn",wave:1,
   turn:index,phaseName:"CommandPhase",hash}}});
}
async function awaitCondition(fn,label,timeoutMs=5000){
 const until=Date.now()+timeoutMs;
 while(Date.now()<until){
  const value=fn();
  if(value)return value;
  await delays(25);
 }
 throw Error("Relay integration deadline: "+label);
}
async function connect(role,code){
 const url="ws://127.0.0.1:"+server.port+"/coop/?"+
  (role==="host"?"role=host":"code="+encodeURIComponent(code));
 const socket=new WebSocket(url);
 clients.push(socket);
 const messages=[];
 socket.addEventListener("message",ev=>{
  try{messages.push(JSON.parse(ev.data));}catch{}
 });
 socket.addEventListener("error",()=>{});
 const expected=role==="host"?"relay:created":"relay:joined";
 const identity=await awaitCondition(()=>messages.find(m=>m.t===expected),
  expected);
 return {socket,messages,identity};
}
function send(client,msg){if(client.socket.readyState!==1)
 throw Error("Test socket not open");client.socket.send(msg);}
try{
 cpSync(join(repo,"coop-server","src"),join(work,"src"),{recursive:true});
 symlinkSync(join(repo,"coop-server","node_modules"),
   join(work,"node_modules"),"dir");
 writeFileSync(join(work,"package.json"),JSON.stringify({
  name:"sam-disposable-relay",private:true,type:"module"
 }));
 const original=readFileSync(join(work,"src","relay-server.ts"),"utf8");
 let patched=ensureReplacement(original,
  "  clientLogs?: ClientLogOptions;\n",
  "  clientLogs?: ClientLogOptions;\n"+
  "  onForwardedCheckpoint?: (event: { roomHandle: string; seat: Seat; text: string }) => void;\n"
 );
 patched=ensureReplacement(patched,
  "      stalled.delete(peer);\n      peer.send(text);\n",
  "      stalled.delete(peer);\n      peer.send(text);\n"+
  "      if (options.onForwardedCheckpoint && text.length <= 4096 && text.includes('\\\"CHECKPOINT\\\"')) {\n"+
  "        try { options.onForwardedCheckpoint({ roomHandle: code, seat, text }); } catch {}\n"+
  "      }\n"
 );
 writeFileSync(join(work,"src","relay-server.ts"),patched);
 const {startRelayServer}=await import(pathToFileURL(join(work,
   "src","relay-server.ts")).href);
 const receipts=[];
 const observer=new PrivateRelayRoomObserver({
  onReceipt:r=>receipts.push(r)
 });
 let throwHook=false,hookCalls=0;
 server=await startRelayServer({
  port:0,host:"127.0.0.1",allowedOrigins:["*"],
  heartbeatIntervalMs:15000,sweepIntervalMs:1000,
  onForwardedCheckpoint:event=>{
   hookCalls++;
   if(throwHook)throw Error("Simulated observer outage");
   observer.onForwardedCheckpoint(event);
  }
 });
 const runA="12345678-1234-4123-8123-123456789abc";
 const firstHost=await connect("host");
 const firstGuest=await connect("guest",firstHost.identity.code);
 observer.registerRoom({roomHandle:firstHost.identity.code,runId:runA});
 send(firstHost,transportFrame("host",0,1));
 await awaitCondition(()=>firstGuest.messages.some(m=>m.n===1),
   "guest receives host checkpoint");
 assert.equal(observer.status.matched,0);
 send(firstGuest,transportFrame("guest",0,1));
 await awaitCondition(()=>receipts.length===1,"matching host/guest receipt");
 assert.equal(receipts[0].checkpoint.index,0);
 assert.equal(receipts[0].productionSceneEligible,false);
 assert.equal(receipts[0].stateHashOrigin,"both-clients");
 // Unmodified reliable transport can resend identical frame.
 send(firstHost,transportFrame("host",0,1));
 await delays(50);
 assert.equal(observer.status.matched,1);
 send(firstHost,transportFrame("host",1,2));
 send(firstGuest,transportFrame("guest",1,2));
 await awaitCondition(()=>observer.status.matched===2,
   "second ordered checkpoint");
 assert.equal(receipts.length,2);
 // Observer fault MUST NOT interrupt forwarding.
 throwHook=true;
 const next=transportFrame("host",2,3);
 send(firstHost,next);
 await awaitCondition(()=>firstGuest.messages.some(m=>m.n===3),
   "guest still receives while observer throws");
 throwHook=false;
 // A second room independently detects mismatched client states.
 const secondHost=await connect("host");
 const secondGuest=await connect("guest",secondHost.identity.code);
 observer.registerRoom({
  roomHandle:secondHost.identity.code,
  runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
 });
 send(secondHost,transportFrame("host",0,1));
 send(secondGuest,transportFrame("guest",0,1,"ffffffffffffff"));
 await awaitCondition(()=>observer.status.rejected>=1,
   "client checkpoint disagreement");
 const rejected=observer.status.rejected;
 // An unregistered room must never produce a diagnostic.
 const thirdHost=await connect("host");
 const thirdGuest=await connect("guest",thirdHost.identity.code);
 send(thirdHost,transportFrame("host",0,1));
 send(thirdGuest,transportFrame("guest",0,1));
 await awaitCondition(()=>thirdGuest.messages.some(m=>m.n===1),
   "unregistered room forwards normally");
 assert.equal(observer.status.matched,2);
 assert.equal(observer.status.rejected,rejected);
 assert.equal(observer.status.activeRooms,2);
 assert.equal(receipts.length,2);
 const output={
  scope:"disposable-localhost-only",realWebSocket:true,
  wireFormat:"reliable {n,b}",matched:observer.status.matched,
  divergent:observer.status.rejected,hookCalls,
  unregisteredRoomIgnored:true,observerFaultIsolated:true,
  originalRelayModified:false,publicFeedModified:false,
  sceneEpochAttested:false,productionSceneEligible:false
 };
 console.log("REAL_DISPOSABLE_RELAY_ACCEPTANCE",JSON.stringify(output));
 if(output.matched!==2||output.divergent!==1||
    !output.observerFaultIsolated||!output.unregisteredRoomIgnored)
   process.exitCode=1;
} catch(e){
 console.error("REAL_DISPOSABLE_RELAY_FAILURE",
  String(e?.stack||e));
 process.exitCode=1;
}finally{
 for(const client of clients){
  try{client.close();}catch{}
 }
 if(server)await server.close().catch(e=>{
  console.error("RELAY_CLEANUP",String(e));
  process.exitCode=1;
 });
 rmSync(scratch,{recursive:true,force:true});
}
