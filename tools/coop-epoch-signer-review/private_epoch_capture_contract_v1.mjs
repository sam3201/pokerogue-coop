// Private design contract for the existing co-op capture worker.
// No integration into active gameplay, disk writes, signing or publication.
// A relay checkpoint before and after two POSTRENDER captures must match;
// this diagnostic ALONE does not authenticate relay provenance.
import {createHash} from "node:crypto";
import {validateSpriteScene} from "./phaser_sprite_canvas.mjs";
const sha=b=>createHash("sha256").update(b).digest("hex");
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SEATS=["sam","jevbot"];
const keys=(o,k)=>!!o&&typeof o==="object"&&!Array.isArray(o)&&
  Object.keys(o).length===k.length&&k.every(x=>Object.hasOwn(o,x));
function fail(why){throw Error("Unaccepted epoch: "+why);}
function logicalState(x,runId){
 if(!keys(x,["runId","relayCommitHash","gameStateHash"])||
    x.runId!==runId||!HEX.test(x.relayCommitHash)||
    !HEX.test(x.gameStateHash))fail("relay checkpoint");
 return {relayCommitHash:x.relayCommitHash,gameStateHash:x.gameStateHash};
}
function pngCheck(x){
 const b=Buffer.isBuffer(x)?x:(x instanceof Uint8Array?Buffer.from(x):null);
 if(!b||b.length<1400||b.length>500000||
    b.subarray(0,8).toString("hex")!=="89504e470d0a1a0a"||
    b.length<33||b.readUInt32BE(8)!==13||
    b.toString("ascii",12,16)!=="IHDR")fail("PNG evidence");
 const width=b.readUInt32BE(16),height=b.readUInt32BE(20);
 if(![[320,180],[640,360]].some(([w,h])=>w===width&&h===height))
   fail("capture dimensions");
 return {bytes:b.length,width,height,sha256:sha(b)};
}
function sceneEvidence(scene){
 if(!keys(scene,["schema","visualScope","labOnly","camera",
       "commands","coverage"])||
    !keys(scene.camera,["width","height","x","y","scrollX",
       "scrollY","zoom"])||
    !keys(scene.coverage,["inspected","captured","skipped",
       "approximated","truncated","complete"])||
    scene.commands.some(c=>!c||Object.keys(c).some(k=>!
      ["op","texture","src","dst","borders","clip","shader","shadow",
       "matrix","alpha","flipX","flipY","scroll"].includes(k)))||
    Object.keys(scene.coverage.skipped).some(k=>!
      /^[a-z][a-z-]{0,50}$/.test(k))||
    !validateSpriteScene(scene,{allowLabMemory:true})||
    scene.commands.length<1||scene.commands.length>320)
   fail("scene protocol");
 const json=JSON.stringify(scene);
 if(Buffer.byteLength(json)>96000)fail("scene byte budget");
 // The scene itself stays in the private capture result; no payload serialized
 // into the receipt, and lab-only sources cannot pass production.
 return {sha256:sha(Buffer.from(json)),commands:scene.commands.length,
   complete:scene.coverage?.complete===true,labOnly:scene.labOnly===true};
}
function captureEvidence(seat,data,expected){
 if(!keys(data,["seat","postrender","frameTick","relayCommitHash","png","scene"])||
    data.seat!==seat||data.postrender!==true||
    !Number.isSafeInteger(data.frameTick)||data.frameTick<1||
    data.relayCommitHash!==expected.relayCommitHash)
   fail("missing postrender epoch evidence");
 return {png:pngCheck(data.png),scene:sceneEvidence(data.scene),
   frameTick:data.frameTick};
}
export async function preparePrivateEpoch({
  runId,sequence,readRelayCheckpoint,captureSeat,signal
}){
 if(!UUID.test(runId||"")||!Number.isSafeInteger(sequence)||
    sequence<1||sequence>100000000||
    typeof readRelayCheckpoint!=="function"||
    typeof captureSeat!=="function"||
    signal?.aborted)fail("invalid capture invocation");
 const before=logicalState(await readRelayCheckpoint(),runId);
 if(signal?.aborted)fail("aborted before capture");
 // The owner-supplied capture callback MUST perform postrender freeze and
 // screenshot/scene extraction in the original browser capture transaction.
 // This helper never claims that a self-reported flag proves provenance.
 const settled=await Promise.allSettled(SEATS.map(seat=>
   Promise.resolve().then(()=>captureSeat(seat,{runId,sequence,
     relayCommitHash:before.relayCommitHash,signal}))));
 // A rejected Promise.all can return while the surviving seat is still
 // frozen. Always settle both callbacks before rejecting a failed pair.
 if(settled.some(x=>x.status!=="fulfilled"))
   fail("one or both seat captures failed");
 const responses=settled.map(x=>x.value);
 if(signal?.aborted)fail("capture canceled");
 const seen={
   sam:captureEvidence("sam",responses[0],before),
   jevbot:captureEvidence("jevbot",responses[1],before)
 };
 const after=logicalState(await readRelayCheckpoint(),runId);
 if(after.relayCommitHash!==before.relayCommitHash||
    after.gameStateHash!==before.gameStateHash)
   fail("relay state advanced during capture");
 const frameId=runId+":"+sequence,capturedAt=new Date().toISOString();
 const frameSync={
   schema:1,runId,sequence,capturedAt,
   hashes:{sam:seen.sam.png.sha256,jevbot:seen.jevbot.png.sha256}
 };
 const receipt={schema:"sam.coop.scene-epoch-diagnostic.v1",
   scope:"private-only",runId,sequence,frameId,
   relayCommitHash:before.relayCommitHash,
   gameStateHash:before.gameStateHash,
   frameManifestHash:sha(Buffer.from(JSON.stringify(frameSync))),
   pngHashes:{sam:seen.sam.png.sha256,jevbot:seen.jevbot.png.sha256},
   sceneHashes:{sam:seen.sam.scene.sha256,jevbot:seen.jevbot.scene.sha256},
   frameTicks:{sam:seen.sam.frameTick,jevbot:seen.jevbot.frameTick},
   sceneComplete:seen.sam.scene.complete&&seen.jevbot.scene.complete,
   source:"caller-supplied-postrender",
   issuerAuthenticated:false,sceneEpochAttested:false,
   productionSceneEligible:false};
 return {frameSync,receipt,
   // Caller owns any actual memory or durable write; nothing is published.
   frames:{sam:responses[0].png,jevbot:responses[1].png},
   scenes:{sam:responses[0].scene,jevbot:responses[1].scene}};
}
export function inspectPrivateEpoch(e){
 if(!e||e.receipt?.schema!=="sam.coop.scene-epoch-diagnostic.v1"||
    e.receipt?.scope!=="private-only"||
    e.receipt?.issuerAuthenticated!==false||
    e.receipt?.productionSceneEligible!==false||
    e.receipt?.sceneEpochAttested!==false)return false;
 try{
  const w=e.frameSync,r=e.receipt;
  if(w.schema!==1||w.runId!==r.runId||w.sequence!==r.sequence||
    w.runId+":"+w.sequence!==r.frameId||
    sha(Buffer.from(JSON.stringify(w)))!==r.frameManifestHash)return false;
  for(const seat of SEATS){
   if(pngCheck(e.frames[seat]).sha256!==r.pngHashes[seat]||
      w.hashes[seat]!==r.pngHashes[seat]||
      sceneEvidence(e.scenes[seat]).sha256!==r.sceneHashes[seat])
     return false;
  }
  return true;
 }catch{return false;}
}
