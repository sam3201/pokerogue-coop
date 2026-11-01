// Full PRIVATE synthetic Ed25519 pair -> SHA256 texture fetch ->
// verified cursor -> atomic two-seat DOM display, tested in real Chromium.
// Uses generated 1x1 PNG and throwaway signing key; NOT production evidence.
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {deflateSync} from "node:zlib";
import {chromium} from "@playwright/test";
import {readFileSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {buildRegistry} from "./texture_registry_v1.mjs";
import {bindScene,bindPairedScenes} from "./scene_asset_binding_v1.mjs";
import {signScenePair} from "./scene_pair_signature_v1.mjs";
const origin="https://verified-pair-fixture.example.test";
const here=dirname(fileURLToPath(import.meta.url));
const runId="12345678-1234-4123-8123-123456789abc";
const sha=b=>createHash("sha256").update(b).digest("hex");
function crc(b){
 let x=-1;for(const a of b){x^=a;
  for(let i=0;i<8;i++)x=(x>>>1)^(0xedb88320&-(x&1));}
 return (x^(-1))>>>0;
}
function chunk(type,bytes){
 const b=Buffer.from(bytes),h=Buffer.alloc(8),t=Buffer.alloc(4);
 h.writeUInt32BE(b.length);h.write(type,4);
 t.writeUInt32BE(crc(Buffer.concat([h.subarray(4),b])));
 return Buffer.concat([h,b,t]);
}
const png=Buffer.concat([
 Buffer.from([137,80,78,71,13,10,26,10]),
 chunk("IHDR",Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
 chunk("IDAT",deflateSync(Buffer.from([0,22,48,91,255]))),
 chunk("IEND",[])
]);
const {manifest}=buildRegistry([{bytes:png,
 source:{kind:"static-file",path:"assets/images/generated-verified.png"},
 approval:{licenseId:"CC0-1.0",redistributionGranted:true,
  reviewId:"review:synthetic-browser",expectedSha256:sha(png)}}]);
const href=manifest.textures[0].href;
const key=generateKeyPairSync("ed25519");
const pinnedSpki=[...key.publicKey.export({format:"der",type:"spki"})];
function scene(frame,seat){
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:href,
   src:[0,0,1,1],dst:[0,0,1,1],
   matrix:[1,0,0,1,frame,seat==="sam"?0:1],
   alpha:1,flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{inspected:1,captured:1,skipped:{},
   approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
   truncated:false,complete:true}};
}
function signedPair(frame){
 const sam=bindScene({scene:scene(frame,"sam"),manifest,
  runId,seat:"sam",sequence:frame});
 const jevbot=bindScene({scene:scene(frame,"jevbot"),manifest,
  runId,seat:"jevbot",sequence:frame});
 const pair=bindPairedScenes(sam,jevbot,manifest);
 return {sam,jevbot,manifest,pinnedSpki,signed:
  signScenePair(pair,sam,jevbot,manifest,key.privateKey,key.publicKey)};
}
const allowed=new Set([
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
 const ctx=await browser.newContext({viewport:{width:640,height:360}});
 let pngFetches=0,unknownRequests=0;
 await ctx.route("**/*",async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin){unknownRequests++;return route.abort();}
  if(u.pathname==="/")return route.fulfill({status:200,
   contentType:"text/html",
   body:'<!doctype html><html><body><button id="next">Next</button><div id="pair-root"></div></body></html>'});
  if(u.pathname===href){
   pngFetches++;
   return route.fulfill({status:200,contentType:"image/png",body:png,
    headers:{"content-length":String(png.byteLength)}});
  }
  const name=u.pathname.startsWith("/review/")?
   u.pathname.slice("/review/".length):null;
  if(!allowed.has(name)){unknownRequests++;return route.abort();}
  return route.fulfill({status:200,contentType:"application/javascript",
   body:readFileSync(join(here,name),"utf8")});
 });
 const page=await ctx.newPage();
 await page.goto(origin+"/",{waitUntil:"load"});
 await page.evaluate(async()=>{
  const [{VerifiedPairCursor},{PairedFramePresenter}]=await Promise.all([
   import("/review/paired_frame_cursor_v1.mjs"),
   import("/review/paired_frame_presenter_v1.mjs")]);
  const cursor=new VerifiedPairCursor(); // REAL WebCrypto verifier
  const root=document.getElementById("pair-root");
  const renders=[];
  const view=new PairedFramePresenter({
   root,cursor,renderSeat:({seat,scene,textures,frameId})=>{
    if(textures.size!==1)throw Error("Unverified textures missing");
    const c=document.createElement("canvas");
    c.width=64;c.height=32;c.dataset.frameId=frameId;
    c.dataset.seat=seat;
    c.dataset.sequence=String(scene.commands[0].matrix[4]);
    const g=c.getContext("2d");
    g.fillStyle=seat==="sam"?"rgb(10,70,120)":"rgb(90,10,120)";
    g.fillRect(0,0,c.width,c.height);
    renders.push({seat,frameId});
    return c;
   }
  });
  const mutations=[];
  new MutationObserver(rs=>rs.forEach(r=>mutations.push({
   added:r.addedNodes.length,removed:r.removedNodes.length
  }))).observe(root,{childList:true});
  document.getElementById("next").addEventListener("click",()=>view.pressNext());
  window.__signedDemo={
   stage:async input=>{
    const copy={...input,pinnedSpki:new Uint8Array(input.pinnedSpki),
      origin:location.origin};
    await cursor.stage(copy);
    // Late malicious modification of the verifier's input cannot corrupt
    // already-admitted scene/texture data.
    input.sam.scene.commands[0].matrix[4]=999;
    return view.prepareNext();
   },
   snapshot:()=>{
    const pane=root.firstElementChild;
    return {step:cursor.status.step,queued:cursor.status.queued,
      frameId:pane?.dataset.pairFrameId??null,children:root.children.length,
      seats:pane?[...pane.children].map(n=>({
       seat:n.dataset.seat,frameId:n.dataset.frameId,
       canvasFrameId:n.firstElementChild.dataset.frameId,
       sequence:Number(n.firstElementChild.dataset.sequence)
      })):[],
      renders,mutations};
   }
  };
 });
 const stage=input=>page.evaluate(data=>window.__signedDemo.stage(data),input);
 const read=()=>page.evaluate(()=>window.__signedDemo.snapshot());
 const click=()=>page.locator("#next").click();
 let s=await read();
 assert.equal(s.step,0);assert.equal(s.children,0);
 const forged=signedPair(9);
 forged.signed.signature="A".repeat(86);
 await assert.rejects(stage(forged),/Untrusted paired scene commit/);
 assert.equal(pngFetches,0);
 s=await read();assert.equal(s.step,0);assert.equal(s.children,0);
 const one=signedPair(9);
 await stage(one);
 assert.equal(pngFetches,1);
 s=await read();assert.equal(s.step,0);assert.equal(s.children,0);
 await click();s=await read();
 assert.equal(s.step,1);assert.equal(s.children,1);
 assert.equal(s.frameId,runId+":9");
 assert.deepEqual(s.seats.map(x=>x.frameId),[s.frameId,s.frameId]);
 assert.deepEqual(s.seats.map(x=>x.sequence),[9,9]);
 assert.deepEqual(s.mutations,[{added:1,removed:0}]);
 const secondWrong=signedPair(10);
 secondWrong.jevbot.sequence=11;
 await assert.rejects(stage(secondWrong),/Untrusted paired scene commit/);
 assert.equal(pngFetches,1);
 s=await read();assert.equal(s.step,1);assert.equal(s.frameId,runId+":9");
 await stage(signedPair(10));assert.equal(pngFetches,2);
 s=await read();assert.equal(s.step,1);
 await click();s=await read();
 assert.equal(s.step,2);assert.equal(s.frameId,runId+":10");
 assert.deepEqual(s.seats.map(x=>x.frameId),[s.frameId,s.frameId]);
 assert.deepEqual(s.seats.map(x=>x.sequence),[10,10]);
 assert.deepEqual(s.mutations[1],{added:1,removed:1});
 assert.equal(unknownRequests,0);
 console.log("SIGNED_TO_ATOMIC_BROWSER_PAIR_OK",JSON.stringify({
  verifiedPairs:2,manualSteps:2,textureFetches:pngFetches,
  totalSeatRenders:s.renders.length,atomicSwaps:s.mutations.length,
  invalidSignatureDenied:true,mismatchedSeatDenied:true,
  realGameplaySource:false,productionSceneEligible:false
 }));
 await ctx.close();
}catch(e){
 console.error("SIGNED_TO_ATOMIC_BROWSER_PAIR_FAIL",String(e?.stack||e));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
