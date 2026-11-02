import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {deflateSync} from "node:zlib";
import {preparePrivateEpoch} from "./private_epoch_capture_contract_v1.mjs";
import {sealPrivateEpoch,verifyPrivateEpochSeal,PrivateEpochSequence}
 from "./owner_epoch_seal_v1.mjs";
const run="12345678-1234-4123-8123-123456789abc";
const alternate="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sha=s=>createHash("sha256").update(s).digest("hex");
function crc(b){let a=-1;for(const n of b){a^=n;for(let j=0;j<8;j++)a=a>>>1^(0xedb88320&-(a&1));}return(a^(-1))>>>0;}
function chunk(t,b){
 const d=Buffer.from(b),h=Buffer.alloc(8),tail=Buffer.alloc(4);
 h.writeUInt32BE(d.length);h.write(t,4);tail.writeUInt32BE(crc(Buffer.concat([h.subarray(4),d])));
 return Buffer.concat([h,d,tail]);
}
function png(seed){
 const width=320,height=180,row=1+width*4,bytes=Buffer.alloc(height*row);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const index=y*row+1+x*4;
  bytes[index]=(x+y+seed)%256;
  bytes[index+1]=(x*3+seed)%256;
  bytes[index+2]=(y*9+seed)%256;
  bytes[index+3]=255;
 }
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
   chunk("IHDR",Buffer.from([0,0,1,64,0,0,0,180,8,6,0,0,0])),
   chunk("IDAT",deflateSync(bytes)),chunk("IEND",[])]);
}
function scene(){
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:"/images/fixture.png",
   src:[0,0,32,32],dst:[0,0,32,32],matrix:[1,0,0,1,0,0],
   alpha:1,flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{inspected:1,captured:1,skipped:{},
   approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
   truncated:false,complete:true}};
}
const before={runId:run,relayCommitHash:sha("TEST-ONLY-RELAY"),
 gameStateHash:sha("TEST-ONLY-GAME")};
async function evidence(sequence=21){
 const pixels={sam:png(3),jevbot:png(5)};
 return preparePrivateEpoch({
  runId:run,sequence,
  readRelayCheckpoint:async()=>structuredClone(before),
  captureSeat:async(seat,ctx)=>({
   seat,postrender:true,frameTick:sequence+1,
   relayCommitHash:ctx.relayCommitHash,png:pixels[seat],scene:scene()
  })
 });
}
test("Ed25519 seals and verifies exact PNG+scene diagnostic evidence",async()=>{
 const e=await evidence(),{publicKey,privateKey}=generateKeyPairSync("ed25519");
 const payload=sealPrivateEpoch(e,privateKey,publicKey);
 assert.equal(verifyPrivateEpochSeal(payload,e,publicKey),true);
 assert.equal(payload.payload.frameId,run+":21");
 assert.equal(payload.payload.productionSceneEligible,false);
 assert.equal(payload.payload.sceneEpochAttested,false);
 assert.equal(payload.payload.issuerAuthenticated,false);
 assert.equal(Object.hasOwn(payload,"privateKey"),false);
});
test("forged signer, extra metadata and wrong signing key rejected",async()=>{
 const e=await evidence(),key=generateKeyPairSync("ed25519");
 const other=generateKeyPairSync("ed25519");
 const seal=sealPrivateEpoch(e,key.privateKey,key.publicKey);
 assert.equal(verifyPrivateEpochSeal(seal,e,other.publicKey),false);
 assert.throws(()=>sealPrivateEpoch(e,key.privateKey,other.publicKey),/Issuer key mismatch/);
 const changed=structuredClone(seal);
 changed.extra="private";
 assert.equal(verifyPrivateEpochSeal(changed,e,key.publicKey),false);
});
test("altering image bytes or scene geometry invalidates even a genuine signature",async()=>{
 const e=await evidence(),key=generateKeyPairSync("ed25519");
 const seal=sealPrivateEpoch(e,key.privateKey,key.publicKey);
 const original=e.frames.sam;
 e.frames.sam=Buffer.from(original);e.frames.sam[160]^=1;
 assert.equal(verifyPrivateEpochSeal(seal,e,key.publicKey),false);
 e.frames.sam=original;
 e.scenes.jevbot.commands[0].matrix[4]=9;
 assert.equal(verifyPrivateEpochSeal(seal,e,key.publicKey),false);
});
test("altered sequence, checkpoint, or sceneComplete cannot be upgraded",async()=>{
 const e=await evidence(),key=generateKeyPairSync("ed25519");
 const seal=sealPrivateEpoch(e,key.privateKey,key.publicKey);
 for(const field of ["sequence","relayCommitHash","sceneComplete","productionSceneEligible"]){
  const changed=structuredClone(seal);
  changed.payload[field]=field==="sequence"?22:
    field==="relayCommitHash"?sha("DIFFERENT"):
    field==="sceneComplete"?false:true;
  assert.equal(verifyPrivateEpochSeal(changed,e,key.publicKey),false);
 }
});
test("signature is canonical and self-contained without private keys",async()=>{
 const e=await evidence(),key=generateKeyPairSync("ed25519");
 const seal=sealPrivateEpoch(e,key.privateKey,key.publicKey);
 const wrong=structuredClone(seal);wrong.signature=seal.signature.slice(0,-1)+"!";
 assert.equal(verifyPrivateEpochSeal(wrong,e,key.publicKey),false);
 const bad=structuredClone(seal);bad.signature="A".repeat(86);
 assert.equal(verifyPrivateEpochSeal(bad,e,key.publicKey),false);
});
test("same-run monotonic guard blocks replay, regression and cross-run",async()=>{
 const key=generateKeyPairSync("ed25519");
 const c=new PrivateEpochSequence();
 const e1=await evidence(21),s1=sealPrivateEpoch(e1,key.privateKey,key.publicKey);
 assert.equal(c.accept(s1,e1,key.publicKey),true);
 assert.equal(c.accept(s1,e1,key.publicKey),false);
 const e2=await evidence(22),s2=sealPrivateEpoch(e2,key.privateKey,key.publicKey);
 assert.equal(c.accept(s2,e2,key.publicKey),true);
 assert.equal(c.accept(s1,e1,key.publicKey),false);
 const cross=structuredClone(e2);
 cross.receipt.runId=alternate;
 assert.equal(c.accept(s2,cross,key.publicKey),false);
 assert.deepEqual(c.status(),{runId:run,lastSequence:22});
 c.reset();
 assert.equal(c.accept(s1,e1,key.publicKey),true);
});
test("unverified scene data cannot be signed even by valid private key",async()=>{
 const e=await evidence(),key=generateKeyPairSync("ed25519");
 e.receipt.productionSceneEligible=true;
 assert.throws(()=>sealPrivateEpoch(e,key.privateKey,key.publicKey),/Private capture evidence invalid/);
});
