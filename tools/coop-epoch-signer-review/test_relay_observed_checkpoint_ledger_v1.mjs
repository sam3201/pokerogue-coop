import test from "node:test";
import assert from "node:assert/strict";
import {RelayObservedCheckpointLedger,extractForwardedCheckpoint,SCHEMA}
 from "./relay_observed_checkpoint_ledger_v1.mjs";
const RUN="12345678-1234-4123-8123-123456789abc";
const ROOM="opaque_internal_room_ref";
const cp=(index=0,override={})=>({
 index,kind:index===0?"waveStart":"turn",
 wave:1,turn:index,phaseName:"CommandPhase",
 hash:"0123456789abcd",...override
});
const wire=(seat,index=0,n=1,override={})=>JSON.stringify({
 n,b:{kind:"CHECKPOINT",key:null,author:seat,
   payload:cp(index,override)}
});
const make=()=>new RelayObservedCheckpointLedger({runId:RUN,roomHandle:ROOM});
test("wire-format extraction recognizes actual reliable {n,b} CHECKPOINT",()=>{
 const parsed=extractForwardedCheckpoint("host",wire("host",0,11));
 assert.equal(parsed.n,11);
 assert.equal(parsed.epoch,0);
 assert.deepEqual(parsed.checkpoint,cp());
 assert.equal(extractForwardedCheckpoint("guest",wire("host",0,11)),null);
 assert.equal(extractForwardedCheckpoint("host",JSON.stringify({a:5,s:[]})),null);
 assert.equal(extractForwardedCheckpoint("host",JSON.stringify({v:{kind:"CHECKPOINT"}})),null);
});
test("relay-forwarded identical host and guest checkpoint yields bounded receipt",()=>{
 const log=make();
 const first=log.observeForwarded({seat:"host",text:wire("host",0,5)});
 assert.equal(first.status,"pending");
 const next=log.observeForwarded({seat:"guest",text:wire("guest",0,7)});
 assert.equal(next.status,"matched");
 assert.equal(next.receipt.schema,SCHEMA);
 assert.equal(next.receipt.checkpoint.hash,"0123456789abcd");
 assert.equal(next.receipt.gameStateIndependentlyVerified,false);
 assert.equal(next.receipt.productionSceneEligible,false);
 assert.equal(next.receipt.relayObserved,true);
 assert.equal(log.status.lastCompleted,0);
 assert.equal(JSON.stringify(next).includes(ROOM),false);
});
test("a second sequential consensus extends a content-addressed transcript",()=>{
 const log=make();
 log.observeForwarded({seat:"host",text:wire("host",0,3)});
 const first=log.observeForwarded({seat:"guest",text:wire("guest",0,9)});
 log.observeForwarded({seat:"guest",text:wire("guest",1,12)});
 const second=log.observeForwarded({seat:"host",text:wire("host",1,14)});
 assert.equal(second.status,"matched");
 assert.equal(log.status.count,2);
 assert.notEqual(first.receipt.transcriptDigest,second.receipt.transcriptDigest);
 assert.equal(log.receipts().length,2);
});
test("checkpoint mismatch rejects the room, never promotes consensus",()=>{
 const log=make();
 log.observeForwarded({seat:"host",text:wire("host",0,1)});
 const mismatch=log.observeForwarded({seat:"guest",text:wire("guest",0,1,
   {hash:"ffffffffffffff"})});
 assert.equal(mismatch.status,"rejected");
 assert.equal(mismatch.reason,"host and guest checkpoint mismatch");
 assert.equal(log.status.rejected,true);
 assert.equal(log.status.count,0);
 assert.equal(log.observeForwarded({seat:"host",text:wire("host",1,2)}).status,"rejected");
});
test("unforwarded, cosmetic, invalid and unrelated wire frames ignored",()=>{
 const log=make();
 const a=wire("host");
 assert.equal(log.observeForwarded({seat:"host",text:a,forwarded:false}).status,"ignored");
 assert.equal(log.observeForwarded({seat:"host",text:"not-json"}).status,"ignored");
 assert.equal(log.observeForwarded({seat:"host",
   text:JSON.stringify({n:1,b:{kind:"COSMETIC",author:"host"}})}).status,"ignored");
 assert.equal(log.observeForwarded({seat:"host",text:"a".repeat(4500)}).status,"ignored");
 assert.equal(log.status.unpaired,0);
});
test("same reliable-frame retransmission ignored but conflicting replay rejects",()=>{
 const log=make(),host=wire("host",0,1);
 log.observeForwarded({seat:"host",text:host});
 assert.equal(log.observeForwarded({seat:"host",text:host}).reason,"retransmission");
 const conflict=log.observeForwarded({seat:"host",text:wire("host",0,1,
  {hash:"eeeeeeeeeeeeee"})});
 assert.equal(conflict.status,"rejected");
 assert.equal(log.status.count,0);
});
test("missing checkpoint index or epoch reset is refused",()=>{
 const log=make();
 const missing=log.observeForwarded({seat:"host",text:wire("host",2,10)});
 assert.equal(missing.reason,"checkpoint index missing, repeated or out of order");
 const other=make();
 other.observeForwarded({seat:"host",text:wire("host",0,1)});
 const epoch=JSON.stringify({
  n:2,b:{kind:"CHECKPOINT",key:null,author:"host",epoch:1,payload:cp(1)}
 });
 assert.equal(other.observeForwarded({seat:"host",text:epoch}).reason,
  "epoch changed without rebind");
});
test("unpaired memory is bounded; mismatch blocks incomplete pair",()=>{
 const log=new RelayObservedCheckpointLedger({
  runId:RUN,roomHandle:ROOM,maxPending:2});
 log.observeForwarded({seat:"host",text:wire("host",0,1)});
 log.observeForwarded({seat:"host",text:wire("host",1,2)});
 const rejected=log.observeForwarded({seat:"host",text:wire("host",2,3)});
 assert.equal(rejected.reason,"unpaired checkpoint budget exhausted");
 assert.equal(log.status.rejected,true);
});
test("current snapshot contains no raw text, socket tokens or room codes",()=>{
 const log=make();
 const raw=wire("host",0,1),other=wire("guest",0,1);
 log.observeForwarded({seat:"host",text:raw});
 const match=log.observeForwarded({seat:"guest",text:other});
 const encoded=JSON.stringify({status:log.status,match,receipts:log.receipts()});
 assert.equal(encoded.includes(ROOM),false);
 assert.equal(encoded.includes('"n":1'),false);
 assert.equal(encoded.includes("seat-token"),false);
});
test("live room teardown prevents reusing old evidence",()=>{
 const log=make();
 log.observeForwarded({seat:"host",text:wire("host",0,1)});
 log.close();
 assert.equal(log.status.closed,true);
 assert.equal(log.status.unpaired,0);
 assert.equal(log.observeForwarded({seat:"guest",text:wire("guest",0,1)}).status,"rejected");
});
test("only trusted adapter supplied seats may contribute, no forged author",()=>{
 const log=make();
 assert.equal(log.observeForwarded({seat:"host",text:wire("guest",0,1)}).status,"ignored");
 const text=JSON.stringify({n:1,b:{kind:"CHECKPOINT",key:null,author:"host",
  payload:{...cp(),roomCode:"EXPOSE"}}});
 assert.equal(log.observeForwarded({seat:"host",text}).status,"ignored");
 assert.equal(log.status.count,0);
});

test("long sessions retain only 128 recent receipts while count and chain continue",()=>{
 const log=make();
 let firstDigest=null,lastDigest=null;
 for(let i=0;i<135;i++){
  log.observeForwarded({seat:"host",text:wire("host",i,i+1)});
  const result=log.observeForwarded({seat:"guest",text:wire("guest",i,i+1)});
  assert.equal(result.status,"matched");
  if(i===0)firstDigest=result.receipt.transcriptDigest;
  lastDigest=result.receipt.transcriptDigest;
 }
 assert.equal(log.status.count,135);
 assert.equal(log.status.lastCompleted,134);
 assert.equal(log.receipts().length,128);
 assert.equal(log.receipts()[0].index,7);
 assert.notEqual(firstDigest,lastDigest);
});
test("returned receipt is deeply immutable and cannot corrupt the rolling proof",()=>{
 const log=make();
 log.observeForwarded({seat:"host",text:wire("host",0,1)});
 const result=log.observeForwarded({seat:"guest",text:wire("guest",0,1)});
 assert.equal(Object.isFrozen(result.receipt),true);
 assert.equal(Object.isFrozen(result.receipt.checkpoint),true);
 assert.throws(()=>{result.receipt.checkpoint.hash="ffffffffffffff";});
 assert.equal(log.receipts()[0].checkpoint.hash,"0123456789abcd");
});

test("parsing assumptions remain aligned with the actual game transport",async()=>{
 const {readFileSync}=await import("node:fs");
 const reliable=readFileSync(new URL("../../src/coop/transport/reliable.ts",
   import.meta.url),"utf8");
 const protocol=readFileSync(new URL("../../src/coop/protocol.ts",
   import.meta.url),"utf8");
 const kinds=readFileSync(new URL("../../src/coop/checkpoint-log.ts",
   import.meta.url),"utf8");
 assert.match(reliable,/JSON\.stringify\(\{\s*n,\s*b:\s*message\s*\}\)/);
 assert.match(reliable,/"n"\]\s*\)\s*&&\s*"b"\s+in\s+frame/);
 assert.ok(protocol.includes('env["kind"] === "SEQUENCED"'));
 assert.ok(protocol.includes("/^[0-9a-f]{14}$/"));
 for(const kind of ["turn","waveStart","waveEnd","rewards"])
  assert.ok(kinds.includes('"'+kind+'"'));
});
