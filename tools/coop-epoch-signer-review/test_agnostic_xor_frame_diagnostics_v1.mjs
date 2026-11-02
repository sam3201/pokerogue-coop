import test from "node:test";
import assert from "node:assert/strict";
import {scanAgnosticXorFrame,PrivateAgnosticXorPairTracker,XOR_SCHEMA}
 from "./agnostic_xor_frame_diagnostics_v1.mjs";
const run="12345678-1234-4123-8123-123456789abc";
const other="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rgba=(bytes,width=2,height=1)=>({data:bytes,width,height,channels:4});
const pair=(sequence,admissionId,sam,jevbot,runId=run)=>({
  runId,sequence,admissionId,frameId:runId+":"+sequence,
  images:{sam:rgba(sam),jevbot:rgba(jevbot)}});

test("agnostic byte views report exact XOR changes and popcount",()=>{
 const a=Uint8Array.from([0,10,0,255,1,1,1,255]);
 const b=Uint8Array.from([1,11,0,255,1,1,1,255]);
 const result=scanAgnosticXorFrame({before:rgba(a),
  after:rgba(new DataView(b.buffer)) ,tileSize:8});
 assert.equal(result.schema,XOR_SCHEMA);
 assert.equal(result.changedPixels,1);
 assert.equal(result.changedChannelBytes,2);
 assert.equal(result.flippedBits,2);
 assert.deepEqual(result.firstChangedPixel,{x:0,y:0});
 assert.deepEqual([...result.dirtyTileMask],[1]);
 assert.equal(result.dirtyTileCount,1);
 assert.equal(result.productionSceneEligible,false);
 assert.equal(result.issuerAuthenticated,false);
});

test("XOR reductions can cancel; full-byte scan still detects both modifications",()=>{
 const a=Uint8Array.from([0,0]);
 const b=Uint8Array.from([1,1]);
 assert.equal((a[0]^b[0])^(a[1]^b[1]),0,
  "a folded one-byte XOR is not a secure digest");
 const result=scanAgnosticXorFrame({
  before:{data:a,width:2,height:1,channels:1},
  after:{data:b,width:2,height:1,channels:1}});
 assert.equal(result.changedPixels,2);
 assert.equal(result.flippedBits,2);
 assert.equal(result.identicalPixels,false);
});

test("row-stride padding is ignored while real pixels are compared",()=>{
 const before={data:Uint8Array.from([
  1,2,3,4,7,8,9,10,88,89,
  4,3,2,1,9,8,7,6,88,89
 ]),width:2,height:2,channels:4,strideBytes:10};
 const after={data:Uint8Array.from([
  1,2,3,4,7,8,9,10,
  4,3,2,1,9,8,7,6
 ]),width:2,height:2,channels:4};
 const equal=scanAgnosticXorFrame({before,after,tileSize:8});
 assert.equal(equal.identicalPixels,true);
 assert.equal(equal.changedPixels,0);
});

test("tile map pinpoints multiple changed quadrants without false dirty tiles",()=>{
 const n=32*32*4,a=new Uint8Array(n),b=new Uint8Array(n);
 b[(1*32+1)*4]=255;
 b[(31*32+31)*4+2]=0b11;
 const result=scanAgnosticXorFrame({
  before:{data:a,width:32,height:32},
  after:{data:b,width:32,height:32},tileSize:16});
 assert.equal(result.changedPixels,2);
 assert.equal(result.changedChannelBytes,2);
 assert.equal(result.flippedBits,10);
 assert.deepEqual([...result.dirtyTileMask],[1,0,0,1]);
 assert.equal(result.dirtyTileCount,2);
});

test("typed arrays, Buffer and offset views produce identical pixel results",()=>{
 const src=Uint8Array.from([100,20,30,255]);
 const storage=Uint8Array.from([55,...src,66]);
 const input={data:storage.subarray(1,5),width:1,height:1};
 const result=scanAgnosticXorFrame({before:input,
  after:{data:Buffer.from(src),width:1,height:1}});
 assert.equal(result.identicalPixels,true);
 const words=new Uint16Array(src.buffer.slice(0));
 const same=scanAgnosticXorFrame({before:input,
  after:{data:words,width:1,height:1}});
 assert.equal(same.identicalPixels,true);
});

test("invalid layout, overflow, shared buffers and missing geometry reject",()=>{
 for(const bad of [
  {data:[1,2,3,4],width:1,height:1},
  {data:new Uint8Array(4),width:1,height:1,strideBytes:3},
  {data:new Uint8Array(4),width:640,height:360},
  {data:new Uint8Array(4),width:1,height:1,channels:5},
  {data:new Uint8Array(4),width:1,height:1,strideBytes:4099}
 ])assert.throws(()=>scanAgnosticXorFrame({before:bad,after:rgba(new Uint8Array(8))}));
 assert.throws(()=>scanAgnosticXorFrame({
  before:rgba(new Uint8Array(8)),
  after:{data:new Uint8Array(4),width:1,height:1}}),/Incompatible/);
 if(typeof SharedArrayBuffer!=="undefined"){
  assert.throws(()=>scanAgnosticXorFrame({
   before:{data:new SharedArrayBuffer(4),width:1,height:1},
   after:{data:new Uint8Array(4),width:1,height:1}}),/non-shared/);
 }
});

test("two-phase diagnostic baseline advances ONLY after paired display commit",()=>{
 const t=new PrivateAgnosticXorPairTracker();
 const zeros=new Uint8Array(8),sam=Uint8Array.from([1,0,0,0,0,0,0,0]);
 const guest=Uint8Array.from([0,0,0,0,1,0,0,0]);
 const first=t.stage(pair(9,1,zeros,zeros));
 assert.equal(first.baselineAvailable,false);
 assert.equal(t.status.committedSequence,null);
 assert.throws(()=>t.commit({frameId:run+":9",admissionId:2}),/Stale/);
 t.discard();
 assert.equal(t.status.committedSequence,null);
 t.stage(pair(9,2,zeros,zeros));
 t.commit({frameId:run+":9",admissionId:2});
 assert.equal(t.status.committedSequence,9);
 const next=t.stage(pair(10,3,sam,guest));
 assert.equal(next.baselineAvailable,true);
 assert.equal(next.xor.sam.changedPixels,1);
 assert.equal(next.xor.jevbot.changedPixels,1);
 assert.equal(next.xor.bothDirtyTiles,1);
 assert.equal(next.xor.samOnlyDirtyTiles,0);
 assert.equal(next.xor.jevbotOnlyDirtyTiles,0);
 assert.equal(next.productionSceneEligible,false);
 assert.equal(t.status.committedSequence,9);
 t.commit({frameId:run+":10",admissionId:3});
 assert.equal(t.status.committedSequence,10);
});

test("later caller mutation cannot alter a staged diagnostic baseline",()=>{
 const t=new PrivateAgnosticXorPairTracker();
 const initial=new Uint8Array(8);
 t.stage(pair(1,1,initial,initial));
 initial[0]=255;
 t.commit({frameId:run+":1",admissionId:1});
 const next=t.stage(pair(2,2,new Uint8Array(8),new Uint8Array(8)));
 assert.equal(next.xor.sam.identicalPixels,true);
 assert.equal(next.xor.jevbot.identicalPixels,true);
});

test("cross-run, gap, repeated admission and pending replay fail closed",()=>{
 const t=new PrivateAgnosticXorPairTracker();
 const frame=new Uint8Array(8);
 t.stage(pair(9,1,frame,frame));
 assert.throws(()=>t.stage(pair(10,2,frame,frame)),/pending/);
 t.commit({frameId:run+":9",admissionId:1});
 assert.throws(()=>t.stage(pair(11,2,frame,frame)),/sequence/);
 assert.throws(()=>t.stage(pair(10,2,frame,frame,other)),/sequence/);
 t.reset();
 assert.throws(()=>t.stage(pair(1,1,frame,frame)),/admission/);
 const fresh=t.stage(pair(1,2,frame,frame,other));
 assert.equal(fresh.runId,other);
 t.reset();
 assert.equal(t.status.committedFrameId,null);
});

test("aligned word32 and unaligned bytewise XOR paths are exactly equivalent",()=>{
 const width=35,height=19,n=width*height*4;
 const before=Uint8Array.from({length:n},(_,i)=>(i*53+19)&255);
 const after=new Uint8Array(before);
 for(let i=0;i<after.length;i+=41)after[i]^=(i&7)+1;
 const aligned=scanAgnosticXorFrame({
  before:{data:before,width,height},
  after:{data:after,width,height},tileSize:8});
 assert.equal(aligned.scanMode,"packed-rgba-word32");
 const left=new Uint8Array(n+1),right=new Uint8Array(n+1);
 left.set(before,1);right.set(after,1);
 const unaligned=scanAgnosticXorFrame({
  before:{data:left.subarray(1),width,height},
  after:{data:right.subarray(1),width,height},tileSize:8});
 assert.equal(unaligned.scanMode,"bytewise-fallback");
 for(const field of ["changedPixels","changedChannelBytes",
  "flippedBits","dirtyTileCount","identicalPixels"])
  assert.equal(aligned[field],unaligned[field],field);
 assert.deepEqual(aligned.firstChangedPixel,unaligned.firstChangedPixel);
 assert.deepEqual([...aligned.dirtyTileMask],[...unaligned.dirtyTileMask]);
});
