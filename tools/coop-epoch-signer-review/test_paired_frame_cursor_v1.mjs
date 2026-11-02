import test from "node:test";
import assert from "node:assert/strict";
import {VerifiedPairCursor} from "./paired_frame_cursor_v1.mjs";
const run="12345678-1234-4123-8123-123456789abc";
const other="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const make=(sequence,runId=run)=>{
 const frameId=runId+":"+sequence;
 return {scope:"private-staging-only",runId,sequence,frameId,
  seats:{sam:{frameId,view:"sam"},
    jevbot:{frameId,view:"jevbot"}},
  textures:new Map([["/images/approved-sha256/test.png",new Uint8Array([1,2,3])]])};
};
test("manual cursor remains at step 0 until complete paired commit",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 assert.deepEqual(c.status.step,0);
 await c.stage(make(9));
 assert.equal(c.status.step,0);
 assert.equal(c.status.queued,1);
 assert.equal(c.status.frameId,null);
 assert.equal(c.nextReady().frameId,run+":9");
 const committed=c.commitNext(run+":9");
 assert.equal(committed.step,1);
 assert.equal(committed.seats.sam.frameId,committed.seats.jevbot.frameId);
 assert.equal(c.status.queued,0);
 assert.equal(c.status.frameId,run+":9");
});
test("two verified commits advance one paired frame per button press",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(100));
 await c.stage(make(101));
 assert.equal(c.status.step,0);
 const f1=c.commitNext(run+":100");
 assert.equal(f1.step,1);
 assert.equal(f1.frameId,run+":100");
 assert.equal(c.status.queued,1);
 const f2=c.commitNext(run+":101");
 assert.equal(f2.step,2);
 assert.equal(f2.previousFrameId,run+":100");
 assert.equal(f2.seats.sam.frameId,f2.seats.jevbot.frameId);
});
test("stale, cross-seat, missing-frame and cross-run input does not queue",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(4));
 for(const candidate of [make(4),make(6),make(5,other),
  {...make(5),frameId:"bogus"},
  {...make(5),seats:{sam:{},jevbot:null}}]){
  await assert.rejects(c.stage(candidate));
  assert.equal(c.status.queued,1);
 }
 assert.equal(c.nextReady().frameId,run+":4");
});
test("invalid commit never consumes the ready pair",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(1));
 assert.throws(()=>c.commitNext(run+":2"));
 assert.equal(c.status.step,0);
 assert.equal(c.status.queued,1);
 c.commitNext(run+":1");
 assert.throws(()=>c.commitNext(run+":1"));
 assert.equal(c.status.step,1);
});
test("verification failure and pending stage do not advance the display",async()=>{
 let resolve;
 const c=new VerifiedPairCursor({verifier:()=>new Promise(r=>resolve=r)});
 const waiting=c.stage(make(1));
 assert.equal(c.status.waiting,true);
 await assert.rejects(c.stage(make(2)),/Concurrent/);
 assert.equal(c.nextReady(),null);
 resolve(make(1));
 await waiting;
 assert.equal(c.status.waiting,false);
 assert.equal(c.status.step,0);
 assert.equal(c.status.queued,1);
});
test("buffer capacity and explicit reset protect against future run reuse",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 for(let i=1;i<=4;i++)await c.stage(make(i));
 await assert.rejects(c.stage(make(5)),/buffer full/);
 assert.throws(()=>c.commitNext(run+":5"));
 assert.equal(c.status.queued,4);
 c.reset();
 assert.deepEqual([c.status.step,c.status.queued,c.status.runId],[0,0,null]);
 await c.stage(make(1,other));
 assert.equal(c.nextReady().frameId,other+":1");
});
test("oversized verified scene bundle is not accepted into cursor",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 const a=make(1);
 a.textures=new Map([["approved",new Uint8Array(16*1024*1024+1)]]);
 await assert.rejects(c.stage(a),/memory budget/);
 assert.equal(c.status.queued,0);
});

test("staged verified data cannot be mutated after admission or via nextReady",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 const original=make(12);
 await c.stage(original);
 original.frameId=run+":8888";
 original.seats.sam.frameId=run+":8888";
 original.textures.values().next().value[0]=77;
 const first=c.nextReady();
 assert.equal(first.frameId,run+":12");
 assert.equal(first.seats.sam.frameId,run+":12");
 assert.equal(first.textures.values().next().value[0],1);
 first.seats.jevbot.frameId=run+":1000";
 first.textures.values().next().value[1]=99;
 const second=c.nextReady();
 assert.equal(second.seats.jevbot.frameId,run+":12");
 assert.deepEqual([...second.textures.values().next().value],[1,2,3]);
 const committed=c.commitNext(run+":12");
 assert.equal(committed.seats.sam.frameId,run+":12");
 committed.seats.jevbot.frameId="external mutation";
 assert.equal(c.status.frameId,run+":12");
});


test("discardPending leaves last committed pair visible and permits same sequence retry",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(1));
 const first=c.nextReady();
 c.commitNext(first.frameId,first.admissionId);
 await c.stage(make(2));
 const rejected=c.nextReady();
 const discarded=c.discardPending(rejected.frameId,rejected.admissionId);
 assert.equal(discarded.frameId,run+":1");
 assert.equal(discarded.step,1);
 assert.equal(discarded.queued,0);
 assert.equal(discarded.stagedThrough,1);
 assert.equal(c.nextReady(),null);
 await c.stage(make(2));
 const retried=c.nextReady();
 assert.equal(retried.frameId,rejected.frameId);
 assert.ok(retried.admissionId>rejected.admissionId);
 assert.throws(()=>c.commitNext(retried.frameId,rejected.admissionId),/stale/);
 c.commitNext(retried.frameId,retried.admissionId);
 assert.equal(c.status.step,2);
});
test("discarding the initial uncommitted frame keeps no run pinned",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(1));
 const ready=c.nextReady();
 const s=c.discardPending(ready.frameId,ready.admissionId);
 assert.equal(s.runId,null);
 assert.equal(s.stagedThrough,0);
 assert.equal(s.step,0);
 await c.stage(make(1,other));
 assert.equal(c.nextReady().frameId,other+":1");
});
test("discard requires exact admission and cannot drop an arbitrary queued head",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 await c.stage(make(5));
 const ready=c.nextReady();
 assert.throws(()=>c.discardPending(ready.frameId,ready.admissionId+1),/Stale/);
 assert.throws(()=>c.discardPending(run+":999",ready.admissionId),/Stale/);
 assert.equal(c.status.queued,1);
 await c.stage(make(6));
 assert.throws(()=>c.discardPending(ready.frameId,ready.admissionId),/Exactly one/);
 assert.equal(c.status.queued,2);
});
test("discard is forbidden during unfinished verification",async()=>{
 let unblock;
 const c=new VerifiedPairCursor({verifier:()=>new Promise(resolve=>unblock=resolve)});
 const pending=c.stage(make(1));
 assert.throws(()=>c.discardPending(run+":1",1),/Exactly one/);
 unblock(make(1));
 await pending;
 const a=c.nextReady();
 c.discardPending(a.frameId,a.admissionId);
 assert.equal(c.status.queued,0);
});


test("signed byte-frame pixel payloads count toward the cursor memory budget",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 const oversized=make(1);
 oversized.seats.sam.pixels=new Uint8Array(9*1024*1024);
 oversized.seats.jevbot.pixels=new Uint8Array(9*1024*1024);
 await assert.rejects(c.stage(oversized),/Frame memory budget/);
 assert.equal(c.status.queued,0);
 assert.equal(c.status.runId,null);
 const small=make(1);
 small.seats.sam.pixels=new Uint8Array(320*180*4);
 small.seats.jevbot.pixels=new Uint8Array(320*180*4);
 await c.stage(small);
 assert.equal(c.status.queued,1);
 small.seats.sam.pixels[0]=77;
 assert.equal(c.nextReady().seats.sam.pixels[0],0);
});
test("signed byte-frame payload requires an ordinary copied byte array",async()=>{
 const c=new VerifiedPairCursor({verifier:async x=>x});
 const invalid=make(1);
 invalid.seats.sam.pixels={byteLength:320*180*4};
 await assert.rejects(c.stage(invalid),/Unsupported signed seat pixel/);
 assert.equal(c.status.queued,0);
});
