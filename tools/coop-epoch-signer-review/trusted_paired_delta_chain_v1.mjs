// Private review-only paired byte-delta receiver: stateful, independently
// pinned Ed25519 chain. No browser-originated key trust, no game provenance.
// A new runId + signed keyframe is mandatory for recovery after a lost link.
import {decodeAgnosticXorDelta} from "./agnostic_xor_byte_delta_v1.mjs";

export const CHAINED_BYTE_FRAME_SCHEMA="sam.coop.review.chained-byte-frame.v1";
const SCOPE="private-staging-only";
const SEATS=["sam","jevbot"];
const RUN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const HEX=d=>typeof d==="string"&&DIGEST.test(d);
const SIZE=4*1024*1024;
const STATEMENT_FIELDS=[
 "schema","scope","runId","seat","sequence","frameId","kind",
 "baseSha256","targetSha256","byteLength"
];
const SIGNED_FIELDS=["statement","signature","delta"];
const DELTA_FIELDS=["schema","scope","mode","baseLength","length",
 "baseSha256","targetSha256","payload"];
const SPKI_PREFIX=[48,42,48,5,6,3,43,101,112,3,33,0];
const exact=(o,keys)=>o!==null&&typeof o==="object"&&
 !Array.isArray(o)&&Object.keys(o).length===keys.length&&
 keys.every(k=>Object.hasOwn(o,k));
const validSeq=n=>Number.isSafeInteger(n)&&n>=1&&n<=100000000;
function copyBytes(input){
 let bytes;
 if(input instanceof Uint8Array&&input.buffer instanceof ArrayBuffer)
  bytes=input;
 else if(Array.isArray(input)&&input.length<=SIZE&&input.every(
  v=>Number.isInteger(v)&&v>=0&&v<=255))bytes=Uint8Array.from(input);
 else throw Error("Untrusted or overlarge byte delta payload");
 if(bytes.length>SIZE)throw Error("Byte delta payload budget");
 return new Uint8Array(bytes);
}
function canonicalSignature(value){
 if(typeof value!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(value))
  throw Error("Invalid signed byte frame signature");
 let raw;
 try{
  raw=Uint8Array.from(atob(value.replace(/-/g,"+")
   .replace(/_/g,"/")+"=="),x=>x.charCodeAt(0));
 }catch{throw Error("Invalid base64url signature");}
 const encoded=btoa(String.fromCharCode(...raw))
  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
 if(raw.length!==64||encoded!==value)
  throw Error("Noncanonical signed byte frame signature");
 return raw;
}
function cloneAndCheckPacket(original){
 if(!exact(original,SIGNED_FIELDS)||
    !exact(original.statement,STATEMENT_FIELDS)||
    !exact(original.delta,DELTA_FIELDS))
  throw Error("Invalid signed byte frame envelope");
 const statement={...original.statement};
 const delta={...original.delta,payload:copyBytes(original.delta.payload)};
 const signature=canonicalSignature(original.signature);
 return {statement,delta,signature};
}
export class TrustedPairedByteDeltaReceiver{
 #keyPromise;#runId;#pending=null;#committed=null;#retired=new Set();
 #busy=false;#nextAdmission=1;
 constructor({trustedRunId,pinnedSpki}={}){
  if(!RUN.test(trustedRunId||"")||
     !(pinnedSpki instanceof Uint8Array)||
     !(pinnedSpki.buffer instanceof ArrayBuffer)||
     pinnedSpki.length!==44||
     !SPKI_PREFIX.every((v,i)=>pinnedSpki[i]===v))
   throw Error("Trusted runId and Ed25519 SPKI required");
  this.#runId=trustedRunId;
  // The identity is provisioned by the owner, NEVER read from the packet.
  const pinned=new Uint8Array(pinnedSpki);
  this.#keyPromise=crypto.subtle.importKey("spki",pinned,
   {name:"Ed25519"},false,["verify"]);
 }
 get status(){
  return Object.freeze({runId:this.#runId,
   committedSequence:this.#committed?.sequence??null,
   committedFrameId:this.#committed?.frameId??null,
   pendingFrameId:this.#pending?.frameId??null,
   pendingAdmission:this.#pending?.admissionId??null,
   busy:this.#busy,productionSceneEligible:false});
 }
 async #verifyOne(input,seat,sequence,previous,key){
  const {statement:s,delta,signature}=cloneAndCheckPacket(input);
  if(s.schema!==CHAINED_BYTE_FRAME_SCHEMA||s.scope!==SCOPE||
     s.runId!==this.#runId||s.seat!==seat||
     s.sequence!==sequence||s.frameId!==this.#runId+":"+sequence||
     !HEX(s.baseSha256)||!HEX(s.targetSha256)||
     !Number.isSafeInteger(s.byteLength)||
     s.byteLength<1||s.byteLength>SIZE||
     !["keyframe","delta"].includes(s.kind))
   throw Error("Signed byte frame identity invalid");
  const first=previous===null;
  if(first?(s.kind!=="keyframe"||sequence!==1):
   (s.kind!=="delta"||sequence!==previous.sequence+1||
     s.baseSha256!==previous.digests[seat]))
   throw Error("Missing or crossed committed baseline; new run keyframe required");
  const wire=new TextEncoder().encode(JSON.stringify(s));
  if(!await crypto.subtle.verify("Ed25519",key,signature,wire))
   throw Error("Untrusted signed byte frame statement");
  if(delta.baseSha256!==s.baseSha256||
     delta.targetSha256!==s.targetSha256||
     delta.length!==s.byteLength)
   throw Error("Signed byte frame and XOR payload mismatch");
  if(first&&(delta.mode!=="full"||delta.baseLength!==0))
   throw Error("Initial keyframe must contain an independently signed full snapshot");
  const baseline=first?new Uint8Array(0):previous.pixels[seat];
  return decodeAgnosticXorDelta({
   before:baseline,packet:delta,
   trustedBaseSha256:s.baseSha256,
   trustedTargetSha256:s.targetSha256
  });
 }
 // stage is single-flight and no future frame may be verified against an
 // uncommitted baseline. Errors never change the last accepted snapshot.
 async stage({sam,jevbot}={}){
  if(this.#busy||this.#pending)
   throw Error("Paired byte frame admission already pending");
  this.#busy=true;
  const previous=this.#committed;
  const sequence=previous?previous.sequence+1:1;
  try{
   const key=await this.#keyPromise;
   // Both signatures must pass before either reconstructed result is used.
   const [a,b]=await Promise.all([
    this.#verifyOne(sam,"sam",sequence,previous,key),
    this.#verifyOne(jevbot,"jevbot",sequence,previous,key)
   ]);
   const frameId=this.#runId+":"+sequence;
   const admissionId=this.#nextAdmission++;
   if(!Number.isSafeInteger(admissionId)||!Number.isSafeInteger(this.#nextAdmission))
    throw Error("Paired byte admission counter exhausted");
   const digests={sam:sam.statement.targetSha256,
    jevbot:jevbot.statement.targetSha256};
   this.#pending={runId:this.#runId,sequence,frameId,admissionId,
    pixels:{sam:new Uint8Array(a),jevbot:new Uint8Array(b)},digests};
   // The paired scene cursor copies all seat byte data at admission.
   // A dummy 1-byte texture is private protocol plumbing, NOT a license
   // declaration or actual texture; no network fetch is performed.
   return {scope:SCOPE,runId:this.#runId,sequence,frameId,
    admissionId,seats:{
     sam:{pixels:new Uint8Array(a)},jevbot:{pixels:new Uint8Array(b)}},
    textures:new Map([["synthetic-signed-byte-frame",new Uint8Array([1])]])};
  }finally{this.#busy=false;}
 }
 // Only call this with the result of a successful atomic viewer press.
 commit({frameId,admissionId,sequence}={}){
  const p=this.#pending;
  if(this.#busy||!p||p.frameId!==frameId||
     p.admissionId!==admissionId||p.sequence!==sequence)
   throw Error("No matching completed atomic paired-frame admission");
  this.#committed=p;
  this.#pending=null;
  return this.status;
 }
 discard(){
  if(this.#busy)throw Error("Cannot discard during verification");
  this.#pending=null;
  return this.status;
 }
 // Recovery must reset the cursor+viewer in the same owner-controlled action.
 // Never reuse a spent run ID or silently splice across a missing sequence.
 beginNewRun(trustedRunId){
  if(this.#busy||this.#pending)
   throw Error("Discard pending admission before new-run recovery");
  if(!RUN.test(trustedRunId||"")||
     trustedRunId===this.#runId||
     this.#retired.has(trustedRunId)||
     this.#retired.size>=64)
   throw Error("Recovery requires a fresh owner-provisioned run ID");
  this.#retired.add(this.#runId);
  this.#runId=trustedRunId;
  this.#committed=null;
  return this.status;
 }
}
