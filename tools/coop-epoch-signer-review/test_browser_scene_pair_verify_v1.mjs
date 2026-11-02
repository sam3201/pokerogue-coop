import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,createHash} from "node:crypto";
import {deflateSync} from "node:zlib";
import {buildRegistry} from "./texture_registry_v1.mjs";
import {bindScene,bindPairedScenes} from "./scene_asset_binding_v1.mjs";
import {signScenePair} from "./scene_pair_signature_v1.mjs";
import {verifyBrowserScenePair,verifyThenFetchScenePair}
  from "./browser_scene_pair_verify_v1.mjs";
const origin="https://fixture.example.test";
const runId="12345678-1234-4123-8123-123456789abc";
const sha=b=>createHash("sha256").update(b).digest("hex");
function crc(b){
 let x=-1;for(const v of b){x^=v;for(let k=0;k<8;k++)x=(x>>>1)^(0xedb88320&-(x&1));}
 return (x^(-1))>>>0;
}
function chunk(type,data){
 const b=Buffer.from(data),h=Buffer.alloc(8),t=Buffer.alloc(4);
 h.writeUInt32BE(b.length);h.write(type,4);
 t.writeUInt32BE(crc(Buffer.concat([h.subarray(4),b])));
 return Buffer.concat([h,b,t]);
}
function png(){
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR",Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
  chunk("IDAT",deflateSync(Buffer.from([0,20,30,40,255]))),
  chunk("IEND",[])]);
}
function fixture(){
 const bytes=png(),digest=sha(bytes);
 const {manifest}=buildRegistry([{bytes,
  source:{kind:"static-file",path:"assets/images/test-clean-room.png"},
  approval:{licenseId:"CC0-1.0",redistributionGranted:true,
   reviewId:"review:generated-fixture",expectedSha256:digest}}]);
 const texture=manifest.textures[0].href;
 const scene={schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture,src:[0,0,1,1],dst:[0,0,1,1],
    matrix:[1,0,0,1,0,0],alpha:1,flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{captured:1,complete:true,truncated:false,skipped:{},
    approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0}}};
 const sam=bindScene({scene,manifest,runId,seat:"sam",sequence:21});
 const jevbot=bindScene({scene,manifest,runId,seat:"jevbot",sequence:21});
 const pair=bindPairedScenes(sam,jevbot,manifest);
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const pinnedSpki=publicKey.export({format:"der",type:"spki"});
 const signed=signScenePair(pair,sam,jevbot,manifest,privateKey,publicKey);
 return {bytes,manifest,sam,jevbot,pair,pinnedSpki,signed};
}
function mockResponse(f){
 const r=new Response(f.bytes,{headers:{"content-type":"image/png",
   "content-length":String(f.bytes.length)}});
 Object.defineProperty(r,"url",{value:origin+f.manifest.textures[0].href});
 return r;
}
test("portable WebCrypto verifies a server-produced Ed25519 two-seat pair",async()=>{
 const f=fixture();
 assert.equal(await verifyBrowserScenePair(f),true);
});
test("wrong signing key, crossed seats, forged run or altered pixels rejected",async()=>{
 const f=fixture();
 const other=generateKeyPairSync("ed25519").publicKey
  .export({format:"der",type:"spki"});
 assert.equal(await verifyBrowserScenePair({...f,pinnedSpki:other}),false);
 const reversed={...f,sam:f.jevbot,jevbot:f.sam};
 assert.equal(await verifyBrowserScenePair(reversed),false);
 const altered=structuredClone(f.sam);
 altered.scene.commands[0].dst[0]+=1;
 assert.equal(await verifyBrowserScenePair({...f,sam:altered}),false);
 const forged=structuredClone(f.signed);
 forged.signature="A"+forged.signature.slice(1);
 assert.equal(await verifyBrowserScenePair({...f,signed:forged}),false);
});
test("extra private scene metadata or mismatched frame is rejected",async()=>{
 const f=fixture(),injected=structuredClone(f.sam);
 injected.scene.secret="PRIVATE_ROOM_123";
 assert.equal(await verifyBrowserScenePair({...f,sam:injected}),false);
 const other=structuredClone(f.jevbot);
 other.sequence=22;
 assert.equal(await verifyBrowserScenePair({...f,jevbot:other}),false);
});
test("no asset request occurs before Ed25519 and frame validation",async()=>{
 const f=fixture();
 let calls=0;
 const wrong=structuredClone(f.signed);wrong.signature="A".repeat(86);
 await assert.rejects(verifyThenFetchScenePair({...f,signed:wrong,origin,
  fetcher:async()=>{calls++;throw Error("must not fetch");}
 }),/Untrusted paired scene/);
 assert.equal(calls,0);
});
test("signed pair then approved PNG fetch returns only private scene bytes",async()=>{
 const f=fixture();
 let calls=0;
 const out=await verifyThenFetchScenePair({...f,origin,
  fetcher:async()=>{calls++;return mockResponse(f);}
 });
 assert.equal(calls,1);
 assert.equal(out.frameId,runId+":21");
 assert.equal(out.scope,"private-staging-only");
 assert.equal(out.seats.sam.commands.length,1);
 assert.deepEqual([...([ ...out.textures.values() ][0])],[...f.bytes]);
 assert.equal(JSON.stringify(out.seats).includes("PRIVATE_ROOM"),false);
});
test("unsigned/private-key-injection properties cannot be accepted",async()=>{
 const f=fixture(),bad=structuredClone(f.signed);
 bad.privateKey="secret";
 assert.equal(await verifyBrowserScenePair({...f,signed:bad}),false);
 const badManifest=structuredClone(f.manifest);
 badManifest.privacy="metadata";
 assert.equal(await verifyBrowserScenePair({...f,manifest:badManifest}),false);
});
