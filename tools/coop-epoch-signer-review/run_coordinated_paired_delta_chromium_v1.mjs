// Isolated hosted Chromium acceptance for commit-only trusted byte-delta
// baselines. Disposable signing key, synthetic RGBA. Not a live relay.
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "@playwright/test";
import {encodeAgnosticXorDelta} from "./agnostic_xor_byte_delta_v1.mjs";
import {CHAINED_BYTE_FRAME_SCHEMA} from "./trusted_paired_delta_chain_v1.mjs";
const here=dirname(fileURLToPath(import.meta.url));
const origin="https://trusted-delta-chain-fixture.example.test";
const firstRun="12345678-1234-4123-8123-123456789abc";
const nextRun="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recoveryRun="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const width=320,height=180;
const keys=generateKeyPairSync("ed25519");
const pinnedSpki=[...keys.publicKey.export({format:"der",type:"spki"})];
const sha=x=>createHash("sha256").update(x).digest("hex");
function image(seq,seat){
 const bytes=new Uint8Array(width*height*4);
 for(let p=0;p<bytes.length;p+=4){
  bytes[p]=16;bytes[p+1]=28;bytes[p+2]=49;bytes[p+3]=255;
 }
 const x=(seq*(seat==="sam"?9:13))%(width-17);
 const y=(seq*(seat==="sam"?4:6))%(height-17);
 for(let j=0;j<16;j++)for(let i=0;i<16;i++){
  const p=((y+j)*width+x+i)*4;
  bytes[p]=seat==="sam"?212:89;
  bytes[p+1]=121;bytes[p+2]=222;bytes[p+3]=207;
 }
 return bytes;
}
async function signedSeat(runId,seq,seat){
 const before=seq===1?new Uint8Array(0):image(seq-1,seat);
 const after=image(seq,seat);
 const delta=await encodeAgnosticXorDelta({before,after});
 const statement={
  schema:CHAINED_BYTE_FRAME_SCHEMA,scope:"private-staging-only",
  runId,seat,sequence:seq,frameId:runId+":"+seq,
  kind:seq===1?"keyframe":"delta",
  baseSha256:sha(before),targetSha256:sha(after),byteLength:after.length
 };
 return {statement,
  signature:sign(null,Buffer.from(JSON.stringify(statement)),
   keys.privateKey).toString("base64url"),
  delta:{...delta,payload:[...delta.payload]}};
}
async function signedPair(runId,seq){
 return {sam:await signedSeat(runId,seq,"sam"),
  jevbot:await signedSeat(runId,seq,"jevbot")};
}
const modules=new Set([
 "trusted_paired_delta_chain_v1.mjs","agnostic_xor_byte_delta_v1.mjs",
 "paired_delta_transaction_controller_v1.mjs",
 "paired_frame_cursor_v1.mjs","paired_frame_presenter_v1.mjs",
 "browser_scene_pair_verify_v1.mjs","browser_asset_verify_v1.mjs"
]);
let browser;
try{
 browser=await chromium.launch({
  ...(process.env.SAM_SYNTHETIC_CHROME_PATH?{
   executablePath:process.env.SAM_SYNTHETIC_CHROME_PATH}:{}),
  headless:true,chromiumSandbox:process.env.SAM_SYNTHETIC_SANDBOX==="1",
  args:["--disable-dev-shm-usage","--disable-gpu"]});
 const ctx=await browser.newContext({viewport:{width:720,height:430}});
 await ctx.route("**/*",route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin)return route.abort();
  if(u.pathname==="/")return route.fulfill({status:200,
   contentType:"text/html",
   body:'<!DOCTYPE html><html><body><div id="pair-root"></div></body></html>'});
  const name=u.pathname.startsWith("/review/")?
   u.pathname.slice("/review/".length):null;
  if(!modules.has(name))return route.abort();
  return route.fulfill({status:200,contentType:"application/javascript",
   body:readFileSync(join(here,name),"utf8")});
 });
 const page=await ctx.newPage();
 await page.goto(origin+"/");
 await page.evaluate(async({firstRun,pinnedSpki,width,height})=>{
  const [{TrustedPairedByteDeltaReceiver},
   {PairedDeltaTransactionController}]=await Promise.all([
   import("/review/trusted_paired_delta_chain_v1.mjs"),
   import("/review/paired_delta_transaction_controller_v1.mjs")]);
  const receiver=new TrustedPairedByteDeltaReceiver({
   trustedRunId:firstRun,pinnedSpki:new Uint8Array(pinnedSpki)});
  let failSecondSeat=false,failReceiverCommit=false;
  const actualCommit=receiver.commit.bind(receiver);
  receiver.commit=args=>{
   if(failReceiverCommit){
    failReceiverCommit=false;
    throw Error("Injected receiver commit failure");
   }
   return actualCommit(args);
  };
  const root=document.getElementById("pair-root"),mutations=[];
  new MutationObserver(rs=>rs.forEach(r=>mutations.push({
   added:r.addedNodes.length,removed:r.removedNodes.length
  }))).observe(root,{childList:true});
  const controller=new PairedDeltaTransactionController({
   receiver,root,renderSeat:({seat,scene,frameId})=>{
    if(failSecondSeat&&seat==="jevbot")
     throw Error("Injected second-seat renderer failure");
    if(!(scene?.pixels instanceof Uint8Array)||
       scene.pixels.length!==width*height*4)
     throw Error("Missing verified decoded pixels");
    const canvas=document.createElement("canvas");
    canvas.width=width;canvas.height=height;
    canvas.dataset.seat=seat;canvas.dataset.frameId=frameId;
    canvas.getContext("2d").putImageData(new ImageData(
     new Uint8ClampedArray(scene.pixels),width,height),0,0);
    return canvas;
   }
  });
  window.__trustedChain={
   stage:wire=>controller.stage(wire),
   press:()=>controller.pressNext(),
   cancel:()=>controller.cancelPending(),
   failRenderer:value=>{failSecondSeat=value;},
   failCommitOnce:()=>{failReceiverCommit=true;},
   discardAndRecover(runId){
    controller.cancelPending();
    controller.recoverNewRun(runId);
    return receiver.status;
   },
   status(){
    const pane=root.firstElementChild;
    const sequence=receiver.status.committedSequence;
    const slots=pane?[...pane.children]:[];
    const images=slots.map(slot=>{
     const canvas=slot.firstElementChild;
     const seat=slot.dataset.seat;
     const x=(sequence*(seat==="sam"?9:13))%(width-17);
     const y=(sequence*(seat==="sam"?4:6))%(height-17);
     return {seat,frameId:slot.dataset.frameId,
      imageFrameId:canvas.dataset.frameId,
      sample:[...canvas.getContext("2d").getImageData(x,y,1,1).data]};
    });
    const c=controller.status;
    return {receiver:receiver.status,
     viewer:{step:c.visibleStep,ready:c.ready},controller:c,
     frameId:pane?.dataset.pairFrameId??null,images,
     visibleSeats:slots.length,mutations};
   }
  };
 },{firstRun,pinnedSpki,width,height});
 const stage=b=>page.evaluate(value=>window.__trustedChain.stage(value),b);
 const press=()=>page.evaluate(()=>window.__trustedChain.press());
 const read=()=>page.evaluate(()=>window.__trustedChain.status());
 let report=await read();
 assert.equal(report.visibleSeats,0);assert.equal(report.viewer.step,0);
 const keyframe=await signedPair(firstRun,1);
 const forged=structuredClone(keyframe);
 forged.sam.signature="A".repeat(86);
 await assert.rejects(stage(forged),/Untrusted signed/);
 const mismatched=structuredClone(keyframe);
 mismatched.jevbot=mismatched.sam;
 await assert.rejects(stage(mismatched),/identity invalid/);
 assert.equal((await read()).visibleSeats,0);
 await stage(keyframe);
 report=await read();
 assert.equal(report.receiver.committedSequence,null);
 assert.equal(report.viewer.step,0);
 await assert.rejects(stage(await signedPair(firstRun,2)),/Commit or discard/);
 const accepted1=await press();
 assert.equal(accepted1.sequence,1);
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.frameId,firstRun+":1");
 assert.deepEqual(report.images.map(v=>v.sample),[
  [212,121,222,207],[89,121,222,207]]);
 assert.deepEqual(report.mutations,[{added:1,removed:0}]);
 const dropped=await signedPair(firstRun,3);
 await assert.rejects(stage(dropped),/identity invalid/);
 const tampered=await signedPair(firstRun,2);
 tampered.sam.delta.payload[tampered.sam.delta.payload.length-1]^=1;
 await assert.rejects(stage(tampered),/SHA-256 mismatch/);
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.viewer.step,1);
 assert.equal(report.visibleSeats,2);
 const second=await signedPair(firstRun,2);
 await page.evaluate(()=>window.__trustedChain.failRenderer(true));
 await assert.rejects(stage(second),/Injected second-seat renderer failure/);
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.controller.pendingFrameId,null);
 assert.equal(report.visibleSeats,2);
 assert.equal(report.viewer.step,1);
 await page.evaluate(()=>window.__trustedChain.failRenderer(false));
 await stage(second);
 await page.evaluate(()=>window.__trustedChain.cancel());
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.controller.pendingFrameId,null);
 assert.equal(report.visibleSeats,2);
 await stage(second);
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.viewer.step,1);
 await press();
 report=await read();
 assert.equal(report.receiver.committedSequence,2);
 assert.equal(report.frameId,firstRun+":2");
 assert.deepEqual(report.images.map(v=>v.sample),[
  [212,121,222,207],[89,121,222,207]]);
 assert.deepEqual(report.mutations[1],{added:1,removed:1});
 const validThird=await signedPair(firstRun,3);
 await stage(validThird);
 report=await read();
 assert.equal(report.receiver.committedSequence,2);
 const recovered=await page.evaluate(nextRun=>
  window.__trustedChain.discardAndRecover(nextRun),nextRun);
 assert.equal(recovered.committedSequence,null);
 report=await read();assert.equal(report.visibleSeats,0);
 await assert.rejects(stage(await signedPair(firstRun,1)),/identity invalid/);
 await assert.rejects(stage(await signedPair(nextRun,2)),/identity invalid/);
 await stage(await signedPair(nextRun,1));
 await press();
 report=await read();
 assert.equal(report.receiver.committedSequence,1);
 assert.equal(report.frameId,nextRun+":1");
 assert.equal(report.visibleSeats,2);
 assert.deepEqual(report.images.map(v=>v.sample),[
  [212,121,222,207],[89,121,222,207]]);
 // Force a failure after the DOM/cursor commit but before receiver
 // baseline acceptance; the coordinator must blank the compromised
 // presentation and require an independently provisioned fresh run.
 await stage(await signedPair(nextRun,2));
 await page.evaluate(()=>window.__trustedChain.failCommitOnce());
 await assert.rejects(press(),/fresh-run recovery required/);
 report=await read();
 assert.equal(report.controller.poisoned,true);
 assert.equal(report.visibleSeats,0);
 assert.equal(report.receiver.committedSequence,1);
 const recoveredAgain=await page.evaluate(run=>
  window.__trustedChain.discardAndRecover(run),recoveryRun);
 assert.equal(recoveredAgain.runId,recoveryRun);
 await stage(await signedPair(recoveryRun,1));
 await press();
 report=await read();
 assert.equal(report.controller.poisoned,false);
 assert.equal(report.frameId,recoveryRun+":1");
 assert.equal(report.visibleSeats,2);
 console.log("COORDINATED_DELTA_BROWSER_OK",JSON.stringify({
  ...{
   rendererFailureRolledBack:true,
   explicitCancellationPreservedVisiblePair:true,
   forcedReceiverCommitFailureFailClosed:true,
   recoveryAfterCommitFailure:true,
   commitOnlyBaseline:true,
   staleRunDenied:true,
   atomicPairVerified:true
  },actualLiveGame:false,productionSceneEligible:false
 }));
 console.log("COMMIT_BOUND_CHAIN_BROWSER_OK",JSON.stringify({
  committedSequence:report.receiver.committedSequence,
  recoveredRunId:report.receiver.runId,
  finalVisibleFrame:report.frameId,
  newRunKeyframeAccepted:true,oldRunReplayDenied:true,
  missingSequenceDenied:true,tamperDenied:true,
  crossSeatDenied:true,uncommittedBaselineUnused:true,
  atomicTwoSeatDisplay:true,actualLiveGame:false,
  productionSceneEligible:false
 }));
 await ctx.close();
}catch(err){
 console.error("COMMIT_BOUND_CHAIN_BROWSER_FAIL",String(err?.stack||err));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
