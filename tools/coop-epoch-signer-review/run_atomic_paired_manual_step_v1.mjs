// Synthetic manual 0 -> 1 -> 2 browser stepping, with NO real game assets.
// Tests atomic DOM presentation, not live relay/scene provenance.
import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const origin="https://atomic-pair-fixture.example.test";
const modules=new Set([
 "paired_frame_presenter_v1.mjs","paired_frame_cursor_v1.mjs",
 "browser_scene_pair_verify_v1.mjs","browser_asset_verify_v1.mjs"]);
let browser;
try{
 browser=await chromium.launch({
  ...(process.env.SAM_SYNTHETIC_CHROME_PATH?{
    executablePath:process.env.SAM_SYNTHETIC_CHROME_PATH}:{}),
  headless:true,chromiumSandbox:process.env.SAM_SYNTHETIC_SANDBOX==="1",
  args:["--disable-dev-shm-usage","--disable-gpu"]
 });
 const ctx=await browser.newContext({viewport:{width:640,height:400}});
 await ctx.route("**/*",async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin)return route.abort();
  if(u.pathname==="/")return route.fulfill({
   status:200,contentType:"text/html",
   body:'<!doctype html><html><body><button id="next" type="button">Next frame</button><div id="pair-root"></div></body></html>'
  });
  const file=u.pathname.startsWith("/review/")?
   u.pathname.slice("/review/".length):null;
  if(!modules.has(file))return route.abort();
  return route.fulfill({status:200,contentType:"application/javascript",
   body:readFileSync(join(here,file),"utf8")});
 });
 const page=await ctx.newPage();
 await page.goto(origin+"/",{waitUntil:"load"});
 await page.evaluate(async()=>{
  const [{VerifiedPairCursor},{PairedFramePresenter}]=await Promise.all([
   import("/review/paired_frame_cursor_v1.mjs"),
   import("/review/paired_frame_presenter_v1.mjs")]);
  const runId="12345678-1234-4123-8123-123456789abc";
  const make=sequence=>{
   const frameId=runId+":"+sequence;
   return {scope:"private-staging-only",runId,sequence,frameId,
    seats:{sam:{frameId,tint:sequence},jevbot:{frameId,tint:sequence}},
    textures:new Map([["/images/synthetic.png",new Uint8Array([1,2,3])]])};
  };
  const root=document.getElementById("pair-root"),mutations=[];
  new MutationObserver(records=>{
   for(const r of records)mutations.push({
    added:r.addedNodes.length,removed:r.removedNodes.length,
    visible:root.children.length});
  }).observe(root,{childList:true});
  const cursor=new VerifiedPairCursor({verifier:async x=>x});
  const makeCanvas=({seat,scene,frameId})=>{
   const el=document.createElement("canvas");
   el.width=160;el.height=90;el.dataset.frameId=frameId;
   el.dataset.tint=String(scene.tint);
   const c=el.getContext("2d");
   c.fillStyle=seat==="sam"?"rgb("+scene.tint+",0,0)":"rgb(0,"+scene.tint+",0)";
   c.fillRect(0,0,160,90);
   return el;
  };
  const presenter=new PairedFramePresenter({root,cursor,renderSeat:makeCanvas});
  document.getElementById("next").addEventListener("click",()=>presenter.pressNext());
  window.__demo={
   stage:async n=>{
    const original=make(n);await cursor.stage(original);
    original.seats.sam.tint=255;original.textures.values().next().value[0]=99;
    return presenter.prepareNext();
   },
   badRenderer:async()=>{
    const probeRoot=document.createElement("div");document.body.append(probeRoot);
    const other=new VerifiedPairCursor({verifier:async x=>x});
    await other.stage(make(1));
    const probe=new PairedFramePresenter({root:probeRoot,cursor:other,
     renderSeat:({seat})=>{
      if(seat==="jevbot")throw Error("second seat failed");
      return document.createElement("canvas");
     }});
    let rejected=false;
    try{probe.prepareNext();}catch(e){rejected=/second seat failed/.test(String(e));}
    return {rejected,visible:probeRoot.children.length,
     step:other.status.step,queued:other.status.queued};
   },
   stale:async()=>{
    await cursor.stage(make(11));presenter.prepareNext();
    const old=cursor.nextReady().admissionId;
    cursor.reset();await cursor.stage(make(11));
    const fresh=cursor.nextReady().admissionId;
    return {old,fresh,ignored:presenter.pressNext()};
   },
   reset:()=>presenter.reset(),
   status:()=>{
    const pane=root.firstElementChild;
    const seats=pane?[...pane.children].map(slot=>{
     const el=slot.firstElementChild;
     return {seat:slot.dataset.seat,frameId:slot.dataset.frameId,
      canvasFrameId:el.dataset.frameId,tint:Number(el.dataset.tint),
      pixel:[...el.getContext("2d").getImageData(0,0,1,1).data]};
    }):[];
    return {display:presenter.status,frameId:pane?.dataset.pairFrameId??null,
     childCount:root.children.length,seats,mutations};
   }
  };
 });
 const status=()=>page.evaluate(()=>window.__demo.status());
 const click=()=>page.locator("#next").click();
 let s=await status();
 assert.equal(s.display.step,0);assert.equal(s.childCount,0);
 await click();s=await status();assert.equal(s.display.step,0);
 await page.evaluate(()=>window.__demo.stage(9));
 s=await status();assert.equal(s.display.step,0);assert.equal(s.childCount,0);
 await click();s=await status();
 assert.equal(s.display.step,1);assert.equal(s.childCount,1);
 assert.equal(s.frameId,"12345678-1234-4123-8123-123456789abc:9");
 assert.deepEqual(s.seats.map(x=>x.seat),["sam","jevbot"]);
 assert.deepEqual(s.seats.map(x=>x.frameId),[s.frameId,s.frameId]);
 assert.deepEqual(s.seats.map(x=>x.canvasFrameId),[s.frameId,s.frameId]);
 assert.deepEqual(s.seats.map(x=>x.tint),[9,9]);
 assert.deepEqual(s.mutations,[{added:1,removed:0,visible:1}]);
 await page.evaluate(()=>window.__demo.stage(10));
 s=await status();assert.equal(s.display.step,1);
 await click();s=await status();
 assert.equal(s.display.step,2);
 assert.equal(s.frameId,"12345678-1234-4123-8123-123456789abc:10");
 assert.equal(s.childCount,1);
 assert.deepEqual(s.mutations[1],{added:1,removed:1,visible:1});
 await click();s=await status();
 assert.equal(s.display.step,2);assert.equal(s.mutations.length,2);
 const bad=await page.evaluate(()=>window.__demo.badRenderer());
 assert.deepEqual(bad,{rejected:true,visible:0,step:0,queued:1});
 const stale=await page.evaluate(()=>window.__demo.stale());
 assert.equal(stale.ignored,null);
 assert.ok(stale.fresh>stale.old);
 s=await status();assert.equal(s.mutations.length,2);
 assert.equal(s.frameId,"12345678-1234-4123-8123-123456789abc:10");
 await page.evaluate(()=>window.__demo.reset());
 s=await status();assert.equal(s.display.step,0);assert.equal(s.childCount,0);
 await page.evaluate(()=>window.__demo.stage(1));await click();
 s=await status();assert.equal(s.display.step,1);
 assert.equal(s.frameId,"12345678-1234-4123-8123-123456789abc:1");
 assert.deepEqual(s.seats.map(x=>x.frameId),[s.frameId,s.frameId]);
 console.log("ATOMIC_BROWSER_PAIRED_STEP_OK",JSON.stringify({
  step:s.display.step,visibleSeats:s.seats.length,
  mutations:s.mutations.length,staleAdmissionDenied:true,
  rendererFailureDenied:bad.rejected,
  productionSceneEligible:false
 }));
 await ctx.close();
}catch(e){
 console.error("ATOMIC_BROWSER_PAIRED_STEP_FAIL",String(e?.stack||e));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
