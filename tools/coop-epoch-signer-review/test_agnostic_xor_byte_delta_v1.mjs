import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {encodeAgnosticXorDelta,decodeAgnosticXorDelta,
 summarizeAgnosticXorDelta,BYTE_DELTA_SCHEMA}
 from "./agnostic_xor_byte_delta_v1.mjs";
const asBytes=x=>x instanceof ArrayBuffer?new Uint8Array(x):
 ArrayBuffer.isView(x)?new Uint8Array(x.buffer,x.byteOffset,x.byteLength):x;
const sha=x=>createHash("sha256").update(asBytes(x)).digest("hex");
const bytes=x=>new Uint8Array(x);
async function roundtrip(a,b){
 const packet=await encodeAgnosticXorDelta({before:a,after:b});
 const result=await decodeAgnosticXorDelta({
  before:a,packet,trustedBaseSha256:sha(a),
  trustedTargetSha256:sha(b)
 });
 assert.deepEqual(result,new Uint8Array(b));
 return packet;
}
test("sparse binary changes make lossless XOR run payload smaller",async()=>{
 const a=new Uint8Array(2048),b=new Uint8Array(a);
 b[2]=3;b[3]=4;b[1800]=127;
 const p=await roundtrip(a,b);
 assert.equal(p.schema,BYTE_DELTA_SCHEMA);
 assert.equal(p.mode,"xor-runs");
 assert.equal(p.payload.length,19);
 const summary=summarizeAgnosticXorDelta(p);
 assert.equal(summary.originalBytes,2048);
 assert.equal(summary.payloadBytesSaved,2029);
 assert.equal(summary.productionSceneEligible,false);
 assert.equal(summary.transportSavingsVerified,false);
});
test("unchanged bytes require zero payload, but still check two trusted hashes",async()=>{
 const a=randomBytes(129);
 const p=await roundtrip(a,a);
 assert.equal(p.mode,"xor-runs");
 assert.equal(p.payload.length,0);
 await assert.rejects(decodeAgnosticXorDelta({before:a,packet:p,
   trustedBaseSha256:sha(a),trustedTargetSha256:sha(new Uint8Array(129))
 }),/trusted/);
});
test("incompressible arbitrary byte modifications fall back to full packet",async()=>{
 const a=new Uint8Array(1024),b=new Uint8Array(1024).fill(255);
 const p=await roundtrip(a,b);
 assert.equal(p.mode,"full");
 assert.equal(p.payload.length,1024);
});
test("length changes fall back to full without shifting or corrupting bytes",async()=>{
 for(const [a,b] of [
  [bytes([1,2,3]),bytes([0,1,2,3])],
  [bytes([1,2,3]),bytes([1,3])],
  [bytes([1,2,3]),new Uint8Array(0)],
  [new Uint8Array(0),bytes([4])],
  [new Uint8Array(0),new Uint8Array(0)]
 ]){
  const p=await roundtrip(a,b);
  assert.equal(p.mode,"full");
 }
});
test("the same codec handles JSON, binary telemetry and canvas RGBA bytes",async()=>{
 const u8=x=>new TextEncoder().encode(JSON.stringify(x));
 const j1=u8({room:"fixture",turn:10,game:{score:2}});
 const j2=u8({room:"fixture",turn:11,game:{score:2}});
 await roundtrip(j1,j2);
 const telemetry1=new Uint8Array(256),telemetry2=new Uint8Array(telemetry1);
 telemetry2[0]=44;telemetry2[240]=120;
 assert.equal((await roundtrip(telemetry1,telemetry2)).mode,"xor-runs");
 const image1=new Uint8ClampedArray(320*180*4);
 const image2=new Uint8ClampedArray(image1);
 for(let i=0;i<12;i++)image2[(i*320+i)*4]=255;
 const p=await roundtrip(image1,image2);
 assert.equal(p.mode,"xor-runs");
});
test("Buffer, ArrayBuffer, typed array and offset DataView normalize bytewise",async()=>{
 const a=Buffer.from([10,20,30,40,50,60,70,80,90,100]);
 const b=Buffer.from(a);b[4]=51;
 const p=await encodeAgnosticXorDelta({before:a,after:new DataView(
  b.buffer,b.byteOffset,b.byteLength)});
 const result=await decodeAgnosticXorDelta({before:new Uint8Array(
  a.buffer,a.byteOffset,a.byteLength),packet:p,
  trustedBaseSha256:sha(a),trustedTargetSha256:sha(b)});
 assert.deepEqual(result,new Uint8Array(b));
 const words=new Uint16Array(Uint8Array.from([0,2,4,6]).buffer);
 const other=new Uint8Array(words.buffer);const changed=new Uint8Array(other);
 changed[1]^=3;
 await roundtrip(words,changed);
 const whole=other.buffer.slice(0);
 await roundtrip(whole,changed);
});
test("without independently pinned hashes the decoder refuses all output",async()=>{
 const a=new Uint8Array(128),b=new Uint8Array(a);b[42]=10;
 const packet=await encodeAgnosticXorDelta({before:a,after:b});
 for(const opts of [
  {},
  {trustedBaseSha256:packet.baseSha256},
  {trustedTargetSha256:packet.targetSha256},
  {trustedBaseSha256:sha(b),trustedTargetSha256:sha(b)},
  {trustedBaseSha256:sha(a),trustedTargetSha256:sha(a)}
 ])await assert.rejects(decodeAgnosticXorDelta({
  before:a,packet,...opts}),/trusted/);
});
test("mutated baseline and tampered XOR payload both fail trusted reconstruction",async()=>{
 const base=new Uint8Array(160),target=new Uint8Array(base);
 target[77]=33;
 const packet=await encodeAgnosticXorDelta({before:base,after:target});
 const altered=new Uint8Array(base);altered[0]=1;
 await assert.rejects(decodeAgnosticXorDelta({before:altered,packet,
  trustedBaseSha256:sha(base),trustedTargetSha256:sha(target)
 }),/baseline/);
 const payload=new Uint8Array(packet.payload);
 payload[8]^=1;
 await assert.rejects(decodeAgnosticXorDelta({before:base,
  packet:{...packet,payload},trustedBaseSha256:sha(base),
  trustedTargetSha256:sha(target)}),/target SHA-256/);
});
test("malformed, zero, out-of-bounds, truncated and overlapping XOR runs reject",async()=>{
 const a=new Uint8Array(200),b=new Uint8Array(a);
 b[24]=42;b[27]=43;
 const p=await encodeAgnosticXorDelta({before:a,after:b});
 assert.equal(p.mode,"xor-runs");
 const fix=async payload=>assert.rejects(decodeAgnosticXorDelta({
  before:a,packet:{...p,payload},
  trustedBaseSha256:sha(a),trustedTargetSha256:sha(b)
 }),/run|delta size|SHA-256|packet/);
 const mod=(n,value)=>{const x=new Uint8Array(p.payload);x[n]=value;return x;};
 await fix(p.payload.subarray(0,5)); // short header
 await fix(mod(4,0)); // zero length
 await fix(mod(0,255)); // changed offset
 await fix(mod(8,0)); // zero xor
 // Tamper a packet shape as well.
 await assert.rejects(decodeAgnosticXorDelta({before:a,
  packet:{...p,unknown:"private"},trustedBaseSha256:sha(a),
  trustedTargetSha256:sha(b)}),/packet/);
});
test("decoder rejects noncanonical adjacent patches and zero XOR spans",async()=>{
 const base=new Uint8Array(200),target=new Uint8Array(base);
 target[4]=1;target[6]=2;
 const p=await encodeAgnosticXorDelta({before:base,after:target});
 assert.equal(p.mode,"xor-runs");
 const tampered=new Uint8Array(p.payload);
 const dv=new DataView(tampered.buffer);
 dv.setUint32(9,5,true); // second offset (first payload: 8+1)
 await assert.rejects(decodeAgnosticXorDelta({before:base,
  packet:{...p,payload:tampered},
  trustedBaseSha256:sha(base),trustedTargetSha256:sha(target)
 }),/Overlapping/);
});
test("excess memory, shared buffers, invalid packet types and keyframe tamper fail",async()=>{
 await assert.rejects(encodeAgnosticXorDelta({before:new Uint8Array(0),
  after:new Uint8Array(4*1024*1024+1)}),/size limit/);
 await assert.rejects(encodeAgnosticXorDelta({before:[1,2],
  after:new Uint8Array([1,2])}),/non-shared/);
 if(typeof SharedArrayBuffer!=="undefined")
  await assert.rejects(encodeAgnosticXorDelta({before:
   new SharedArrayBuffer(2),after:new Uint8Array(2)}),/non-shared/);
 const a=bytes([1,2,3]),b=bytes([4,5,6,7]);
 const p=await encodeAgnosticXorDelta({before:a,after:b});
 assert.equal(p.mode,"full");
 const fake=new Uint8Array(p.payload);fake[0]^=1;
 await assert.rejects(decodeAgnosticXorDelta({before:a,
  packet:{...p,payload:fake},trustedBaseSha256:sha(a),
  trustedTargetSha256:sha(b)}),/target SHA-256/);
 await assert.rejects(decodeAgnosticXorDelta({before:a,
  packet:{...p,mode:"xor-runs"},trustedBaseSha256:sha(a),
  trustedTargetSha256:sha(b)}),/Invalid XOR delta size/);
});
test("deterministic randomized stress: every byte reconstructed over 250 cases",async()=>{
 let seed=0xC0FFEE;
 const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
  return seed>>>0;};
 for(let t=0;t<250;t++){
  const n=next()%1050,base=Uint8Array.from({length:n},()=>next()&255);
  const newLen=(t%13===0)?(next()%1050):n;
  const target=new Uint8Array(newLen);
  target.set(base.subarray(0,Math.min(n,newLen)));
  const edits=next()%(newLen+1);
  for(let j=0;j<edits;j++)target[next()%Math.max(1,newLen)]^=1+(next()%255);
  const p=await roundtrip(base,target);
  assert.ok(p.payload.length<=target.length);
 }
});
