// Format-agnostic, lossless XOR byte-run delta for SAM review experiments.
// Applies to ANY *byte sequence* (encoded scene state, frames, telemetry), not
// arbitrary JS objects without an explicit serializer. No gameplay semantics.
// Packet hashes are untrusted claims: decoding REQUIRES independently trusted
// base AND target SHA-256 digests, established by the caller's authenticated
// frame/run/sequence protocol. Never use this codec as authorization.
export const BYTE_DELTA_SCHEMA="sam.coop.agnostic-xor-byte-delta.v1";
const SCOPE="private-diagnostic-only";
const MAX_BYTES=4*1024*1024;
const MAX_RUNS=32768;
const HEX64=/^[0-9a-f]{64}$/;
const KEYS=["schema","scope","mode","baseLength","length",
 "baseSha256","targetSha256","payload"];
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&
 Object.keys(o).length===keys.length&&
 keys.every(k=>Object.hasOwn(o,k));

function snapshot(input){
 let view;
 if(input instanceof ArrayBuffer)view=new Uint8Array(input);
 else if(ArrayBuffer.isView(input)&&input.buffer instanceof ArrayBuffer)
  view=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
 else throw Error("Expected a non-shared ArrayBuffer or byte view");
 if(view.byteLength>MAX_BYTES)throw Error("Byte delta size limit");
 // Snapshot before asynchronous hashing: no alias to caller-owned data.
 return new Uint8Array(view);
}
async function sha256(bytes,subtle){
 if(!subtle||typeof subtle.digest!=="function")
  throw Error("SHA-256 implementation unavailable");
 const digest=await subtle.digest("SHA-256",bytes);
 return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0"))
  .join("");
}
function validatedPacket(packet){
 if(!exact(packet,KEYS)||packet.schema!==BYTE_DELTA_SCHEMA||
    packet.scope!==SCOPE||
    !["full","xor-runs"].includes(packet.mode)||
    !integer(packet.baseLength,MAX_BYTES)||
    !integer(packet.length,MAX_BYTES)||
    !HEX64.test(packet.baseSha256||"")||
    !HEX64.test(packet.targetSha256||"")||
    !(packet.payload instanceof Uint8Array)||
    !(packet.payload.buffer instanceof ArrayBuffer)||
    packet.payload.length>MAX_BYTES)
  throw Error("Invalid byte delta packet");
 if(packet.mode==="full"){
  if(packet.payload.length!==packet.length)
   throw Error("Full byte payload length mismatch");
 }else if(packet.baseLength!==packet.length||
          packet.length===0||packet.payload.length>=packet.length)
  throw Error("Invalid XOR delta size");
 return packet;
}
function fullPacket(base,next,baseSha256,targetSha256){
 return Object.freeze({
  schema:BYTE_DELTA_SCHEMA,scope:SCOPE,mode:"full",
  baseLength:base.length,length:next.length,
  baseSha256,targetSha256,payload:new Uint8Array(next)
 });
}
// The binary XOR payload consists of increasing non-adjacent runs:
// [offset:uint32 LE][length:uint32 LE][XOR bytes] repeated.
// Sparse unchanged regions are implicit. No payload is needed for equality.
// A dense/highly fragmented change falls back to a complete keyframe.
export async function encodeAgnosticXorDelta({
 before,after,subtle=globalThis.crypto?.subtle
}={}){
 const base=snapshot(before),next=snapshot(after);
 const [baseSha256,targetSha256]=await Promise.all([
  sha256(base,subtle),sha256(next,subtle)
 ]);
 if(base.length!==next.length||next.length===0)
  return fullPacket(base,next,baseSha256,targetSha256);
 const runs=[];
 let budget=0;
 for(let i=0;i<next.length;){
  if(base[i]===next[i]){i++;continue;}
  const start=i;
  do{i++;}while(i<next.length&&base[i]!==next[i]);
  const len=i-start;
  budget+=8+len;
  if(budget>=next.length||runs.length>=MAX_RUNS)
   return fullPacket(base,next,baseSha256,targetSha256);
  runs.push({start,len});
 }
 const payload=new Uint8Array(budget),dv=new DataView(payload.buffer);
 let p=0;
 for(const {start,len} of runs){
  dv.setUint32(p,start,true);
  dv.setUint32(p+4,len,true);
  p+=8;
  for(let i=0;i<len;i++)
   payload[p++]=base[start+i]^next[start+i];
 }
 return Object.freeze({
  schema:BYTE_DELTA_SCHEMA,scope:SCOPE,mode:"xor-runs",
  baseLength:base.length,length:next.length,
  baseSha256,targetSha256,payload
 });
}
// trustedBaseSha256 and trustedTargetSha256 MUST come from an independent,
// authenticated source. Copying packet.baseSha256/targetSha256 into these
// parameters defeats the trust boundary and is forbidden by contract.
export async function decodeAgnosticXorDelta({
 before,packet,trustedBaseSha256,trustedTargetSha256,
 subtle=globalThis.crypto?.subtle
}={}){
 const p=validatedPacket(packet);
 if(!HEX64.test(trustedBaseSha256||"")||
    !HEX64.test(trustedTargetSha256||"")||
    p.baseSha256!==trustedBaseSha256||
    p.targetSha256!==trustedTargetSha256)
  throw Error("Missing or mismatched independently trusted SHA-256 digest");
 const base=snapshot(before);
 if(base.length!==p.baseLength)
  throw Error("XOR delta base length mismatch");
 if(await sha256(base,subtle)!==trustedBaseSha256)
  throw Error("XOR delta baseline SHA-256 mismatch");
 let restored;
 if(p.mode==="full"){
  restored=new Uint8Array(p.payload);
 }else{
  restored=new Uint8Array(base);
  const bytes=p.payload,dv=new DataView(bytes.buffer,
   bytes.byteOffset,bytes.byteLength);
  let cursor=0,previousEnd=-1,runs=0;
  while(cursor<bytes.length){
   if(bytes.length-cursor<8)throw Error("Truncated XOR run header");
   const offset=dv.getUint32(cursor,true),
     len=dv.getUint32(cursor+4,true);
   cursor+=8;runs++;
   if(runs>MAX_RUNS||len===0||offset<=previousEnd||
      offset>restored.length||len>restored.length-offset||
      len>bytes.length-cursor)
    throw Error("Overlapping, malformed or out-of-bounds XOR run");
   // Canonical runs contain ONLY nonzero XOR bytes. Adjacent runs
   // are disallowed, to prevent multiple representations of one change.
   for(let j=0;j<len;j++){
    const xor=bytes[cursor+j];
    if(xor===0)throw Error("Noncanonical zero XOR byte");
    restored[offset+j]^=xor;
   }
   cursor+=len;
   previousEnd=offset+len;
  }
 }
 if(await sha256(restored,subtle)!==trustedTargetSha256)
  throw Error("Reconstructed target SHA-256 mismatch");
 return restored;
}
export function summarizeAgnosticXorDelta(packet){
 const p=validatedPacket(packet);
 return Object.freeze({
  mode:p.mode,originalBytes:p.length,payloadBytes:p.payload.length,
  payloadBytesSaved:p.length-p.payload.length,
  payloadFraction:p.length===0?1:p.payload.length/p.length,
  // Envelope/higher-layer transport metadata are NOT included.
  transportSavingsVerified:false,productionSceneEligible:false
 });
}
