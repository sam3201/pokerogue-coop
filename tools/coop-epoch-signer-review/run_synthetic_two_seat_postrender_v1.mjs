// Synthetic two-tab Chromium test for the isolated owner capture bridge.
// Generated canvas frames only. No real game relay or live writer interaction.
import {chromium} from "@playwright/test";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {capturePostrenderSeat} from "./owner_postrender_bridge_v1.mjs";
import {preparePrivateEpoch,inspectPrivateEpoch}
 from "./private_epoch_capture_contract_v1.mjs";
const here=dirname(fileURLToPath(import.meta.url));
const source=readFileSync(join(here,"phaser_sprite_probe.mjs"),"utf8");
const html=readFileSync(join(here,"synthetic_postrender_fixture.html"),"utf8");
const runId="12345678-1234-4123-8123-123456789abc";
const origin="https://isolated-epoch.example.test";
const relayCommitHash=createHash("sha256").update("relay-checkpoint-synthetic")
 .digest("hex");
const gameStateHash=createHash("sha256").update("game-state-synthetic")
 .digest("hex");
let browser;
try{
 browser=await chromium.launch({
   ...(process.env.SAM_SYNTHETIC_CHROME_PATH?{executablePath:process.env.SAM_SYNTHETIC_CHROME_PATH}:{}),
   headless:true,chromiumSandbox:process.env.SAM_SYNTHETIC_SANDBOX==="1",
   args:["--disable-dev-shm-usage","--disable-gpu"]});
 const ctx=await browser.newContext({viewport:{width:640,height:360}});
 await ctx.route("**/*",async route=>{
  const u=new URL(route.request().url());
  if(u.origin!==origin)return route.abort();
  if(u.pathname==="/")
   return route.fulfill({status:200,contentType:"text/html",body:html});
  if(u.pathname==="/src/globals/global-scene.ts")
   return route.fulfill({status:200,contentType:"application/javascript",
    body:"export const globalScene = globalThis.__fixtureScene;"});
  return route.abort();
 });
 const pages={sam:await ctx.newPage(),jevbot:await ctx.newPage()};
 for(const page of Object.values(pages)){
  await page.goto(origin+"/",{waitUntil:"load",timeout:15000});
  await page.waitForFunction(()=>window.__fixtureLoop?.frame>=2,
    null,{timeout:8000,polling:100});
 }
 const checks=[];
 for(const [seat,page] of Object.entries(pages)){
  const screenshot=page.screenshot.bind(page);
  page.screenshot=async(opts)=>{
   const observed=await page.evaluate(()=>({
    frozen:!!globalThis.__fixtureLoop?.asleep,
    lease:!!globalThis.__samPrivateEpochFreeze,
    at:globalThis.__fixtureLoop?.frame,
    drawn:globalThis.__fixtureDrawTick
   }));
   if(!observed.frozen||!observed.lease||observed.at!==observed.drawn)
    throw Error("Screenshot was not captured at postrender freeze");
   const png=await screenshot(opts);
   const after=await page.evaluate(()=>({
    frozen:!!globalThis.__fixtureLoop?.asleep,
    lease:!!globalThis.__samPrivateEpochFreeze,
    at:globalThis.__fixtureLoop?.frame,
    drawn:globalThis.__fixtureDrawTick
   }));
   checks.push({seat,...observed,after});
   if(!after.frozen||!after.lease||after.at!==after.drawn||
      observed.at!==after.at)
    throw Error("Screenshot changed the frozen render frame");
   return png;
  };
 }
 let checkpointReads=0;
 const output=await preparePrivateEpoch({
  runId,sequence:900,
  readRelayCheckpoint:async()=>{
   checkpointReads++;
   return {runId,relayCommitHash,gameStateHash};
  },
  captureSeat:async(seat,ctx)=>{
   return capturePostrenderSeat({
    page:pages[seat],seat,relayCommitHash:ctx.relayCommitHash,
    captureSource:source,timeoutMs:9000,signal:ctx.signal
   });
  }
 });
 const states={};
 for(const [seat,page] of Object.entries(pages)){
  states[seat]=await page.evaluate(()=>({
    asleep:globalThis.__fixtureLoop.asleep,
    lease:!!globalThis.__samPrivateEpochFreeze,
    current:globalThis.__fixtureLoop.frame
  }));
 }
 const match=inspectPrivateEpoch(output);
 const receipts=output.receipt;
 const frames=Object.fromEntries(Object.entries(output.scenes)
  .map(([seat,scene])=>[seat,scene.commands[0]?.matrix[4]]));
 console.log("SYNTHETIC_POSTRENDER_RESULT",JSON.stringify({
   match,checkpointReads,checks,states,sceneFrameTicks:frames,
   pictureBytes:Object.fromEntries(Object.entries(output.frames).map(
     ([seat,buf])=>[seat,buf.length])),
   epochAuthenticated:receipts.issuerAuthenticated,
   sceneEpochAttested:receipts.sceneEpochAttested,
   productionEligible:receipts.productionSceneEligible,
   completeScenes:receipts.sceneComplete
 }));
 if(!match||checkpointReads!==2||checks.length!==2||
   checks.some(x=>!x.frozen||x.at!==x.drawn||
      !x.after.frozen||!x.after.lease||x.after.at!==x.at)||
   Object.values(states).some(s=>s.asleep||s.lease)||
   Object.entries(frames).some(([seat,tick])=>
     tick!==receipts.frameTicks[seat])||
   receipts.issuerAuthenticated!==false||
   receipts.sceneEpochAttested!==false||
   receipts.productionSceneEligible!==false||!receipts.sceneComplete)
   process.exitCode=1;
 // Failure injection: one screenshot throws while peer capture completes.
 // The coordinator must wait for both finally/unfreeze paths.
 const savedScreenshot=pages.jevbot.screenshot;
 pages.jevbot.screenshot=async()=>{throw Error("synthetic camera failure");};
 let denied=false;
 try{
  await preparePrivateEpoch({
   runId,sequence:901,
   readRelayCheckpoint:async()=>({runId,relayCommitHash,gameStateHash}),
   captureSeat:(seat,ctx)=>capturePostrenderSeat({
    page:pages[seat],seat,relayCommitHash:ctx.relayCommitHash,
    captureSource:source,timeoutMs:9000
   })
  });
 }catch{denied=true;}
 pages.jevbot.screenshot=savedScreenshot;
 const unfrozen=await Promise.all(Object.values(pages).map(page=>
  page.evaluate(()=>!globalThis.__fixtureLoop.asleep &&
    !globalThis.__samPrivateEpochFreeze)));
 console.log("SYNTHETIC_FAILURE_CLEANUP",JSON.stringify({
  denied,unfrozen
 }));
 if(!denied||!unfrozen.every(Boolean))process.exitCode=1;
 // Failure injection: an unrelated script advances the frozen frame
 // after screenshot bytes were obtained but before the capture callback
 // verifies its lease. The result must be rejected and both pages resumed.
 const originalSamScreenshot=pages.sam.screenshot;
 pages.sam.screenshot=async opts=>{
  const buffer=await originalSamScreenshot(opts);
  await pages.sam.evaluate(()=>{globalThis.__fixtureLoop.frame+=1;});
  return buffer;
 };
 let tickChangeDenied=false;
 let tickChangeSeatError=null;
 try{
  await preparePrivateEpoch({
   runId,sequence:902,
   readRelayCheckpoint:async()=>({runId,relayCommitHash,gameStateHash}),
   captureSeat:async(seat,ctx)=>{
    try{
     return await capturePostrenderSeat({
      page:pages[seat],seat,relayCommitHash:ctx.relayCommitHash,
      captureSource:source,timeoutMs:9000
     });
    }catch(e){
     if(seat==="sam")tickChangeSeatError=String(e);
     throw e;
    }
   }
  });
 }catch(e){
  tickChangeDenied=/one or both seat captures failed/.test(String(e))&&
    /lease changed/.test(tickChangeSeatError||"");
 }
 pages.sam.screenshot=originalSamScreenshot;
 const unfrozenAfterTick=await Promise.all(Object.values(pages).map(page=>
  page.evaluate(()=>!globalThis.__fixtureLoop.asleep &&
    !globalThis.__samPrivateEpochFreeze)));
 console.log("SYNTHETIC_TICK_CHANGE_REJECTION",JSON.stringify({
  tickChangeDenied,unfrozen:unfrozenAfterTick
 }));
 if(!tickChangeDenied||!unfrozenAfterTick.every(Boolean))
  process.exitCode=1;
 await ctx.close();
}catch(e){
 console.error("SYNTHETIC_POSTRENDER_FAIL",String(e?.stack||e));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
