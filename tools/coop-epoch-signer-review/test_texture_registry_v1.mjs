import test from "node:test";
import assert from "node:assert/strict";
import {deflateSync} from "node:zlib";
import {buildRegistry,inspectPng,verifyTexture,validateRegistry,sha256}
  from "./texture_registry_v1.mjs";
function crc32(b){
 let c=-1;
 for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^(0xedb88320&-(c&1));}
 return (c^(-1))>>>0;
}
function chunk(type,bytes){
 const data=Buffer.from(bytes),head=Buffer.alloc(8),tail=Buffer.alloc(4);
 head.writeUInt32BE(data.length,0);head.write(type,4,"ascii");
 tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);
 return Buffer.concat([head,data,tail]);
}
function png(width=1,height=1){
 const h=Buffer.alloc(13);h.writeUInt32BE(width,0);h.writeUInt32BE(height,4);
 h[8]=8;h[9]=6; // 8-bit RGBA
 const raw=Buffer.alloc(height*(1+4*width));
 for(let y=0;y<height;y++)raw[y*(1+4*width)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
   chunk("IHDR",h),chunk("IDAT",deflateSync(raw)),chunk("IEND",[])]);
}
function record(bytes,extra={}){
 return {bytes,source:{kind:"static-file",path:"assets/images/fixture.png"},
  approval:{licenseId:"CC0-1.0",redistributionGranted:true,
    reviewId:"review:manual-fixture",expectedSha256:sha256(bytes)},...extra};
}
test("strict PNG parser validates a tiny RGBA texture",()=>{
 const b=png(2,3),m=inspectPng(b);
 assert.equal(m.width,2);assert.equal(m.height,3);
 assert.equal(m.bytes,b.length);
 assert.equal(m.sha256,sha256(b));
});
test("registry carries content address only, no blob/data source URL",()=>{
 const b=png(),out=buildRegistry([record(b)]);
 assert.equal(validateRegistry(out.manifest),true);
 assert.deepEqual(out.manifest.textures.map(x=>x.href),
  ["/images/approved-sha256/"+sha256(b)+".png"]);
 assert.equal(verifyTexture(out.manifest,out.manifest.textures[0].href,b),true);
 assert.equal(JSON.stringify(out.manifest).includes("fixture.png"),false);
 assert.equal(out.files.get(sha256(b)).equals(b),true);
});
test("bytes or manifest tampering invalidates immutable registry",()=>{
 const b=png(),out=buildRegistry([record(b)]);
 const wrong=png(2,1),href=out.manifest.textures[0].href;
 assert.equal(verifyTexture(out.manifest,href,wrong),false);
 assert.equal(verifyTexture(out.manifest,href.replace(".png",".webp"),b),false);
 const bad=structuredClone(out.manifest);
 bad.textures[0].reviewId="review:wrong";
 assert.equal(validateRegistry(bad),false);
});
test("unapproved and fair-use-only assets are refused",()=>{
 const b=png();
 for(const licenseId of ["LicenseRef-NO-REUSE","LicenseRef-FAIR-USE","AGPL-3.0-only"]){
  assert.throws(()=>buildRegistry([record(b,{
   approval:{licenseId,redistributionGranted:true,reviewId:"review:fixture",
     expectedSha256:sha256(b)}})]),/provenance or license/);
 }
});
test("approval is tied to the exact digest",()=>{
 const b=png();
 assert.throws(()=>buildRegistry([record(b,{
  approval:{licenseId:"CC0-1.0",redistributionGranted:true,
    reviewId:"review:fixture",expectedSha256:"0".repeat(64)}})]),/provenance or license/);
});
test("dynamic canvas or session-local blob sources are rejected",()=>{
 const b=png();
 for(const path of ["blob:https://example.test/123","assets/images/../private.png",
 "assets/images/inject.png?code=secret"]){
  assert.throws(()=>buildRegistry([record(b,{source:{kind:"static-file",path}})]),
    /provenance or license/);
 }
 assert.throws(()=>buildRegistry([record(b,{
  source:{kind:"canvas",path:"assets/images/fixture.png"}})]),/provenance or license/);
});
test("malformed PNG data, CRC and trailing bytes rejected",()=>{
 const b=png();
 for(const mutate of [
  bytes=>{bytes[0]=0;return bytes;},
  bytes=>{bytes[20]^=1;return bytes;},
  bytes=>Buffer.concat([bytes,Buffer.from([2])]),
  bytes=>Buffer.concat([bytes,chunk("tEXt",Buffer.from("secret"))])
 ]){
  assert.throws(()=>inspectPng(mutate(Buffer.from(b))));
 }
});
test("PNG with huge or non-RGBA dimensions rejected before inflation",()=>{
 const b=png(),x=Buffer.from(b);
 x.writeUInt32BE(4096,16);x.writeUInt32BE(4096,20);
 x.writeUInt32BE(crc32(x.subarray(12,29)),29);
 assert.throws(()=>inspectPng(x),/geometry/);
});
test("duplicate assets and zero-asset catalogs refused",()=>{
 const b=png();
 assert.throws(()=>buildRegistry([]),/count/);
 assert.throws(()=>buildRegistry([record(b),record(b)]),/Duplicate/);
});
test("unexpected metadata chunks rejected even when CRC is valid",()=>{
 const b=png();
 const insert=chunk("tEXt",Buffer.from("secret=fake"));
 assert.throws(()=>inspectPng(Buffer.concat([
   b.subarray(0,b.length-12),insert,b.subarray(b.length-12)])),/metadata/);
});
