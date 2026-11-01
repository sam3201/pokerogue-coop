import test from "node:test";
import assert from "node:assert/strict";
import {deflateSync} from "node:zlib";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {sha256,buildRegistry,verifyTexture} from "./texture_registry_v1.mjs";
import {stagePrivateRegistry} from "./texture_staging_v1.mjs";
import {bindScene,validateBoundScene,bindPairedScenes}
  from "./scene_asset_binding_v1.mjs";
const here=dirname(fileURLToPath(import.meta.url));
function crc(b){let x=-1;for(const a of b){x^=a;for(let j=0;j<8;j++)x=(x>>>1)^(0xedb88320&-(x&1));}return (x^(-1))>>>0;}
function chunk(type,data){
 const d=Buffer.from(data),h=Buffer.alloc(8),t=Buffer.alloc(4);
 h.writeUInt32BE(d.length);h.write(type,4);t.writeUInt32BE(crc(Buffer.concat([h.subarray(4),d])));
 return Buffer.concat([h,d,t]);
}
function fixture(){
 const h=Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR",h),chunk("IDAT",deflateSync(Buffer.from([0,4,70,110,255]))),
  chunk("IEND",[])]);
}
function bundle(){
 const bytes=fixture();
 return buildRegistry([{bytes,source:{kind:"static-file",
   path:"assets/images/generated-example.png"},
   approval:{licenseId:"CC0-1.0",redistributionGranted:true,
    reviewId:"review:generated-test-fixture",expectedSha256:sha256(bytes)}}]);
}
function stagePath(){return mkdtempSync(join(here,"texture-staging","unittest-"));}
test("generated fixture stages privately and idempotently with matching bytes",()=>{
 const p=stagePath();
 try{
  const b=bundle(),a=stagePrivateRegistry(b,p),again=stagePrivateRegistry(b,p);
  assert.equal(a.scope,"private-only");
  assert.equal(a.count,1);
  assert.equal(again.manifestDigest,a.manifestDigest);
  assert.deepEqual(JSON.parse(readFileSync(a.manifestFile,"utf8")),b.manifest);
  assert.equal(verifyTexture(b.manifest,b.manifest.textures[0].href,
    readFileSync(a.files[0])),true);
 }finally{rmSync(p,{recursive:true,force:true});}
});
test("out-of-lab staging is impossible",()=>{
 const b=bundle();
 assert.throws(()=>stagePrivateRegistry(b,"/tmp/scene-textures"),/private texture lab/);
 assert.throws(()=>stagePrivateRegistry(b,resolve(here,"../public")),
   /private texture lab/);
});
test("corrupted staged bytes are never silently replaced",()=>{
 const p=stagePath();
 try{
  const b=bundle(),a=stagePrivateRegistry(b,p);
  writeFileSync(a.files[0],Buffer.from("corrupted"),{mode:0o600});
  assert.throws(()=>stagePrivateRegistry(b,p),/conflicts/);
 }finally{rmSync(p,{recursive:true,force:true});}
});
test("preflight refuses fabricated/corrupted manifests before staging",()=>{
 const p=stagePath();
 try{
  const b=bundle();b.files.set(b.manifest.textures[0].sha256,
    Buffer.from("fake"));
  assert.throws(()=>stagePrivateRegistry(b,p),/Unverified texture/);
 }finally{rmSync(p,{recursive:true,force:true});}
});

test("full local path: PNG bytes -> manifest -> disk -> two-seat frame pair",()=>{
 const p=stagePath();
 try{
  const b=bundle(),out=stagePrivateRegistry(b,p);
  const texture=b.manifest.textures[0].href;
  const scene={
   schema:"sam.coop.phaser-sprites.probe.v1",
   visualScope:"partial-original-sprites",labOnly:false,
   camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
   commands:[{op:"sprite",texture,src:[0,0,1,1],dst:[0,0,1,1],
     matrix:[1,0,0,1,0,0],alpha:1,
     flipX:false,flipY:false,scroll:[1,1]}],
   coverage:{inspected:1,captured:1,complete:true,truncated:false,
     skipped:{},approximated:{fieldShader:0,geometryMask:0,
       spriteBase:0,spriteShadow:0}}
  };
  const runId="12345678-1234-4123-8123-123456789abc",sequence=77;
  const a=bindScene({scene,manifest:b.manifest,runId,seat:"sam",sequence});
  const j=bindScene({scene,manifest:b.manifest,runId,seat:"jevbot",sequence});
  assert.equal(validateBoundScene(a,b.manifest),true);
  assert.equal(validateBoundScene(j,b.manifest),true);
  const pair=bindPairedScenes(a,j,b.manifest);
  assert.equal(pair.frameId,runId+":77");
  assert.equal(pair.manifestDigest,out.manifestDigest);
  assert.equal(verifyTexture(b.manifest,texture,readFileSync(out.files[0])),true);
  assert.equal(JSON.stringify(pair).includes("bytes"),false);
 }finally{rmSync(p,{recursive:true,force:true});}
});
