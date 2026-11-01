// Private, button-driven paired frame state machine.
// Both seats advance as ONE logical commit, never independently.
// Verification and texture IO happen before the user's button press.
// The UI must render both seats offscreen before calling commitNext().
import {verifyThenFetchScenePair} from "./browser_scene_pair_verify_v1.mjs";
const LIMIT_PAIRS=4,LIMIT_BYTES=32*1024*1024;
export class VerifiedPairCursor{
 #verifier;#queued=[];#runId=null;#latestSeq=0;
 #current=null;#ordinal=0;#bytes=0;#pending=false;#admissionId=0;
 constructor({verifier=verifyThenFetchScenePair}={}){
  if(typeof verifier!=="function")throw Error("Verifier required");
  this.#verifier=verifier;
 }
 get status(){
  return Object.freeze({step:this.#ordinal,frameId:this.#current?.frameId??null,
    runId:this.#runId,queued:this.#queued.length,
    stagedThrough:this.#latestSeq,waiting:this.#pending});
 }
 #countBytes(pair){
  if(!(pair?.textures instanceof Map))throw Error("Unverified pair textures");
  let bytes=0;
  for(const [href,data] of pair.textures){
    if(typeof href!=="string"||!(data instanceof Uint8Array))
      throw Error("Invalid verified texture");
    bytes+=data.byteLength;
  }
  return bytes;
 }

 // Admit a detached snapshot of the independently verified pair.
 // Uint8Array cannot be frozen safely; every public read gets fresh bytes.
 #snapshot(pair){
  let seats;
  try{seats=structuredClone(pair.seats);}
  catch{throw Error("Uncloneable verified seat scenes");}
  if(!seats?.sam||!seats?.jevbot)
    throw Error("Missing seat scenes");
  const textures=new Map();
  for(const [href,data] of pair.textures)
    textures.set(href,new Uint8Array(data));
  return {scope:pair.scope,frameId:pair.frameId,
    runId:pair.runId,sequence:pair.sequence,seats,textures};
 }

 async stage(args){
  if(this.#pending)throw Error("Concurrent pair verification blocked");
  if(this.#queued.length>=LIMIT_PAIRS)throw Error("Paired frame buffer full");
  this.#pending=true;
  try{
   const pair=await this.#verifier(args);
   if(pair?.scope!=="private-staging-only"||
      typeof pair?.frameId!=="string"||
      !/^[a-f0-9-]{36}:[1-9][0-9]*$/.test(pair.frameId)||
      !Number.isSafeInteger(pair.sequence)||pair.sequence<1||
      pair.frameId!==pair.runId+":"+pair.sequence||
      !pair.seats?.sam||!pair.seats?.jevbot)
     throw Error("Invalid verified frame result");
   const bytes=this.#countBytes(pair);
   if(bytes>16*1024*1024||this.#bytes+bytes>LIMIT_BYTES)
     throw Error("Frame memory budget");
   if(this.#runId!==null&&pair.runId!==this.#runId)
     throw Error("Cross-run paired frame rejected");
   if(this.#latestSeq!==0&&pair.sequence!==this.#latestSeq+1)
     throw Error("Out-of-order, missing or replayed frame");
   const admitted=this.#snapshot(pair);
   this.#runId=admitted.runId;
   this.#latestSeq=admitted.sequence;
   // Monotonic for this cursor instance, even across resets.
   if(!Number.isSafeInteger(this.#admissionId+1))
     throw Error("Admission counter exhausted");
   this.#queued.push({pair:admitted,bytes,id:++this.#admissionId});
   this.#bytes+=bytes;
   return this.status;
  }finally{this.#pending=false;}
 }
 nextReady(){
  const top=this.#queued[0];
  return top?{...this.#snapshot(top.pair),admissionId:top.id}:null;
 }
 commitNext(frameId,admissionId=undefined){
  const top=this.#queued[0];
  if(!top||top.pair.frameId!==frameId||
     (admissionId!==undefined&&top.id!==admissionId))
    throw Error("Missing or stale paired commit");
  const expectedOrdinal=this.#ordinal+1;
  const previous=this.#current;
  this.#queued.shift();
  this.#bytes-=top.bytes;
  this.#current=top.pair;
  this.#ordinal=expectedOrdinal;
  return Object.freeze({step:this.#ordinal,frameId:this.#current.frameId,
    runId:this.#runId,sequence:this.#current.sequence,
    seats:structuredClone(this.#current.seats),
    previousFrameId:previous?.frameId??null});
 }
 // Reject one staged, not-yet-committed pair without losing the last
 // visible/committed frame. Keep the admission counter monotonic so a
 // discarded pane can never be replayed with the same admission ID.
 // Restrict this operation to a single pending entry; removing the head
 // of a longer queue would make all later verification context ambiguous.
 discardPending(frameId,admissionId){
  if(this.#pending||this.#queued.length!==1)
   throw Error("Exactly one completed pending frame required");
  const top=this.#queued[0];
  if(top.pair.frameId!==frameId||top.id!==admissionId)
   throw Error("Stale paired discard admission");
  this.#queued.length=0;
  this.#bytes=0;
  this.#latestSeq=this.#current?.sequence??0;
  this.#runId=this.#current?.runId??null;
  return this.status;
 }
 reset(){
  if(this.#pending)throw Error("Cannot reset during verification");
  this.#queued.length=0;this.#current=null;this.#runId=null;
  this.#latestSeq=0;this.#ordinal=0;this.#bytes=0;
  return this.status;
 }
}
