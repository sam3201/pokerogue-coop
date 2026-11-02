import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {createCaptureOwnerRoomEnrollment} from "./capture_owner_room_enrollment_v1.mjs";
import {PrivateRoomGrantBroker,issuePrivateRoomGrant}
 from "./owner_room_grant_broker_v1.mjs";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";

const RUN="12345678-1234-4123-8123-123456789abc";
const ROOM="ABC234";
const TOKEN="12".repeat(16);
const sha=s=>createHash("sha256").update(s).digest("hex");

function fixture({alterSigner=null,alterRelay=null}={}){
 let time=1730000000000;
 const key=generateKeyPairSync("ed25519");
 const observer=new PrivateRelayRoomObserver();
 const broker=new PrivateRoomGrantBroker({
  pinnedOwnerKey:key.publicKey,observer,now:()=>time
 });
 const identity={roomHandle:ROOM,hostSeatToken:TOKEN};
 const created=broker.onRoomCreated({
  roomHandle:ROOM,hostTokenDigest:sha(TOKEN)
 });
 const calls=[];
 const relay=async request=>{
  calls.push(request.op);
  if(alterRelay)return alterRelay(request,{broker,created,time},()=>relayBase(request));
  return relayBase(request);
 };
 function relayBase(request){
  if(request.op==="challenge")
   return request.roomHandle===ROOM&&request.hostTokenDigest===sha(TOKEN)
    ? {ok:true,challenge:created.challenge,expiresAt:created.expiresAt}
    : {ok:false};
  if(request.op==="authorize")return {ok:broker.authorize(request.grant)};
  throw Error("Unknown operation");
 }
 const signer=async req=>{
  calls.push("sign_room_grant");
  if(alterSigner)return alterSigner(req);
  const p=req.payload;
  return {ok:true,grant:issuePrivateRoomGrant({
   roomHandle:p.roomHandle,runId:p.runId,challenge:p.challenge,
   hostSeatToken:TOKEN,issuedAt:p.issuedAt,expiresAt:p.expiresAt,
   signingKey:key.privateKey
  })};
 };
 const owner=createCaptureOwnerRoomEnrollment({
  runId:RUN,relayRequest:relay,signerRequest:signer,now:()=>time
 });
 return {owner,identity,calls,broker,observer,advance:ms=>{time+=ms;}};
}

test("1: real broker accepts enrolled owner run with private signer",async()=>{
 const f=fixture();
 const result=await f.owner.enroll(f.identity);
 assert.equal(result.status,"diagnostic-room-bound");
 assert.equal(result.runId,RUN);
 assert.equal(result.productionSceneEligible,false);
 assert.equal(result.captureWorkerAuthenticated,false);
 assert.equal(result.sceneEpochAttested,false);
 assert.deepEqual(f.calls,["challenge","sign_room_grant","authorize"]);
 assert.equal(f.broker.status.authorized,1);
 assert.equal(JSON.stringify(result).includes(TOKEN),false);
 assert.equal(JSON.stringify(result).includes(ROOM),false);
});

test("2: wrong host token cannot obtain another room challenge",async()=>{
 const f=fixture();
 await assert.rejects(f.owner.enroll({...f.identity,
  hostSeatToken:"aa".repeat(16)}),/challenge unavailable/);
 assert.deepEqual(f.calls,["challenge"]);
 assert.equal(f.broker.status.authorized,0);
});

test("3: invalid room and token fail before any IPC",async()=>{
 const f=fixture();
 await assert.rejects(f.owner.enroll({roomHandle:"bad",hostSeatToken:TOKEN}),/Invalid host/);
 assert.deepEqual(f.calls,[]);
 const g=fixture();
 await assert.rejects(g.owner.enroll({roomHandle:ROOM,hostSeatToken:"unsafe"}),/Invalid host/);
 assert.deepEqual(g.calls,[]);
});

test("4: signer failure forbids relay authorization",async()=>{
 const f=fixture({alterSigner:()=>({ok:false})});
 await assert.rejects(f.owner.enroll(f.identity),/Signer refused/);
 assert.deepEqual(f.calls,["challenge","sign_room_grant"]);
 assert.equal(f.broker.status.authorized,0);
});

test("5: altered signer payload fails locally, without authorization",async()=>{
 const f=fixture({alterSigner:req=>({ok:true,grant:{
  schema:"sam.coop.owner-room-grant.v1",keyId:"a".repeat(64),
  payload:{...req.payload,runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
  signature:"A".repeat(86)
 }})});
 await assert.rejects(f.owner.enroll(f.identity),/Signer refused/);
 assert.deepEqual(f.calls,["challenge","sign_room_grant"]);
});

test("6: signer grant expiry before relay check fails closed",async()=>{
 let advance;
 const f=fixture({alterSigner:req=>{
  advance();
  const p=req.payload;
  return {ok:true,grant:issuePrivateRoomGrant({
   roomHandle:p.roomHandle,runId:p.runId,challenge:p.challenge,
   hostSeatToken:TOKEN,issuedAt:p.issuedAt,expiresAt:p.expiresAt,
   signingKey:generateKeyPairSync("ed25519").privateKey
  })};
 }});
 advance=()=>f.advance(5000);
 await assert.rejects(f.owner.enroll(f.identity),/expired before relay/);
 assert.deepEqual(f.calls,["challenge","sign_room_grant"]);
});

test("7: premature checkpoint prevents late room binding",async()=>{
 const f=fixture();
 const cp=JSON.stringify({n:1,b:{kind:"CHECKPOINT",author:"host",key:null,
  payload:{index:0,kind:"turn",wave:1,turn:0,phaseName:"CommandPhase",
   hash:"0123456789abcd"}}});
 f.broker.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",text:cp});
 await assert.rejects(f.owner.enroll(f.identity),/Relay rejected/);
 assert.equal(f.broker.status.authorized,0);
});

test("8: enrollment cannot be retried after success or failure",async()=>{
 const good=fixture();await good.owner.enroll(good.identity);
 await assert.rejects(good.owner.enroll(good.identity),/already attempted/);
 const bad=fixture({alterSigner:()=>({ok:false})});
 await assert.rejects(bad.owner.enroll(bad.identity),/Signer refused/);
 await assert.rejects(bad.owner.enroll(bad.identity),/already attempted/);
});

test("9: concurrent enrollment calls cannot reuse owner lease",async()=>{
 const f=fixture();
 const pending=f.owner.enroll(f.identity);
 await assert.rejects(f.owner.enroll(f.identity),/already attempted/);
 await pending;
 assert.equal(f.broker.status.authorized,1);
});

test("10: malformed challenge or denial never reaches signer",async()=>{
 const f=fixture({alterRelay:req=>req.op==="challenge"?
  {ok:true,challenge:"short",expiresAt:1730000005000}:{ok:false}});
 await assert.rejects(f.owner.enroll(f.identity),/challenge unavailable/);
 assert.deepEqual(f.calls,["challenge"]);
});

test("11: malformed enrollment config fails",()=>{
 assert.throws(()=>createCaptureOwnerRoomEnrollment({
  runId:"not-uuid",relayRequest:async()=>({}),signerRequest:async()=>({})
 }),/Invalid trusted/);
});

test("12: transport failure propagates without retry",async()=>{
 const f=fixture({alterRelay:()=>{throw Error("transport unavailable");}});
 await assert.rejects(f.owner.enroll(f.identity),/transport unavailable/);
 assert.deepEqual(f.calls,["challenge"]);
});
