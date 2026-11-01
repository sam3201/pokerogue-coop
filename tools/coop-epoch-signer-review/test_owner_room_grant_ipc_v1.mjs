import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,lstatSync,writeFileSync,
 existsSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PrivateRoomGrantBroker,issuePrivateRoomGrant}
 from "./owner_room_grant_broker_v1.mjs";
import {PrivateRelayRoomObserver}
 from "./relay_room_checkpoint_adapter_v1.mjs";
import {PrivateOwnerGrantIpc,privateGrantRequest}
 from "./owner_room_grant_ipc_v1.mjs";
const key=generateKeyPairSync("ed25519");
const token="ab".repeat(16),roomHandle="ABC234";
const runId="12345678-1234-4123-8123-123456789abc";
const sha=s=>createHash("sha256").update(s).digest("hex");
const frame=(seat,n=1)=>JSON.stringify({n,b:{kind:"CHECKPOINT",
 author:seat,key:null,payload:{index:0,kind:"waveStart",
 wave:1,turn:0,phaseName:"EncounterPhase",hash:"0123456789abcd"}}});
async function setup(){
 const root=mkdtempSync(join(tmpdir(),"sam-owner-ipc-fixture-"));
 const path=join(root,"owner-grants.sock");
 const receipts=[],observer=new PrivateRelayRoomObserver({
  onReceipt:r=>receipts.push(r)
 });
 const broker=new PrivateRoomGrantBroker({
  pinnedOwnerKey:key.publicKey,observer
 });
 const ipc=new PrivateOwnerGrantIpc({broker,socketPath:path});
 await ipc.start();
 const created=ipc.onRoomCreated({roomHandle,hostTokenDigest:sha(token)});
 return {root,path,observer,broker,ipc,created,receipts,
  async cleanup(){await ipc.close();rmSync(root,{recursive:true,force:true});}
 };
}
test("AF_UNIX mode 0600 enforces two-factor owner room binding",async()=>{
 const x=await setup();
 try{
  assert.equal(lstatSync(x.path).isSocket(),true);
  assert.equal(lstatSync(x.path).mode&0o777,0o600);
  const q=await privateGrantRequest(x.path,{op:"challenge",
   roomHandle,hostTokenDigest:sha(token)});
  assert.equal(q.ok,true);
  assert.match(q.challenge,/^[a-f0-9]{64}$/);
  const grant=issuePrivateRoomGrant({roomHandle,runId,hostSeatToken:token,
   challenge:q.challenge,issuedAt:Date.now(),
   expiresAt:Math.min(Date.now()+4000,q.expiresAt),
   signingKey:key.privateKey});
  const bound=await privateGrantRequest(x.path,{op:"authorize",grant});
  assert.deepEqual(bound,{ok:true});
  assert.deepEqual(await privateGrantRequest(x.path,{
    op:"authorize",grant}),{ok:false});
  x.ipc.onForwardedCheckpoint({roomHandle,seat:"host",text:frame("host")});
  const paired=x.ipc.onForwardedCheckpoint({
   roomHandle,seat:"guest",text:frame("guest")});
  assert.equal(paired.status,"matched");
  assert.equal(paired.receipt.runId,runId);
  assert.equal(paired.receipt.productionSceneEligible,false);
  assert.equal(x.receipts.length,1);
 }finally{await x.cleanup();}
});
test("wrong host-seat digest cannot retrieve a private challenge",async()=>{
 const x=await setup();
 try{
  const q=await privateGrantRequest(x.path,{op:"challenge",
   roomHandle,hostTokenDigest:"e".repeat(64)});
  assert.deepEqual(q,{ok:false});
  assert.equal(x.ipc.status.authorized,0);
 }finally{await x.cleanup();}
});
test("unknown operation and room are denied without metadata disclosure",async()=>{
 const x=await setup();
 try{
  for(const req of [{op:"list"},{op:"challenge",roomHandle:"XYZ234",
      hostTokenDigest:sha(token)},
    {op:"challenge",roomHandle,hostTokenDigest:sha(token),
     privateToken:token}]){
   assert.deepEqual(await privateGrantRequest(x.path,req),{ok:false});
  }
 }finally{await x.cleanup();}
});
test("forged owner signature is denied without affecting forwarding",async()=>{
 const x=await setup();
 try{
  const q=await privateGrantRequest(x.path,{op:"challenge",
   roomHandle,hostTokenDigest:sha(token)});
 const grant=issuePrivateRoomGrant({roomHandle,runId,hostSeatToken:token,
   challenge:q.challenge,issuedAt:Date.now(),
   expiresAt:Math.min(q.expiresAt,Date.now()+4000),
   signingKey:generateKeyPairSync("ed25519").privateKey});
  assert.deepEqual(await privateGrantRequest(x.path,{
   op:"authorize",grant}),{ok:false});
  assert.equal(x.ipc.status.authorized,0);
  assert.equal(x.ipc.onForwardedCheckpoint({
    roomHandle,seat:"host",text:frame("host")}).status,"ignored");
 }finally{await x.cleanup();}
});
test("room teardown invalidates challenges and prior bindings",async()=>{
 const x=await setup();
 try{
  x.ipc.onRoomClosed({roomHandle,reason:"partnerLeft"});
  assert.deepEqual(await privateGrantRequest(x.path,{
    op:"challenge",roomHandle,hostTokenDigest:sha(token)}),{ok:false});
  assert.equal(x.ipc.status.pendingRooms,0);
  assert.equal(x.ipc.status.rooms,0);
 }finally{await x.cleanup();}
});
test("IPC rejects nonprivate parent directory",()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-owner-ipc-insecure-"));
 try{
  chmodSync(root,0o755);
  const observer=new PrivateRelayRoomObserver();
  const broker=new PrivateRoomGrantBroker({
   pinnedOwnerKey:key.publicKey,observer
  });
  assert.throws(()=>new PrivateOwnerGrantIpc({
   broker,socketPath:join(root,"owner-grants.sock")
  }),/owner-private/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("shutdown removes only socket created by this instance",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sam-ipc-ownership-"));
 try{
  const path=join(root,"owner-grants.sock");
  const observer=new PrivateRelayRoomObserver();
  const broker=new PrivateRoomGrantBroker({
   pinnedOwnerKey:key.publicKey,observer
  });
  writeFileSync(path,"existing user file",{mode:0o600});
  const ipc=new PrivateOwnerGrantIpc({broker,socketPath:path});
  await assert.rejects(ipc.start(),/already exists/);
  await ipc.close();
  assert.equal(existsSync(path),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
