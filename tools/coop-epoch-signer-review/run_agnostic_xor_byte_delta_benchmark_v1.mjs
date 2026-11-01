// Standalone hosted-Node-only synthetic XOR byte-delta experiment.
// This is not a live stream, Pi benchmark, production game protocol,
// authorized scene capture, or proof of network savings.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {encodeAgnosticXorDelta,decodeAgnosticXorDelta,
 summarizeAgnosticXorDelta} from "./agnostic_xor_byte_delta_v1.mjs";
const WIDTH=320,HEIGHT=180,CHANNELS=4,FRAMES=48;
const PIXEL_BYTES=WIDTH*HEIGHT*CHANNELS;
const sha=data=>createHash("sha256").update(data).digest("hex");
function generatedFrame(sequence,seat){
 const result=new Uint8Array(PIXEL_BYTES);
 for(let i=0;i<result.length;i+=4){
  result[i]=18;result[i+1]=35;result[i+2]=63;result[i+3]=255;
 }
 const x=(sequence*(seat==="sam"?7:11))%(WIDTH-17);
 const y=(sequence*(seat==="sam"?3:5))%(HEIGHT-17);
 for(let dy=0;dy<16;dy++)for(let dx=0;dx<16;dx++){
  const at=((y+dy)*WIDTH+(x+dx))*4;
  result[at]=seat==="sam"?221:72;
  result[at+1]=90;result[at+2]=201;result[at+3]=190;
 }
 return result;
}
const stats={
 rawBytes:0,payloadBytes:0,fullPackets:0,deltaPackets:0,
 encodeMs:[],decodeMs:[],pairedComparisons:0,
 xorPacketsWithChanges:0
};
const percentile=(a,f)=>{
 const sorted=[...a].sort((x,y)=>x-y);
 return sorted[Math.max(0,Math.ceil(sorted.length*f)-1)];
};
for(const seat of ["sam","jevbot"]){
 let base=generatedFrame(1,seat);
 for(let sequence=2;sequence<=FRAMES;sequence++){
  const next=generatedFrame(sequence,seat);
  const trustedBaseSha256=sha(base),trustedTargetSha256=sha(next);
  const t0=performance.now();
  const packet=await encodeAgnosticXorDelta({before:base,after:next});
  const t1=performance.now();
  const restored=await decodeAgnosticXorDelta({
   before:base,packet,trustedBaseSha256,trustedTargetSha256
  });
  const t2=performance.now();
  assert.deepEqual(restored,next);
  assert.equal(sha(restored),trustedTargetSha256);
  const summary=summarizeAgnosticXorDelta(packet);
  assert.equal(summary.originalBytes,PIXEL_BYTES);
  stats.rawBytes+=PIXEL_BYTES;
  stats.payloadBytes+=summary.payloadBytes;
  stats.fullPackets+=(packet.mode==="full");
  stats.deltaPackets+=(packet.mode==="xor-runs");
  stats.xorPacketsWithChanges+=(
   packet.mode==="xor-runs"&&packet.payload.length>0);
  stats.encodeMs.push(t1-t0);stats.decodeMs.push(t2-t1);
  stats.pairedComparisons++;
  base=next;
 }
}
assert.equal(stats.pairedComparisons,(FRAMES-1)*2);
assert.equal(stats.fullPackets,0);
assert.equal(stats.deltaPackets,(FRAMES-1)*2);
assert.ok(stats.payloadBytes<stats.rawBytes/5);
console.log("AGNOSTIC_XOR_SPARSE_FRAME_CODEC_OK",JSON.stringify({
 scenario:"synthetic-320x180-RGBA-16x16-moving-sprites",
 signedInput:false,liveGame:false,productionEligible:false,
 framesPerSeat:FRAMES,seats:2,comparedSeatFrames:stats.pairedComparisons,
 fullPackets:stats.fullPackets,deltaPackets:stats.deltaPackets,
 rawBytes:stats.rawBytes,payloadBytes:stats.payloadBytes,
 payloadSavingsFraction:+(1-stats.payloadBytes/stats.rawBytes).toFixed(4),
 payloadIncludesEnvelope:false,
 xorPacketsWithChanges:stats.xorPacketsWithChanges,
 encodeP50Ms:+percentile(stats.encodeMs,.5).toFixed(3),
 encodeP95Ms:+percentile(stats.encodeMs,.95).toFixed(3),
 decodeP50Ms:+percentile(stats.decodeMs,.5).toFixed(3),
 decodeP95Ms:+percentile(stats.decodeMs,.95).toFixed(3)
}));
