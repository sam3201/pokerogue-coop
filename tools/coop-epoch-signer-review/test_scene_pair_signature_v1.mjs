import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {sha256,SCHEMA as TEXTURE_SCHEMA} from "./texture_registry_v1.mjs";
import {bindScene,bindPairedScenes} from "./scene_asset_binding_v1.mjs";
import {signScenePair,verifySignedScenePair} from "./scene_pair_signature_v1.mjs";
const id="12345678-1234-4123-8123-123456789abc";
const digest="c".repeat(64);
const href="/images/approved-sha256/"+digest+".png";
function fixture(){
 const base={schema:TEXTURE_SCHEMA,scope:"private-staging-only",
  textures:[{id:"sha256:"+digest,href,sha256:digest,
   bytes:73,width:1,height:1,licenseId:"CC0-1.0",reviewId:"review:fixture-private"}]};
 const m={...base,digest:sha256(Buffer.from(JSON.stringify(base)))};
 const s={schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:href,src:[0,0,1,1],dst:[0,0,1,1],
   matrix:[1,0,0,1,0,0],alpha:1,flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{captured:1,complete:true,truncated:false,skipped:{},
   approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0}}};
 const sam=bindScene({scene:s,manifest:m,runId:id,seat:"sam",sequence:77});
 const jevbot=bindScene({scene:s,manifest:m,runId:id,seat:"jevbot",sequence:77});
 return {manifest:m,sam,jevbot,pair:bindPairedScenes(sam,jevbot,m)};
}
test("trusted Ed25519 signer authenticates one exact paired frame",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const {pair,sam,jevbot,manifest}=fixture();
 const signed=signScenePair(pair,sam,jevbot,manifest,privateKey,publicKey);
 assert.equal(verifySignedScenePair(signed,sam,jevbot,manifest,publicKey),true);
 assert.equal(signed.scope,"private-staging-only");
 assert.equal(signed.pair.frameId,id+":77");
 assert.equal(JSON.stringify(signed).includes("PRIVATE_KEY"),false);
});
test("wrong public key, altered signature and forged signer identity fail",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const other=generateKeyPairSync("ed25519").publicKey;
 const f=fixture();
 const signed=signScenePair(f.pair,f.sam,f.jevbot,f.manifest,privateKey,publicKey);
 assert.equal(verifySignedScenePair(signed,f.sam,f.jevbot,f.manifest,other),false);
 const wrong=structuredClone(signed);
 wrong.signature=(signed.signature[0]==="A"?"B":"A")+signed.signature.slice(1);
 assert.equal(verifySignedScenePair(wrong,f.sam,f.jevbot,f.manifest,publicKey),false);
 const noncanonical=structuredClone(signed);
 const alternate={"A":"B","Q":"R","g":"h","w":"x"};
 noncanonical.signature=signed.signature.slice(0,-1)+
    alternate[signed.signature.at(-1)];
 assert.equal(verifySignedScenePair(noncanonical,f.sam,f.jevbot,f.manifest,publicKey),false);
 const extra=structuredClone(signed);extra.privateInfo="DO_NOT_SEND";
 assert.equal(verifySignedScenePair(extra,f.sam,f.jevbot,f.manifest,publicKey),false);
});
test("a different run, seat sequence or asset registry invalidates signature",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const f=fixture();
 const signed=signScenePair(f.pair,f.sam,f.jevbot,f.manifest,privateKey,publicKey);
 const swapped=structuredClone(f.jevbot);swapped.sequence=78;
 assert.equal(verifySignedScenePair(signed,f.sam,swapped,f.manifest,publicKey),false);
 const m=structuredClone(f.manifest);m.textures[0].licenseId="LicenseRef-NO-REUSE";
 assert.equal(verifySignedScenePair(signed,f.sam,f.jevbot,m,publicKey),false);
 assert.throws(()=>signScenePair({...f.pair,frameId:"fake"},f.sam,
   f.jevbot,f.manifest,privateKey,publicKey),/invalid/);
});
