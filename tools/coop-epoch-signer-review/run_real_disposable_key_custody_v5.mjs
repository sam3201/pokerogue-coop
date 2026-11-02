// Real disposable co-op relay acceptance on localhost, source-copy only.
// Requires Node 24 for TypeScript stripping. No existing port, service, lock,
// or repository source file is modified.
import {mkdtempSync,cpSync,symlinkSync,readFileSync,writeFileSync,
  rmSync,chmodSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import assert from "node:assert/strict";
import {generateKeyPairSync,createHash} from "node:crypto";
import {PrivateOwnerGrantIpc,privateGrantRequest}
 from "./owner_room_grant_ipc_v1.mjs";
import {loadPrivateOwnerKey,ownerKeyFingerprint}
 from "./owner_signing_key_custody_v1.mjs";
import {PrivateRoomGrantBroker,issuePrivateRoomGrant}
 from "./owner_room_grant_broker_v1.mjs";
import {execFileSync} from "node:child_process";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
const lab=dirname(fileURLToPath(import.meta.url));
const repo=join(lab,"../..");
const scratch=mkdtempSync(join(tmpdir(),"sam-isolated-relay-"));
const work=join(scratch,"coop-server");
const delays=ms=>new Promise(r=>setTimeout(r,ms));
let server,clients=[],ipc,socketDir,privateKeyDir;
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
 execFileSync("git",["apply",
  join(lab,"RELAY_OWNER_SIGNED_ROOM_GRANT_V3.patch")],{
   cwd:scratch,stdio:"pipe",timeout:5000
  });
 const {startRelayServer}=await import(pathToFileURL(join(work,
   "src","relay-server.ts")).href);
 const receipts=[];
 const observer=new PrivateRelayRoomObserver({
  onReceipt:r=>receipts.push(r)
 });
 // A throwaway key is generated in an isolated mode-0700 folder.
 // Only the private owner loads it after independent public-key
 // fingerprint pin validation; no production key is provisioned.
 const generated=generateKeyPairSync("ed25519");
 privateKeyDir=mkdtempSync(join(tmpdir(),"sam-owner-key-fixture-"));
 chmodSync(privateKeyDir,0o700);
 const keyPath=join(privateKeyDir,"owner-ed25519.pk8");
 const secret=generated.privateKey.export({
   type:"pkcs8",format:"der"
 });
 writeFileSync(keyPath,secret,{mode:0o600});
 secret.fill(0);
 const pinnedId=ownerKeyFingerprint(generated.publicKey);
 const signing=loadPrivateOwnerKey({
   privateDirectory:privateKeyDir,keyPath,
   expectedPublicKeyId:pinnedId
 });
 assert.equal(signing.keyId,pinnedId);
 const broker=new PrivateRoomGrantBroker({
  pinnedOwnerKey:generated.publicKey,observer
 });
 const closed=[];
 socketDir=mkdtempSync(join(tmpdir(),"sam-owner-room-ipc-"));
 const socketPath=join(socketDir,"owner-grants.sock");
 ipc=new PrivateOwnerGrantIpc({broker,socketPath});
 await ipc.start();
 const sha=x=>createHash("sha256").update(x).digest("hex");
 const runA="12345678-1234-4123-8123-123456789abc";
 const runB="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const roomGrant=async(client,runId,hostSeatToken=client.identity.token)=>{
   const handle=client.identity.code;
   // Private owner IPC requires proof the caller knows this room's
   // actual random host token. The relay never sends this challenge
   // over the gameplay WebSocket.
   const challenge=await privateGrantRequest(socketPath,{
     op:"challenge",roomHandle:handle,
     hostTokenDigest:sha(client.identity.token)
   });
   assert.equal(challenge.ok,true);
   return issuePrivateRoomGrant({
     roomHandle:handle,runId,challenge:challenge.challenge,
     hostSeatToken,signingKey:signing.privateKey,
     issuedAt:Date.now(),
     expiresAt:Math.min(Date.now()+4500,challenge.expiresAt)
   });
 };
 const authorize=async grant=>privateGrantRequest(socketPath,{
  op:"authorize",grant
 });
 let throwHook=false,hookCalls=0,roomCreated=0;
 server=await startRelayServer({
  port:0,host:"127.0.0.1",allowedOrigins:["*"],
  heartbeatIntervalMs:15000,sweepIntervalMs:1000,
  onRoomCreated:event=>{
   roomCreated++;
   ipc.onRoomCreated(event);
  },
  onRoomClosed:({roomHandle,reason})=>{
   closed.push(reason);
   ipc.onRoomClosed({roomHandle,reason});
   if(reason==="partnerLeft")throw Error("cleanup fault injection");
  },
  onForwardedCheckpoint:event=>{
   hookCalls++;
   if(throwHook)throw Error("observer failure injection");
   ipc.onForwardedCheckpoint(event);
  }
 });
 // An unrelated client opens its own room before the legitimate owner.
 // It must NOT consume runA or gain any state receipt without a signed
 // owner grant, unlike the deprecated V2 FIFO fixture.
 const outsiderHost=await connect("host");
 const outsiderGuest=await connect("guest",outsiderHost.identity.code);
 const outsiderChallenge=await privateGrantRequest(socketPath,{
   op:"challenge",roomHandle:outsiderHost.identity.code,
   hostTokenDigest:sha(outsiderHost.identity.token)
 });
 assert.equal(outsiderChallenge.ok,true);
 send(outsiderHost,transportFrame("host",0,1));
 send(outsiderGuest,transportFrame("guest",0,1));
 await awaitCondition(()=>outsiderGuest.messages.some(m=>m.n===1),
   "unbound outsider room still forwards messages");
 assert.equal(observer.status.matched,0);
 assert.equal(broker.status.authorized,0);
 assert.deepEqual(await authorize(await roomGrant(outsiderHost,runA)),
   {ok:false},"No late grant after checkpoint zero");
 // The owner room and host seat token are bound via a relay-internal
 // challenge and an owner signature, never via a FIFO room list.
 const firstHost=await connect("host");
 const firstGuest=await connect("guest",firstHost.identity.code);
 const wrongTokenGrant=await roomGrant(firstHost,runA,"ff".repeat(16));
 assert.deepEqual(await authorize(wrongTokenGrant),{ok:false});
 const grantA=await roomGrant(firstHost,runA);
 assert.deepEqual(await authorize(grantA),{ok:true});
 assert.deepEqual(await authorize(grantA),{ok:false},
   "Grant must be one-shot even across IPC calls");
 assert.equal(observer.status.activeRooms,1);
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
 // Independently authorized second run detects a mismatch.
 const secondHost=await connect("host");
 const secondGuest=await connect("guest",secondHost.identity.code);
 assert.deepEqual(await authorize(await roomGrant(secondHost,runB)),
   {ok:true});
 assert.equal(observer.status.activeRooms,2);
 send(secondHost,transportFrame("host",0,1));
 send(secondGuest,transportFrame("guest",0,1,"ffffffffffffff"));
 await awaitCondition(()=>observer.status.rejected>=1,
   "client checkpoint disagreement");
 const rejected=observer.status.rejected;
 // The first outsider room never acquired a run ID.
 assert.equal(observer.status.matched,2);
 assert.equal(observer.status.rejected,rejected);
 assert.equal(observer.status.activeRooms,2);
 assert.equal(receipts.length,2);
 // Server-owned room teardown revokes only the specific binding.
 firstHost.socket.close(4003,"test owner finished");
 await awaitCondition(()=>observer.status.activeRooms===1,
   "authorized run A revoked");
 secondHost.socket.close(4003,"test owner finished");
 await awaitCondition(()=>observer.status.activeRooms===0,
   "authorized run B revoked");
 outsiderHost.socket.close(4003,"test outsider finished");
 await awaitCondition(()=>broker.status.rooms===0,
   "all room challenge state reclaimed");
 assert.equal(closed.filter(r=>r==="partnerLeft").length,3);
 const output={
  scope:"disposable-localhost-only",realWebSocket:true,
  wireFormat:"reliable {n,b}",matched:observer.status.matched,
  divergent:observer.status.rejected,hookCalls,roomCreated,
  signedOwnerRoomGrant:true,privateUnixOwnerIpc:true,
  privateKeyCustodyVerified:true,
  outsiderRoomCannotStealRun:true,
  wrongHostTokenRejected:true,oneTimeGrant:true,
  relayOwnedChallenge:true,roomTeardownFromRelay:true,
  unregisteredRoomIgnored:true,observerFaultIsolated:true,
  originalRelayModified:false,publicFeedModified:false,
  sceneEpochAttested:false,productionSceneEligible:false
 };
 console.log("REAL_DISPOSABLE_KEY_CUSTODY_V5",JSON.stringify(output));
 if(output.matched!==2||output.divergent!==1||roomCreated!==3||
    !output.signedOwnerRoomGrant||!output.privateUnixOwnerIpc||
    !output.privateKeyCustodyVerified||
    !output.outsiderRoomCannotStealRun||
    !output.wrongHostTokenRejected||!output.oneTimeGrant||
    !output.roomTeardownFromRelay||
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
 if(ipc)await ipc.close().catch(e=>{
   console.error("OWNER_IPC_CLEANUP",String(e));
   process.exitCode=1;
 });
 if(socketDir)rmSync(socketDir,{recursive:true,force:true});
 if(privateKeyDir)rmSync(privateKeyDir,{recursive:true,force:true});
 rmSync(scratch,{recursive:true,force:true});
}
