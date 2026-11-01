// Private, button-driven paired frame state machine.
// Both seats advance as ONE logical commit, never independently.
// Verification and texture IO happen before the user's button press.
// The UI must render both seats offscreen before calling commitNext().
import {verifyThenFetchScenePair} from "./browser_scene_pair_verify_v1.mjs";
const LIMIT_PAIRS=4,LIMIT_BYTES=32*1024*1024;
export class VerifiedPairCursor{
 #verifier;#queued=[];#runId=null;#latestSeq=0;
 #current=null;#ordinal=0;#bytes=0;#pending=false;
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
   this.#runId=pair.runId;
   this.#latestSeq=pair.sequence;
   this.#queued.push({pair,bytes});
   this.#bytes+=bytes;
   return this.status;
  }finally{this.#pending=false;}
 }
 nextReady(){
  return this.#queued.length?this.#queued[0].pair:null;
 }
 commitNext(frameId){
  const top=this.#queued[0];
  if(!top||top.pair.frameId!==frameId)
    throw Error("Missing or stale paired commit");
  const expectedOrdinal=this.#ordinal+1;
  const previous=this.#current;
  this.#queued.shift();
  this.#bytes-=top.bytes;
  this.#current=top.pair;
  this.#ordinal=expectedOrdinal;
  return Object.freeze({step:this.#ordinal,frameId:this.#current.frameId,
    runId:this.#runId,sequence:this.#current.sequence,
    seats:this.#current.seats,previousFrameId:previous?.frameId??null});
 }
 reset(){
  if(this.#pending)throw Error("Cannot reset during verification");
  this.#queued.length=0;this.#current=null;this.#runId=null;
  this.#latestSeq=0;this.#ordinal=0;this.#bytes=0;
  return this.status;
 }
}
