import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
import {PrivateRoomGrantBroker,issuePrivateRoomGrant,SCHEMA}
  from "./owner_room_grant_broker_v1.mjs";
const key=generateKeyPairSync("ed25519");
const RUN="12345678-1234-4123-8123-123456789abc";
const RUN2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM="ABC234",ROOM2="XYZ234",TOKEN="1a".repeat(16);
const sha=s=>createHash("sha256").update(s).digest("hex");
const cp=(seat,index,n=1,hash="0123456789abcd")=>JSON.stringify({
 n,b:{kind:"CHECKPOINT",author:seat,key:null,payload:{
  index,kind:"turn",wave:1,turn:index,phaseName:"CommandPhase",hash}}
});
function rig({ownerKey=key.publicKey,ttlMs=12000,maxRooms=32,
  nowStart=1234567890000}={}){
 let time=nowStart;
 const receipts=[],observer=new PrivateRelayRoomObserver({
  maxRooms,onReceipt:r=>receipts.push(r)
 });
 const broker=new PrivateRoomGrantBroker({
  pinnedOwnerKey:ownerKey,observer,now:()=>time,ttlMs,maxRooms
 });
 const create=(roomHandle=ROOM,token=TOKEN)=>
   broker.onRoomCreated({roomHandle,hostTokenDigest:sha(token)});
 const grant=(roomHandle,challenge,token=TOKEN,runId=RUN,signingKey=key.privateKey,
    issuedAt=time,expiresAt=time+5000)=>
   issuePrivateRoomGrant({roomHandle,runId,challenge,
     hostSeatToken:token,signingKey,issuedAt,expiresAt});
 return {broker,observer,receipts,create,grant,
  advance:ms=>{time+=ms;},time:()=>time};
}
test("relay-created room + owner Ed25519 grant authorizes paired checkpoints",()=>{
 const x=rig(),challenge=x.create();
 assert.equal(challenge.roomHandle,ROOM);
 assert.equal(JSON.stringify(challenge).includes(TOKEN),false);
 assert.equal(JSON.stringify(x.broker.status).includes(ROOM),false);
 const signed=x.grant(ROOM,challenge.challenge);
 assert.equal(signed.schema,SCHEMA);
 assert.equal(signed.payload.hostTokenDigest,sha(TOKEN));
 assert.equal(signed.payload.runId,RUN);
 assert.equal(Object.hasOwn(signed,"signingKey"),false);
 assert.equal(x.broker.authorize(signed),true);
 assert.equal(x.broker.status.authorized,1);
 x.broker.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",text:cp("host",0)});
 const result=x.broker.onForwardedCheckpoint({
  roomHandle:ROOM,seat:"guest",text:cp("guest",0)});
 assert.equal(result.status,"matched");
 assert.equal(result.receipt.runId,RUN);
 assert.equal(result.receipt.productionSceneEligible,false);
 assert.equal(x.receipts.length,1);
});
test("unauthorized room cannot emit matched receipts",()=>{
 const x=rig();x.create();
 x.broker.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",text:cp("host",0)});
 const r=x.broker.onForwardedCheckpoint({
  roomHandle:ROOM,seat:"guest",text:cp("guest",0)});
 assert.equal(r.status,"ignored");
 assert.equal(x.receipts.length,0);
 assert.equal(x.broker.status.authorized,0);
});
test("checkpoint before grant irreversibly rejects later authorization",()=>{
 const x=rig(),challenge=x.create();
 x.broker.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",text:cp("host",0)});
 assert.equal(x.broker.authorize(x.grant(ROOM,challenge.challenge)),false);
 assert.equal(x.broker.status.authorized,0);
});
test("forged signing key, wrong seat token and changed payload rejected",()=>{
 const x=rig(),challenge=x.create();
 const wrong=generateKeyPairSync("ed25519").privateKey;
 assert.equal(x.broker.authorize(x.grant(ROOM,challenge.challenge,TOKEN,RUN,wrong)),false);
 assert.equal(x.broker.authorize(
   x.grant(ROOM,challenge.challenge,"ee".repeat(16))),false);
 const tampered=structuredClone(x.grant(ROOM,challenge.challenge));
 tampered.payload.runId=RUN2;
 assert.equal(x.broker.authorize(tampered),false);
 const extra=structuredClone(x.grant(ROOM,challenge.challenge));
 extra.roomToken="leak";
 assert.equal(x.broker.authorize(extra),false);
 assert.equal(x.broker.status.authorized,0);
});
test("short-lived grant rejects expiry, future issuance and oversized lifetimes",()=>{
 const x=rig(),challenge=x.create();
 const expired=x.grant(ROOM,challenge.challenge);
 x.advance(6000);
 assert.equal(x.broker.authorize(expired),false);
 assert.equal(x.broker.authorize(x.grant(
  ROOM,challenge.challenge,TOKEN,RUN,key.privateKey,x.time()+5000,
  x.time()+8000)),false);
 assert.throws(()=>x.grant(ROOM,challenge.challenge,TOKEN,RUN,
   key.privateKey,x.time(),x.time()+60000),/Malformed owner grant/);
});
test("grant replay and concurrently reusing run identity rejected",()=>{
 const x=rig(),a=x.create();
 const signed=x.grant(ROOM,a.challenge);
 assert.equal(x.broker.authorize(signed),true);
 assert.equal(x.broker.authorize(signed),false);
 const b=x.create(ROOM2,"bb".repeat(16));
 assert.equal(x.broker.authorize(x.grant(
  ROOM2,b.challenge,"bb".repeat(16),RUN)),false);
 assert.equal(x.broker.authorize(x.grant(
  ROOM2,b.challenge,"bb".repeat(16),RUN2)),true);
 assert.equal(x.broker.status.authorized,2);
});
test("room close revokes binding; late packet and replay fail",()=>{
 const x=rig(),c=x.create();
 const signed=x.grant(ROOM,c.challenge);
 assert.equal(x.broker.authorize(signed),true);
 assert.equal(x.broker.onRoomClosed({roomHandle:ROOM}),true);
 assert.equal(x.broker.onRoomClosed({roomHandle:ROOM}),false);
 assert.equal(x.broker.status.rooms,0);
 assert.equal(x.observer.status.activeRooms,0);
 assert.equal(x.broker.onForwardedCheckpoint({
  roomHandle:ROOM,seat:"host",text:cp("host",0)}).status,"ignored");
 assert.equal(x.broker.authorize(signed),false);
});
test("room cap, malformed host proof and malformed room rejected",()=>{
 const x=rig({maxRooms:1});x.create();
 assert.throws(()=>x.create(ROOM2,"bb".repeat(16)),/Untrusted/);
 assert.throws(()=>x.create("bad","bb".repeat(16)),/Untrusted/);
 assert.throws(()=>x.broker.onRoomCreated({
  roomHandle:ROOM2,hostTokenDigest:"wrong"}),/Untrusted/);
 assert.equal(x.broker.status.rooms,1);
});
test("receipt body never includes raw token, room code or signing key",()=>{
 const x=rig(),c=x.create(),signed=x.grant(ROOM,c.challenge);
 assert.equal(x.broker.authorize(signed),true);
 const json=JSON.stringify({status:x.broker.status,receipts:x.receipts});
 assert.equal(json.includes(ROOM),false);
 assert.equal(json.includes(TOKEN),false);
 assert.equal(json.includes(signed.signature),false);
});
