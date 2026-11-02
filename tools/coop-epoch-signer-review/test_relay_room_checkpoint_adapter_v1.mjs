import test from "node:test";
import assert from "node:assert/strict";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
const RUN="12345678-1234-4123-8123-123456789abc",ROOM="ABC234";
const cp=(index=0)=>({index,kind:"turn",wave:1,turn:index,
 phaseName:"CommandPhase",hash:"0123456789abcd"});
const wire=(seat,index=0,n=1,override={})=>JSON.stringify({
 n,b:{key:null,author:seat,kind:"CHECKPOINT",payload:{...cp(index),...override}}
});
test("relay-owner binding pairs forwarded host/guest checkpoints without raw output",()=>{
 const receipts=[],observer=new PrivateRelayRoomObserver({
  onReceipt:r=>receipts.push(r)
 });
 assert.deepEqual(observer.registerRoom({roomHandle:ROOM,runId:RUN}),
   {runId:RUN,registered:true});
 observer.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",
   text:wire("host",0,17)});
 const match=observer.onForwardedCheckpoint({roomHandle:ROOM,seat:"guest",
   text:wire("guest",0,19)});
 assert.equal(match.status,"matched");
 assert.equal(match.receipt.runId,RUN);
 assert.equal(match.receipt.stateHashOrigin,"both-clients");
 assert.equal(observer.status.matched,1);
 assert.equal(receipts.length,1);
 assert.equal(JSON.stringify(match).includes(ROOM),false);
 assert.equal(JSON.stringify(observer.status).includes(ROOM),false);
 assert.equal(match.receipt.productionSceneEligible,false);
});
test("only relay-registered run and actual room can contribute",()=>{
 const observer=new PrivateRelayRoomObserver();
 const missing=observer.onForwardedCheckpoint({roomHandle:ROOM,
  seat:"host",text:wire("host",0,1)});
 assert.equal(missing.reason,"unregistered room");
 assert.equal(observer.status.activeRooms,0);
 assert.throws(()=>observer.registerRoom({roomHandle:"INVALID",
  runId:RUN}),/Invalid trusted/);
 observer.registerRoom({roomHandle:ROOM,runId:RUN});
 assert.throws(()=>observer.registerRoom({roomHandle:ROOM,runId:RUN}),
  /already registered/);
 assert.equal(observer.status.activeRooms,1);
});
test("owner callback failure cannot affect synchronous relay forwarding",()=>{
 let calls=0;
 const observer=new PrivateRelayRoomObserver({
  onReceipt:()=>{calls++;throw Error("local output offline");}
 });
 observer.registerRoom({roomHandle:ROOM,runId:RUN});
 observer.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",
  text:wire("host",0,1)});
 assert.doesNotThrow(()=>observer.onForwardedCheckpoint({
  roomHandle:ROOM,seat:"guest",text:wire("guest",0,1)}));
 assert.equal(calls,1);
 assert.equal(observer.status.matched,1);
});
test("divergent client state remains rejected and nonpublishable",()=>{
 const observer=new PrivateRelayRoomObserver();
 observer.registerRoom({roomHandle:ROOM,runId:RUN});
 observer.onForwardedCheckpoint({roomHandle:ROOM,seat:"host",
  text:wire("host",0,1)});
 const rejected=observer.onForwardedCheckpoint({roomHandle:ROOM,
  seat:"guest",text:wire("guest",0,1,{hash:"ffffffffffffff"})});
 assert.equal(rejected.status,"rejected");
 assert.equal(observer.status.rejected,1);
 assert.equal(observer.status.productionSceneEligible,false);
});
test("teardown and room caps prevent stale socket evidence",()=>{
 const observer=new PrivateRelayRoomObserver({maxRooms:1});
 observer.registerRoom({roomHandle:ROOM,runId:RUN});
 assert.throws(()=>observer.registerRoom({roomHandle:"XYZ234",
  runId:RUN}),/room limit/);
 assert.equal(observer.unregisterRoom(ROOM),true);
 assert.equal(observer.unregisterRoom(ROOM),false);
 assert.equal(observer.onForwardedCheckpoint({roomHandle:ROOM,
  seat:"host",text:wire("host",0,1)}).status,"ignored");
 observer.registerRoom({roomHandle:"XYZ234",runId:RUN});
 assert.equal(observer.status.activeRooms,1);
});
