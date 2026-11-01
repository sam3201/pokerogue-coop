// Private, review-only compositor for browser-verified scene pairs.
// Decodes ONLY previously validated content-addressed PNG bytes in memory,
// renders both seats offscreen, then exposes synchronous DOM nodes to the
// atomic presenter. Neither source acceptance nor scene provenance is
// upgraded: real-game visual fidelity remains an independent release gate.
import {PhaserSpriteCanvas} from "./phaser_sprite_canvas.mjs";

const allowedSeats=["sam","jevbot"];
function fullScene(scene) {
 // A signed, browser-verified bound scene deliberately omits capture
 // coverage metadata. This is a temporary drawing adapter, NOT an
 // independent claim that the real Phaser scene was completely captured.
 if(!scene||!Array.isArray(scene.commands)||!scene.commands.length)
  throw Error("Missing verified scene commands");
 return {...scene,labOnly:false,coverage:{
  inspected:scene.commands.length,captured:scene.commands.length,
  skipped:{},approximated:{
   fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
  truncated:false,complete:true}};
}
export class PrivateVerifiedCanvasRenderer {
 #doc;#prepared=null;#busy=false;
 constructor({document}={}){
  if(!document?.createElement)
   throw Error("Browser document required");
  this.#doc=document;
 }
 get status(){
  return Object.freeze({
   preparedFrameId:this.#prepared?.frameId??null,
   admissionId:this.#prepared?.admissionId??null,
   ready:this.#prepared!==null,busy:this.#busy,
   productionSceneEligible:false
  });
 }
 async prepare(pair,{outputWidth=320}={}){
  if(this.#busy)throw Error("Overlapping verified rendering");
  if(![320,640].includes(outputWidth)||
     pair?.scope!=="private-staging-only"||
     !Number.isSafeInteger(pair.admissionId)||pair.admissionId<1||
     pair.frameId!==pair.runId+":"+pair.sequence||
     !pair.seats?.sam||!pair.seats?.jevbot||
     !(pair.textures instanceof Map)||
     pair.textures.size<1||pair.textures.size>64)
   throw Error("Invalid private rendering admission");
  this.#busy=true;
  this.#prepared=null;
  const bitmaps=new Map();
  try{
   let total=0;
   for(const [href,bytes] of pair.textures){
    if(typeof href!=="string"||
       !/^\/images\/approved-sha256\/[a-f0-9]{64}\.png$/.test(href)||
       !(bytes instanceof Uint8Array)||bytes.length<57||
       bytes.length>4*1024*1024)
     throw Error("Invalid approved image bytes");
    total+=bytes.byteLength;
    if(total>16*1024*1024)
     throw Error("Approved texture budget exceeded");
    if(typeof createImageBitmap!=="function")
     throw Error("Browser bitmap decoder unavailable");
    const image=await createImageBitmap(
     new Blob([bytes],{type:"image/png"}));
    if(image.width<1||image.height<1||
       image.width*image.height>4*1024*1024)
     throw Error("Decoded texture dimensions exceeded");
    bitmaps.set(href,image);
   }
   const rendered={},sceneImages={};
   for(const seat of allowedSeats){
    const scene=pair.seats[seat];
    const encoded=JSON.stringify(scene);
    if(encoded.length>110000)
     throw Error("Seat scene exceeds verified byte budget");
    for(const command of scene.commands){
     if(!bitmaps.has(command.texture))
      throw Error("Verified scene refers to an absent texture");
    }
    const canvas=this.#doc.createElement("canvas");
    const compositor=new PhaserSpriteCanvas(canvas,async path=>{
     if(!bitmaps.has(path))throw Error("Unverified texture requested");
     return bitmaps.get(path);
    });
    const result=await compositor.render(fullScene(scene),{
     labOutputWidth:outputWidth,allowPartial:false});
    if(result.ok!==true)
     throw Error("Refused private scene rendering: "+result.reason);
    if(canvas.width!==outputWidth||canvas.height!==outputWidth*9/16)
     throw Error("Unexpected render dimensions");
    canvas.dataset.seat=seat;
    canvas.dataset.frameId=pair.frameId;
    canvas.dataset.sequence=String(pair.sequence);
    sceneImages[seat]=encoded;
    rendered[seat]=canvas;
   }
   // The actual DOM canvas remains detached until the button is pressed.
   this.#prepared={admissionId:pair.admissionId,frameId:pair.frameId,
    runId:pair.runId,sequence:pair.sequence,rendered,sceneImages};
   return this.status;
  }finally{
   for(const bitmap of bitmaps.values())bitmap.close();
   this.#busy=false;
  }
 }
 // This must be called synchronously by PairedFramePresenter.prepareNext().
 // Stale or changed seat content fails closed before altering the visible DOM.
 renderSeat=({seat,scene,frameId,sequence,runId,admissionId})=>{
  const p=this.#prepared;
  if(!p||!allowedSeats.includes(seat)||
     p.frameId!==frameId||p.runId!==runId||
     p.sequence!==sequence||p.admissionId!==admissionId||
     JSON.stringify(scene)!==p.sceneImages[seat])
   throw Error("Renderer admission or scene changed");
  const canvas=p.rendered[seat];
  if(!canvas||canvas.isConnected||canvas.parentNode!==null)
   throw Error("Prepared seat canvas already consumed");
  return canvas;
 };
 clear(){this.#prepared=null;return this.status;}
}
