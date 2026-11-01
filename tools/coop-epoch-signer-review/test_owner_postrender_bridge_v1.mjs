import test from "node:test";
import assert from "node:assert/strict";
import {capturePostrenderSeat} from "./owner_postrender_bridge_v1.mjs";
const HASH="a".repeat(64),SRC="/* PRIVATE PROBE */".repeat(12);
const scene={schema:"sam.coop.phaser-sprites.probe.v1",
 visualScope:"partial-original-sprites",labOnly:false,
 camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
 commands:[],coverage:{inspected:0,captured:0,complete:true,
 skipped:{},approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
 truncated:false}};
function fake({screenshotError=false,evalError=false,frameTick=42,
  hold=false,leaseChanged=false}={}){
 const calls=[],pause={};
 let done;
 pause.promise=new Promise(r=>done=r);pause.release=done;
 const page={
  calls,pause,
  async evaluate(_fn,arg){
   calls.push(["evaluate",arg]);
   if(arg.source){
    if(evalError)throw Error("postrender timed out");
    if(hold)await pause.promise;
    return {postrender:true,frameTick,scene};
   }
   if(Object.hasOwn(arg,"frameTick")){
    calls.push(["verify-lease",arg.frameTick]);
    return !leaseChanged&&arg.frameTick===frameTick;
   }
   calls.push(["resume"]);
  },
  async screenshot(){
   calls.push(["screenshot"]);
   if(screenshotError)throw Error("screenshot error");
   return Buffer.from("png");
  }
 };
 return page;
}
test("postrender seat captures scene and image then always resumes",async()=>{
 const p=fake();
 const result=await capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC});
 assert.equal(result.seat,"sam");
 assert.equal(result.postrender,true);
 assert.equal(result.frameTick,42);
 assert.equal(result.relayCommitHash,HASH);
 assert.equal(result.scene.schema,scene.schema);
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
 assert.ok(p.calls.findIndex(x=>x[0]==="screenshot")<
   p.calls.findIndex(x=>x[0]==="resume"));
});
test("screenshot rejects a changed render lease before returning evidence",async()=>{
 const p=fake({leaseChanged:true});
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC
 }),/lease changed/);
 assert.equal(p.calls.filter(x=>x[0]==="verify-lease").length,1);
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
test("screenshot exception still invokes the unfreeze handshake",async()=>{
 const p=fake({screenshotError:true});
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"jevbot",relayCommitHash:HASH,captureSource:SRC}),
  /screenshot error/);
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
test("postrender deadline error still invokes cleanup",async()=>{
 const p=fake({evalError:true});
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC}));
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
test("same-page overlapping captures are rejected",async()=>{
 const p=fake({hold:true});
 const first=capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC});
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"jevbot",relayCommitHash:HASH,captureSource:SRC}),
  /Concurrent capture/);
 p.pause.release();
 await first;
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
test("pre-aborted capture does not use browser page",async()=>{
 const p=fake(),abort=new AbortController();abort.abort();
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC,
  signal:abort.signal}),/canceled/);
 assert.equal(p.calls.length,0);
});
test("capture abort after freeze still unfreezes",async()=>{
 const p=fake({hold:true}),abort=new AbortController();
 const promise=capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC,
  signal:abort.signal});
 abort.abort();p.pause.release();
 await assert.rejects(promise,/canceled/);
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
test("bad caller arguments fail without page side effects",async()=>{
 const p=fake();
 for(const x of [{seat:"observer"},{relayCommitHash:"wrong"},
   {captureSource:"x"},{timeoutMs:60000}]){
  await assert.rejects(capturePostrenderSeat({
   page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC,...x}));
 }
 assert.equal(p.calls.length,0);
});
test("invalid postrender frame does not trigger screenshot",async()=>{
 const p=fake({frameTick:0});
 await assert.rejects(capturePostrenderSeat({
  page:p,seat:"sam",relayCommitHash:HASH,captureSource:SRC}),
  /Invalid Phaser capture callback/);
 assert.equal(p.calls.filter(x=>x[0]==="screenshot").length,0);
 assert.equal(p.calls.filter(x=>x[0]==="resume").length,1);
});
