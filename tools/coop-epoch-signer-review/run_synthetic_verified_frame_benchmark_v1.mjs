// Hosted, generated-image ONLY throughput diagnostic for the private
// browser verifier -> texture decode -> 48-sprite/seat compositor ->
// atomic paired DOM swap -> browser paint. Not a Pi or live-game FPS claim.
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {deflateSync} from "node:zlib";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "@playwright/test";
import {buildRegistry} from "./texture_registry_v1.mjs";
import {bindScene,bindPairedScenes} from "./scene_asset_binding_v1.mjs";
import {signScenePair} from "./scene_pair_signature_v1.mjs";
const here=dirname(fileURLToPath(import.meta.url));
const origin="https://synthetic-fps-fixture.example.test";
const runId="12345678-1234-4123-8123-123456789abc";
const totalFrames=48;
const commandsPerSeat=48;
function crc(b){
 let c=-1;for(const v of b){c^=v;for(let i=0;i<8;i++)
  c=(c>>>1)^(0xedb88320&-(c&1));}
 return(c^(-1))>>>0;
}
function chunk(type,data){
 const body=Buffer.from(data),h=Buffer.alloc(8),tail=Buffer.alloc(4);
 h.writeUInt32BE(body.length);h.write(type,4);
 tail.writeUInt32BE(crc(Buffer.concat([h.subarray(4),body])));
 return Buffer.concat([h,body,tail]);
}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
 chunk("IHDR",Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
 chunk("IDAT",deflateSync(Buffer.from([0,22,48,91,255]))),
 chunk("IEND",[])]);
const sha=b=>createHash("sha256").update(b).digest("hex");
const {manifest}=buildRegistry([{
 bytes:png,source:{kind:"static-file",path:"assets/images/benchmark-generated.png"},
 approval:{licenseId:"CC0-1.0",redistributionGranted:true,
  reviewId:"review:synthetic-benchmark",expectedSha256:sha(png)}
}]);
const href=manifest.textures[0].href;
const keys=generateKeyPairSync("ed25519");
const pinnedSpki=[...keys.publicKey.export({format:"der",type:"spki"})];
function scene(sequence,seat){
 const commands=Array.from({length:commandsPerSeat},(_,i)=>({
  op:"sprite",texture:href,src:[0,0,1,1],dst:[0,0,64,64],
  matrix:[1,0,0,1,(i*37+sequence*4)%1700,(i*59+(seat==="sam"?0:40))%950],
  alpha:1,flipX:false,flipY:false,scroll:[1,1]
 }));
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands,coverage:{inspected:commands.length,captured:commands.length,
   skipped:{},approximated:{fieldShader:0,geometryMask:0,
    spriteBase:0,spriteShadow:0},truncated:false,complete:true}};
}
function framePacket(sequence){
 const sam=bindScene({scene:scene(sequence,"sam"),manifest,
  runId,seat:"sam",sequence});
 const jevbot=bindScene({scene:scene(sequence,"jevbot"),manifest,
  runId,seat:"jevbot",sequence});
 const pair=bindPairedScenes(sam,jevbot,manifest);
 return {sam,jevbot,manifest,pinnedSpki,signed:signScenePair(
  pair,sam,jevbot,manifest,keys.privateKey,keys.publicKey)};
}
const modules=new Set([
 "paired_frame_cursor_v1.mjs","paired_frame_presenter_v1.mjs",
 "browser_scene_pair_verify_v1.mjs","browser_asset_verify_v1.mjs",
 "phaser_sprite_canvas.mjs","verified_canvas_pair_renderer_v1.mjs"
]);
let browser,requests=0;
try{
 browser=await chromium.launch({headless:true,
  ...(process.env.SAM_SYNTHETIC_CHROME_PATH?{
   executablePath:process.env.SAM_SYNTHETIC_CHROME_PATH}:{}),
  chromiumSandbox:process.env.SAM_SYNTHETIC_SANDBOX==="1",
  args:["--disable-dev-shm-usage","--disable-gpu"]});
 const ctx=await browser.newContext({viewport:{width:780,height:500}});
 await ctx.route("**/*",route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin)throw Error("Unexpected cross-origin request");
  if(url.pathname==="/")return route.fulfill({status:200,
   contentType:"text/html",
   body:'<!DOCTYPE html><html><body><div id="pair-root"></div></body></html>'});
  if(url.pathname===href){requests++;
   return route.fulfill({status:200,contentType:"image/png",body:png,
    headers:{"content-length":String(png.length)}});
  }
  const mod=url.pathname.startsWith("/review/")?
   url.pathname.slice("/review/".length):null;
  if(!modules.has(mod))throw Error("Unexpected browser resource");
  return route.fulfill({status:200,contentType:"application/javascript",
   body:readFileSync(join(here,mod),"utf8")});
 });
 const page=await ctx.newPage();
 await page.goto(origin+"/");
 await page.evaluate(async()=>{
  const [{VerifiedPairCursor},{PairedFramePresenter},
   {PrivateVerifiedCanvasRenderer}]=await Promise.all([
    import("/review/paired_frame_cursor_v1.mjs"),
    import("/review/paired_frame_presenter_v1.mjs"),
    import("/review/verified_canvas_pair_renderer_v1.mjs")]);
  const cursor=new VerifiedPairCursor();
  const renderer=new PrivateVerifiedCanvasRenderer({document});
  const root=document.getElementById("pair-root");
  const view=new PairedFramePresenter({
   root,cursor,renderSeat:renderer.renderSeat
  });
  const steps=[],visible=[];
  const time=()=>performance.now();
  const percentile=(values,fraction)=>{
   const sorted=[...values].sort((a,b)=>a-b);
   return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];
  };
  window.__fpsLab={
   async process(p){
    const start=time();
    await cursor.stage({...p,pinnedSpki:new Uint8Array(p.pinnedSpki),
     origin:location.origin});
    const verified=time();
    await renderer.prepare(cursor.nextReady());
    const rendered=time();
    if(view.prepareNext()!==true)throw Error("Frame not prepared");
    const prepared=time();
    const committed=view.pressNext();
    const swapped=time();
    if(committed?.frameId!==p.sam.frameId||
       committed.step!==steps.length+1||
       root.children.length!==1||
       root.querySelectorAll("[data-seat]").length!==2)
     throw Error("Incorrect atomic paired presentation");
    const ids=[...root.querySelectorAll("[data-seat]")].map(
     slot=>slot.dataset.frameId);
    if(ids[0]!==committed.frameId||ids[1]!==committed.frameId)
     throw Error("Cross-seat epoch mismatch");
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const painted=time();
    steps.push({verifyMs:verified-start,renderMs:rendered-verified,
     prepareMs:prepared-rendered,commitMs:swapped-prepared,
     toPaintMs:painted-swapped,totalMs:painted-start});
    visible.push(committed.frameId);
    return committed.step;
   },
   report(){
    const measure=k=>({
     p50ms:+percentile(steps.map(x=>x[k]),.5).toFixed(3),
     p95ms:+percentile(steps.map(x=>x[k]),.95).toFixed(3),
     maximumMs:+Math.max(...steps.map(x=>x[k])).toFixed(3)
    });
    return {frames:steps.length,commandsPerSeat:48,
     finalStep:cursor.status.step,visibleEpochs:visible.length,
     monotonic:visible.every((id,i)=>id.endsWith(":"+(i+1))),
     manualStage:false,productionEligible:false,
     verify:measure("verifyMs"),render:measure("renderMs"),
     commit:measure("commitMs"),toPaint:measure("toPaintMs"),
     total:measure("totalMs"),
     fractionUnder33ms:+(steps.filter(x=>x.totalMs<=33.333).length/
       Math.max(1,steps.length)).toFixed(3)};
   }
  };
 });
 for(let sequence=1;sequence<=totalFrames;sequence++){
  const result=await page.evaluate(packet=>window.__fpsLab.process(packet),
   framePacket(sequence));
  assert.equal(result,sequence);
 }
 const metrics=await page.evaluate(()=>window.__fpsLab.report());
 assert.equal(metrics.frames,totalFrames);
 assert.equal(metrics.finalStep,totalFrames);
 assert.equal(metrics.visibleEpochs,totalFrames);
 assert.equal(metrics.monotonic,true);
 assert.equal(requests,totalFrames);
 console.log("SYNTHETIC_SIGNED_PAIR_FRAME_BENCH",JSON.stringify(metrics));
 console.log("HOSTED_CI_ONLY_NOT_PI_OR_LIVE_GAME");
 await ctx.close();
}catch(err){
 console.error("SYNTHETIC_SIGNED_PAIR_BENCH_FAIL",String(err?.stack||err));
 process.exitCode=1;
}finally{if(browser)await browser.close();}
