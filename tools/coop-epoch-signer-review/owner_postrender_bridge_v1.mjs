// Isolated owner-side Playwright capture adapter (NOT a production issuer).
// It freezes the Phaser canvas after a postrender callback, extracts a bounded
// scene, screenshots that frozen canvas, and always attempts to resume it.
// The public writer and private relay are untouched.
const ACTIVE=new WeakSet();
const HEX=/^[0-9a-f]{64}$/;
const SEATS=new Set(["sam","jevbot"]);
const LIVE_IMPORT="/src/globals/global-scene.ts";
function assertCall({page,seat,relayCommitHash,captureSource,timeoutMs}){
 if(!page||typeof page.evaluate!=="function"||
    typeof page.screenshot!=="function"||!SEATS.has(seat)||
    !HEX.test(relayCommitHash||"")||
    typeof captureSource!=="string"||captureSource.length<100||
    captureSource.length>35000||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<500||timeoutMs>15000)
   throw Error("Invalid private capture request");
}
export async function capturePostrenderSeat({
 page,seat,relayCommitHash,captureSource,timeoutMs=7000,signal
}){
 assertCall({page,seat,relayCommitHash,captureSource,timeoutMs});
 if(signal?.aborted)throw Error("Capture canceled");
 if(ACTIVE.has(page))throw Error("Concurrent capture on one page");
 ACTIVE.add(page);
 const token=crypto.randomUUID?.() || "private-lab";
 let state=null,primaryFailure=null;
 try{
  state=await page.evaluate(async ({source,token,timeoutMs,sceneImport})=>{
   const owner=globalThis;
   if(owner.__samPrivateEpochFreeze)throw Error("Frame lease occupied");
   const {globalScene}=await import(/* @vite-ignore */ sceneImport);
   const game=globalScene?.game;
   if(!globalScene?.scene?.isActive?.()||
      !game?.events?.once||!game?.loop?.sleep||!game?.loop?.wake)
     throw Error("Phaser scene/loop not ready");
   const js=URL.createObjectURL(new Blob([source],{type:"text/javascript"}));
   let capture;
   try{
    const mod=await import(js);
    capture=mod.capturePhaserSprites;
   }finally{URL.revokeObjectURL(js);}
   if(typeof capture!=="function")throw Error("Scene probe unavailable");
   const events=game.events,loop=game.loop;
   let timer,listener,settled=false;
   const lease={token,loop,events,listener:null,frozen:false};
   owner.__samPrivateEpochFreeze=lease;
   const finish=(reject,value,resolve,fail)=>{
    if(settled)return;
    settled=true;clearTimeout(timer);
    try{events.off?.("postrender",listener);}catch{}
    if(reject)fail(value);else resolve(value);
   };
   try{
    return await new Promise((resolve,reject)=>{
     listener=()=>{
      if(settled)return;
      try{
       // postrender has completed; no further Phaser draws before screenshot.
       loop.sleep();lease.frozen=true;
       const frameTick=loop.frame;
       if(!Number.isSafeInteger(frameTick)||frameTick<1)
         throw Error("Missing render tick");
       const scene=capture(globalScene);
       if(!scene||scene.labOnly===true)
         throw Error("Unapproved lab-only scene");
       finish(false,{postrender:true,frameTick,scene},resolve,reject);
      }catch(e){finish(true,String(e?.message||e),resolve,reject);}
     };
     lease.listener=listener;
     events.once("postrender",listener);
     timer=setTimeout(()=>finish(true,"Phaser postrender deadline",resolve,reject),timeoutMs);
    }).then(result=>{
     if(typeof result==="string")throw Error(result);
     return result;
    });
   }catch(e){
    // For failed setup/probe, do not leave the tab asleep.
    try{if(lease.frozen)loop.wake();}catch{}
    if(owner.__samPrivateEpochFreeze===lease)delete owner.__samPrivateEpochFreeze;
    throw e;
   }
  },{source:captureSource,token,timeoutMs,sceneImport:LIVE_IMPORT});
  if(!state||state.postrender!==true||
     !Number.isSafeInteger(state.frameTick)||state.frameTick<1||
     state.scene?.schema!=="sam.coop.phaser-sprites.probe.v1")
   throw Error("Invalid Phaser capture callback");
  if(signal?.aborted)throw Error("Capture canceled after freeze");
  const png=await page.screenshot({timeout:Math.max(3000,timeoutMs),
    animations:"disabled"});
  if(signal?.aborted)throw Error("Capture canceled after screenshot");
  return {seat,postrender:true,frameTick:state.frameTick,relayCommitHash,
    png,scene:state.scene};
 }catch(e){primaryFailure=e;throw e;}
 finally{
  try{
   await page.evaluate(async ({token,sceneImport})=>{
    const lease=globalThis.__samPrivateEpochFreeze;
    if(lease?.token!==token)return;
    try{lease.events.off?.("postrender",lease.listener);}catch{}
    try{if(lease.frozen)lease.loop.wake();}finally{
      delete globalThis.__samPrivateEpochFreeze;
    }
   },{token,sceneImport:LIVE_IMPORT});
  }catch(e){
   // A closed/crashed page cannot be revived; make the cleanup failure visible
   // if capture had otherwise succeeded. The owner controls page restart.
   if(!primaryFailure)throw Error("Failed to resume captured Phaser page");
  }finally{ACTIVE.delete(page);}
 }
}
