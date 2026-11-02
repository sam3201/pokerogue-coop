// REVIEW ONLY: disposable Ed25519 binding + arbitrary byte XOR deltas
// reconstructed in real Chromium and atomically displayed for both seats.
// Trust demonstration, NOT live relay provenance or Pokémon frame evidence.
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {readFileSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "@playwright/test";
import {encodeAgnosticXorDelta} from "./agnostic_xor_byte_delta_v1.mjs";
const here=dirname(fileURLToPath(import.meta.url));
const origin="https://delta-signed-browser.example.test";
const runId="12345678-1234-4123-8123-123456789abc";
const SCHEMA="sam.coop.synthetic-signed-byte-frame.v1";
const width=320,height=180;
const keys=generateKeyPairSync("ed25519");
const pinnedSpki=[...keys.publicKey.export({format:"der",type:"spki"})];
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
function image(sequence,seat){
 const bytes=new Uint8Array(width*height*4);
 for(let i=0;i<bytes.length;i+=4){
  bytes[i]=18;bytes[i+1]=35;bytes[i+2]=63;bytes[i+3]=255;
 }
 const x=(sequence*(seat==="sam"?7:11))%(width-17);
 const y=(sequence*(seat==="sam"?3:5))%(height-17);
 for(let j=0;j<16;j++)for(let i=0;i<16;i++){
  const p=((y+j)*width+x+i)*4;
  bytes[p]=seat==="sam"?221:72;
  bytes[p+1]=90;bytes[p+2]=201;bytes[p+3]=190;
 }
 return bytes;
}
async function wrappedSeat(sequence,seat){
 const before=image(sequence-1,seat),after=image(sequence,seat);
 const delta=await encodeAgnosticXorDelta({before,after});
 const statement={
  schema:SCHEMA,runId,sequence,seat,frameId:runId+":"+sequence,
  baseSha256:sha(before),targetSha256:sha(after)
 };
 return {statement,signature:sign(null,
   Buffer.from(JSON.stringify(statement)),keys.privateKey).toString("base64url"),
   base:[...before],delta:{...delta,payload:[...delta.payload]},
   expectedSprite:{x:(sequence*(seat==="sam"?7:11))%(width-17),
    y:(sequence*(seat==="sam"?3:5))%(height-17)}};
}
async function bundle(sequence){
 return {sam:await wrappedSeat(sequence,"sam"),
  jevbot:await wrappedSeat(sequence,"jevbot")};
}
const modules=new Set([
 "paired_frame_cursor_v1.mjs","paired_frame_presenter_v1.mjs",
 "browser_scene_pair_verify_v1.mjs","browser_asset_verify_v1.mjs",
 "agnostic_xor_byte_delta_v1.mjs"
]);
let browser;
try{
 browser=await chromium.launch({
  ...(process.env.SAM_SYNTHETIC_CHROME_PATH?{
   executablePath:process.env.SAM_SYNTHETIC_CHROME_PATH}:{}),
  chromiumSandbox:process.env.SAM_SYNTHETIC_SANDBOX==="1",
  headless:true,args:["--disable-dev-shm-usage","--disable-gpu"]
 });
 const ctx=await browser.newContext({viewport:{width:760,height:450}});
 await ctx.route("**/*",route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin)return route.abort();
  if(u.pathname==="/")return route.fulfill({status:200,
   contentType:"text/html",
   body:'<!doctype html><html><body><button id="next">Next</button><div id="pair-root"></div></body></html>'});
  const name=u.pathname.startsWith("/review/")?
   u.pathname.slice("/review/".length):null;
  if(!modules.has(name))return route.abort();
  return route.fulfill({status:200,contentType:"application/javascript",
   body:readFileSync(join(here,name),"utf8")});
 });
 const page=await ctx.newPage();
 await page.goto(origin+"/");
 await page.evaluate(async({runId,pinnedSpki,SCHEMA,width,height})=>{
  const [{VerifiedPairCursor},{PairedFramePresenter},
   {decodeAgnosticXorDelta}]=await Promise.all([
   import("/review/paired_frame_cursor_v1.mjs"),
   import("/review/paired_frame_presenter_v1.mjs"),
   import("/review/agnostic_xor_byte_delta_v1.mjs")
  ]);
  const pinned=await crypto.subtle.importKey("spki",
   new Uint8Array(pinnedSpki),{name:"Ed25519"},false,["verify"]);
  const verifySeat=async(raw,seat,seq)=>{
   const statement=raw?.statement;
   if(!statement||Object.keys(statement).length!==7||
      statement.schema!==SCHEMA||
      statement.runId!==runId||statement.seat!==seat||
      statement.sequence!==seq||
      statement.frameId!==runId+":"+seq||
      typeof raw.signature!=="string"||
      !/^[A-Za-z0-9_-]{86}$/.test(raw.signature))
    throw Error("Signed byte frame identity rejected");
   const rawSig=Uint8Array.from(atob(
    raw.signature.replace(/-/g,"+").replace(/_/g,"/")+"=="),
    ch=>ch.charCodeAt(0));
   const authenticated=await crypto.subtle.verify("Ed25519",
    pinned,rawSig,new TextEncoder().encode(JSON.stringify(statement)));
   if(!authenticated)throw Error("Signed byte frame signature rejected");
   const bytes=await decodeAgnosticXorDelta({
    before:new Uint8Array(raw.base),
    packet:{...raw.delta,payload:new Uint8Array(raw.delta.payload)},
    trustedBaseSha256:statement.baseSha256,
    trustedTargetSha256:statement.targetSha256
   });
   if(bytes.length!==width*height*4)
    throw Error("Decoded byte frame size mismatch");
   return bytes;
  };
  const cursor=new VerifiedPairCursor({
   verifier:async raw=>{
    const seq=raw.sequence;
    if(!Number.isSafeInteger(seq)||seq<1||
       raw.runId!==runId||raw.frameId!==runId+":"+seq)
     throw Error("Invalid signed delta pair identity");
    const sam=await verifySeat(raw.sam,"sam",seq);
    const jevbot=await verifySeat(raw.jevbot,"jevbot",seq);
    return {scope:"private-staging-only",runId,sequence:seq,
     frameId:runId+":"+seq,
     seats:{sam:{pixels:sam},jevbot:{pixels:jevbot}},
     textures:new Map([["generated-signed-byte-stream",
      new Uint8Array([1])]])};
   }
  });
  const root=document.getElementById("pair-root");
  const mutations=[];
  new MutationObserver(rs=>rs.forEach(r=>mutations.push({
   added:r.addedNodes.length,removed:r.removedNodes.length
  }))).observe(root,{childList:true});
  const view=new PairedFramePresenter({root,cursor,
   renderSeat:({seat,scene,frameId})=>{
    const canvas=document.createElement("canvas");
    canvas.width=width;canvas.height=height;
    canvas.dataset.seat=seat;canvas.dataset.frameId=frameId;
    canvas.getContext("2d").putImageData(new ImageData(
     new Uint8ClampedArray(scene.pixels),width,height),0,0);
    return canvas;
   }
  });
  window.__deltaBrowser={
   stage:async data=>{
    await cursor.stage(data);
    return view.prepareNext();
   },
   next:()=>view.pressNext(),
   snapshot:()=>{
    const pane=root.firstElementChild;
    return {step:cursor.status.step,
     frameId:pane?.dataset.pairFrameId??null,
     visibleSeats:root.querySelectorAll(".sam-private-paired-seat").length,
     seats:pane?[...pane.children].map(slot=>{
      const canvas=slot.firstElementChild;
      const seat=slot.dataset.seat;
      const seq=cursor.status.step+1;
      const x=seq*(seat==="sam"?7:11)%(width-17),
        y=seq*(seat==="sam"?3:5)%(height-17);
      return {seat,frameId:slot.dataset.frameId,
       pixel:[...canvas.getContext("2d").getImageData(x,y,1,1).data]
      };
     }):[],mutations};
   }
  };
 },{runId,pinnedSpki,SCHEMA,width,height});
 // The test supplies the expected run independently of both seat packets.
 const doStage=async(sequence,raw)=>page.evaluate(
  ({runId,sequence,raw})=>window.__deltaBrowser.stage({
   runId,sequence,frameId:runId+":"+sequence,...raw
  }),{runId,sequence,raw});
 const snapshot=()=>page.evaluate(()=>window.__deltaBrowser.snapshot());
 const next=()=>page.evaluate(()=>window.__deltaBrowser.next());
 const first=await bundle(2);
 const badSig=structuredClone(first);
 badSig.sam.signature="A".repeat(86);
 await assert.rejects(doStage(2,badSig),/signature rejected/);
 assert.equal((await snapshot()).step,0);
 const wrongSeat=structuredClone(first);
 wrongSeat.jevbot=first.sam;
 await assert.rejects(doStage(2,wrongSeat),/identity rejected/);
 const corrupted=structuredClone(first);
 corrupted.sam.delta.payload[8]^=1;
 await assert.rejects(doStage(2,corrupted),/target SHA-256 mismatch/);
 assert.equal((await snapshot()).step,0);
 await doStage(2,first);
 assert.equal((await snapshot()).step,0);
 const committed1=await next();
 assert.equal(committed1?.step,1);
 const visible1=await snapshot();
 assert.equal(visible1.frameId,runId+":2");
 assert.equal(visible1.visibleSeats,2);
 assert.deepEqual(visible1.seats.map(s=>s.pixel),[
  [221,90,201,190],[72,90,201,190]]);
 assert.deepEqual(visible1.mutations,[{added:1,removed:0}]);
 const second=await bundle(3);
 await doStage(3,second);
 assert.equal((await snapshot()).step,1);
 const committed2=await next();
 assert.equal(committed2?.step,2);
 const visible2=await snapshot();
 assert.equal(visible2.frameId,runId+":3");
 assert.deepEqual(visible2.seats.map(s=>s.frameId),[
  visible2.frameId,visible2.frameId]);
 assert.deepEqual(visible2.mutations[1],{added:1,removed:1});
 console.log("SIGNED_AGNOSTIC_DELTA_CHROMIUM_OK",JSON.stringify({
  verifiedPairedSteps:2,visibleSeats:2,atomicSwaps:2,
  tamperedSignatureDenied:true,crossSeatDenied:true,
  tamperedDeltaDenied:true,reconstructedPixelsCorrect:true,
  productionSceneEligible:false,liveGameAttested:false
 }));
 await ctx.close();
}catch(err){
 console.error("SIGNED_AGNOSTIC_DELTA_CHROMIUM_FAIL",String(err?.stack||err));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
