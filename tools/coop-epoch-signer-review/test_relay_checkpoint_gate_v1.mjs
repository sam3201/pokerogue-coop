import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {deflateSync} from "node:zlib";
import {verifySignedRelayCheckpoint,prepareCheckpointAuthenticatedEpoch,
 verifyCheckpointAuthenticatedEpoch,keyFingerprint,CHECKPOINT_SCHEMA}
 from "./relay_checkpoint_gate_v1.mjs";
const RUN="12345678-1234-4123-8123-123456789abc";
const sha=s=>createHash("sha256").update(s).digest("hex");
const keys=generateKeyPairSync("ed25519");
function chunk(t,data){
 const d=Buffer.from(data),h=Buffer.alloc(8),tail=Buffer.alloc(4);
 h.writeUInt32BE(d.length);h.write(t,4);
 let c=-1;for(const b of Buffer.concat([h.subarray(4),d])){
   c^=b;for(let j=0;j<8;j++)c=c>>>1^(0xedb88320&-(c&1));
 }
 tail.writeUInt32BE((c^(-1))>>>0);
 return Buffer.concat([h,d,tail]);
}
function png(seed){
 const raw=Buffer.alloc(180*(1+320*4));
 for(let y=0;y<180;y++)for(let x=0;x<320;x++){
  const i=y*(1+320*4)+1+x*4;
  raw[i]=(x+seed+y)&255;
  raw[i+1]=(x*3+y)&255;
  raw[i+2]=(x+y*5+seed)&255;
  raw[i+3]=255;
 }
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR",Buffer.from([0,0,1,64,0,0,0,180,8,6,0,0,0])),
  chunk("IDAT",deflateSync(raw)),chunk("IEND",[])]);
}
function scene(){
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:"/images/test-generated.png",
    src:[0,0,8,8],dst:[0,0,8,8],matrix:[1,0,0,1,1,1],
    alpha:1,flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{inspected:1,captured:1,truncated:false,complete:true,
   approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
   skipped:{}}};
}
function signed({seq=73,runId=RUN,hash=sha("relay 73"),
  state=sha("state 73"),created=Date.now(),key=keys}={}){
 const payload={schema:CHECKPOINT_SCHEMA,runId,sequence:seq,
  relayCommitHash:hash,gameStateHash:state,
  issuedAt:new Date(created-200).toISOString(),
  expiresAt:new Date(created+10000).toISOString()};
 return {schema:CHECKPOINT_SCHEMA,issuerKeyId:keyFingerprint(key.publicKey),
  payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),
    key.privateKey).toString("base64url")};
}
function capture(tokenSeq=73){
 const image={sam:png(12),jevbot:png(15)};
 return async(seat,ctx)=>({
  seat,postrender:true,frameTick:tokenSeq+1,
  relayCommitHash:ctx.relayCommitHash,png:image[seat],scene:scene()
 });
}
test("pinned relay proof and independent postrender diagnostic combine, still not prod",async()=>{
 const token=signed();
 const result=await prepareCheckpointAuthenticatedEpoch({
  runId:RUN,sequence:73,pinnedPublicKey:keys.publicKey,
  readSignedCheckpoint:async()=>token,captureSeat:capture()
 });
 assert.equal(result.relayCheckpointVerified,true);
 assert.equal(result.productionSceneEligible,false);
 assert.equal(result.receipt.sceneEpochAttested,false);
 assert.equal(result.receipt.issuerAuthenticated,false);
 assert.equal(verifyCheckpointAuthenticatedEpoch(result,keys.publicKey),true);
 assert.equal(result.frameSync.sequence,73);
});
test("untrusted signing key fails before invoking any captures",async()=>{
 const token=signed({key:generateKeyPairSync("ed25519")});
 let captures=0;
 await assert.rejects(prepareCheckpointAuthenticatedEpoch({
  runId:RUN,sequence:73,pinnedPublicKey:keys.publicKey,
  readSignedCheckpoint:async()=>token,
  captureSeat:async()=>{captures++;throw Error("never called");}
 }),/signature invalid/);
 assert.equal(captures,0);
});
test("cross-run, changed packet, expiration and sequence mismatch rejected",()=>{
 const token=signed();
 assert.equal(verifySignedRelayCheckpoint(token,keys.publicKey,{
   runId:RUN,sequence:73}),true);
 assert.equal(verifySignedRelayCheckpoint(token,keys.publicKey,{
   runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sequence:73}),false);
 assert.equal(verifySignedRelayCheckpoint(token,keys.publicKey,{
   runId:RUN,sequence:74}),false);
 assert.equal(verifySignedRelayCheckpoint(token,keys.publicKey,{
   runId:RUN,sequence:73,now:Date.now()+15000}),false);
 const modified=structuredClone(token);
 modified.payload.gameStateHash=sha("modified");
 assert.equal(verifySignedRelayCheckpoint(modified,keys.publicKey,{
   runId:RUN,sequence:73}),false);
});
test("relay logical state change during two-seat capture aborts",async()=>{
 let n=0;
 await assert.rejects(prepareCheckpointAuthenticatedEpoch({
  runId:RUN,sequence:73,pinnedPublicKey:keys.publicKey,
  readSignedCheckpoint:async()=>++n===1?signed():signed({hash:sha("NEXT_COMMIT")}),
  captureSeat:capture()
 }),/relay state advanced/);
 assert.equal(n,2);
});
test("signed receipt tampering or altered PNG invalidates diagnostic",async()=>{
 const token=signed();
 const result=await prepareCheckpointAuthenticatedEpoch({
  runId:RUN,sequence:73,pinnedPublicKey:keys.publicKey,
  readSignedCheckpoint:async()=>token,captureSeat:capture()
 });
 result.signedRelayCheckpoints.after.signature="A".repeat(86);
 assert.equal(verifyCheckpointAuthenticatedEpoch(result,keys.publicKey),false);
 result.signedRelayCheckpoints.after=token;
 result.frames.jevbot=Buffer.concat([result.frames.jevbot,Buffer.from([1])]);
 assert.equal(verifyCheckpointAuthenticatedEpoch(result,keys.publicKey),false);
});
test("checkpoint cannot use invalid shape or noncanonical signature",()=>{
 const token=signed();
 const extra=structuredClone(token);extra.privateRoom="NO";
 assert.equal(verifySignedRelayCheckpoint(extra,keys.publicKey),false);
 const bad=structuredClone(token);bad.signature="A".repeat(86);
 assert.equal(verifySignedRelayCheckpoint(bad,keys.publicKey),false);
});
test("publisher never receives a production-eligible capture by implication",async()=>{
 const result=await prepareCheckpointAuthenticatedEpoch({
  runId:RUN,sequence:73,pinnedPublicKey:keys.publicKey,
  readSignedCheckpoint:async()=>signed(),captureSeat:capture()
 });
 assert.equal(result.productionSceneEligible,false);
 assert.equal(Object.hasOwn(result.frameSync,"sceneEpochNonces"),false);
 assert.equal(Object.hasOwn(result.receipt,"signature"),false);
});
