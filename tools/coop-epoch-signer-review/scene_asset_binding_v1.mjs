// Private scene/asset binding gate. No network deployment or original-game upload.
// Only fully accepted, static, preapproved scenes may be turned into packets.
import {sha256,validateRegistry} from "./texture_registry_v1.mjs";
import {validateSpriteScene} from "./phaser_sprite_canvas.mjs";
export const SCHEMA="sam.coop.scene-assets-bound.v1";
const runPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const seats=new Set(["sam","jevbot"]);
const exactKeys=(obj,keys)=>!!obj&&typeof obj==="object"&&
   !Array.isArray(obj)&&Object.keys(obj).length===keys.length&&
   keys.every(key=>Object.hasOwn(obj,key));
const limits={maxBytes:110000,maxCommands:320};
function snapshotScene(scene){
 if(!validateSpriteScene(scene)||scene.labOnly===true||
    scene.coverage?.complete!==true||
    scene.commands.some(c=>c.shader||c.shadow||c.clip))
    throw Error("Unaccepted or approximated scene");
 const keys=new Set(["op","texture","src","dst","borders","matrix",
   "alpha","flipX","flipY","scroll"]);
 const commands=scene.commands.map(c=>{
  // Selectively copy the draw-only shape. No Phaser data or private fields.
  const copy={};
  for(const key of keys)if(Object.hasOwn(c,key))copy[key]=c[key];
  return copy;
 });
 const cam=scene.camera;
 const camera={width:cam.width,height:cam.height,
   x:cam.x,y:cam.y,scrollX:cam.scrollX,scrollY:cam.scrollY,zoom:cam.zoom};
 return {schema:scene.schema,visualScope:scene.visualScope,camera,commands};
}
export function bindScene({scene,manifest,runId,seat,sequence}){
 if(!validateRegistry(manifest))throw Error("Invalid approved texture catalog");
 if(!runPattern.test(runId||"")||!seats.has(seat)||
   !Number.isSafeInteger(sequence)||sequence<1||sequence>100000000)
   throw Error("Invalid run/seat/frame identity");
 const sanitized=snapshotScene(scene);
 if(sanitized.commands.length<1||sanitized.commands.length>limits.maxCommands)
   throw Error("Empty or overlarge scene");
 const approved=new Set(manifest.textures.map(x=>x.href));
 if(sanitized.commands.some(c=>!approved.has(c.texture)))
   throw Error("Unapproved scene texture reference");
 const base={schema:SCHEMA,scope:"private-staging-only",
   runId,seat,sequence,frameId:runId+":"+sequence,
   manifestDigest:manifest.digest,scene:sanitized};
 const serialized=JSON.stringify(base);
 if(serialized.length>limits.maxBytes)throw Error("Scene exceeds byte limit");
 return {...base,digest:sha256(Buffer.from(serialized))};
}
export function validateBoundScene(packet,manifest){
 if(!exactKeys(packet,["schema","scope","runId","seat","sequence",
      "frameId","manifestDigest","scene","digest"])||
    !validateRegistry(manifest)||packet.schema!==SCHEMA||
    packet.scope!=="private-staging-only"||
    !runPattern.test(packet.runId||"")||!seats.has(packet.seat)||
    !Number.isSafeInteger(packet.sequence)||packet.sequence<1||
    packet.sequence>100000000||packet.frameId!==packet.runId+":"+packet.sequence||
    packet.manifestDigest!==manifest.digest)return false;
 try{
  const base={schema:packet.schema,scope:packet.scope,runId:packet.runId,
    seat:packet.seat,sequence:packet.sequence,frameId:packet.frameId,
    manifestDigest:packet.manifestDigest,scene:packet.scene};
  if(JSON.stringify(base).length>limits.maxBytes ||
     sha256(Buffer.from(JSON.stringify(base)))!==packet.digest)return false;
  const s=packet.scene;
  if(!exactKeys(s,["schema","visualScope","camera","commands"])||
     !exactKeys(s.camera,["width","height","x","y","scrollX",
       "scrollY","zoom"])||
     s.schema!=="sam.coop.phaser-sprites.probe.v1"||
     s.visualScope!=="partial-original-sprites"||!Array.isArray(s.commands)||
     s.commands.length<1||s.commands.length>limits.maxCommands)return false;
  const allowed=new Set(manifest.textures.map(x=>x.href));
  if(s.commands.some(c=>!allowed.has(c.texture)||
    c.clip!==undefined||c.shader!==undefined||c.shadow!==undefined ||
    Object.keys(c).some(k=>!["op","texture","src","dst","borders","matrix",
      "alpha","flipX","flipY","scroll"].includes(k))))return false;
  return validateSpriteScene({
    ...s,labOnly:false,
    coverage:{captured:s.commands.length,complete:true,truncated:false,
      approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
      skipped:{}},
  });
 }catch{return false;}
}
export function bindPairedScenes(sam,jevbot,manifest){
 if(!validateBoundScene(sam,manifest)||!validateBoundScene(jevbot,manifest)||
    sam.seat!=="sam"||jevbot.seat!=="jevbot"||
    sam.runId!==jevbot.runId||
    sam.sequence!==jevbot.sequence||
    sam.frameId!==jevbot.frameId)return null;
 const base={schema:"sam.coop.scene-pair.v1",scope:"private-staging-only",
   frameId:sam.frameId,sequence:sam.sequence,runId:sam.runId,
   manifestDigest:manifest.digest,samDigest:sam.digest,jevbotDigest:jevbot.digest};
 return {...base,digest:sha256(Buffer.from(JSON.stringify(base)))};
}
