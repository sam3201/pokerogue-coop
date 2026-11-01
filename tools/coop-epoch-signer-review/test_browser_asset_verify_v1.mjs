import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto,createHash} from "node:crypto";
import {deflateSync} from "node:zlib";
import {buildRegistry} from "./texture_registry_v1.mjs";
import {validateApprovedManifest,fetchApprovedTexture,fetchSceneTextures}
  from "./browser_asset_verify_v1.mjs";
const subtle=webcrypto.subtle,origin="https://fixture.example.test";
function crc(b){
 let v=-1;
 for(const k of b){v^=k;for(let i=0;i<8;i++)v=(v>>>1)^(0xedb88320&-(v&1));}
 return (v^(-1))>>>0;
}
function chunk(name,data){
 const d=Buffer.from(data),head=Buffer.alloc(8),tail=Buffer.alloc(4);
 head.writeUInt32BE(d.length,0);head.write(name,4,"ascii");
 tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4),d])),0);
 return Buffer.concat([head,d,tail]);
}
function png(w=1,h=1){
 const meta=Buffer.alloc(13);
 meta.writeUInt32BE(w,0);meta.writeUInt32BE(h,4);meta[8]=8;meta[9]=6;
 const pixels=Buffer.alloc(h*(1+w*4));
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
   chunk("IHDR",meta),chunk("IDAT",deflateSync(pixels)),chunk("IEND",[])]);
}
function bundle(width=1){
 const data=png(width),digest=createHash("sha256").update(data).digest("hex");
 const b=buildRegistry([{bytes:data,
  source:{kind:"static-file",path:"assets/images/generated-fixture.png"},
  approval:{licenseId:"CC0-1.0",redistributionGranted:true,
   reviewId:"review:generated-fixture",expectedSha256:digest}}]);
 return {bytes:data,manifest:b.manifest,entry:b.manifest.textures[0]};
}
function response(bytes,entry,override={}){
 const r=new Response(bytes,{headers:{"content-type":"image/png",
   "content-length":String(bytes.length)}});
 Object.defineProperty(r,"url",{value:override.url??origin+entry.href});
 if(override.redirected)Object.defineProperty(r,"redirected",{value:true});
 if(override.contentType)r.headers.set("content-type",override.contentType);
 return r;
}
test("browser WebCrypto validates approved manifest and exact PNG bytes",async()=>{
 const f=bundle();
 assert.equal(await validateApprovedManifest(f.manifest,subtle),true);
 let options;
 const verified=await fetchApprovedTexture(f.entry,origin,{
  subtle,fetcher:async(_url,init)=>{
   options=init;return response(f.bytes,f.entry);
  }
 });
 assert.deepEqual([...verified],[...f.bytes]);
 assert.equal(options.credentials,"omit");
 assert.equal(options.redirect,"error");
 assert.equal(options.mode,"same-origin");
 assert.equal(options.cache,"no-store");
 assert.equal(options.referrerPolicy,"no-referrer");
});
test("cross-origin and redirected responses fail without revealing bytes",async()=>{
 const f=bundle();
 for(const override of [
  {url:"https://attacker.example.test"+f.entry.href},
  {url:origin+"/other.png"},{redirected:true},
  {contentType:"text/html"}
 ]){
  await assert.rejects(fetchApprovedTexture(f.entry,origin,{
   subtle,fetcher:async()=>response(f.bytes,f.entry,override)
  }),/Untrusted texture response/);
 }
});
test("corrupted bytes, truncated bytes and bad PNG signature fail",async()=>{
 const f=bundle();
 for(const bytes of [
  Buffer.from(f.bytes.map((v,i)=>i===41?v^1:v)),
  f.bytes.subarray(0,-1),
  Buffer.from(f.bytes.map((v,i)=>i===0?0:v))
 ]){
  await assert.rejects(fetchApprovedTexture(f.entry,origin,{
    subtle,fetcher:async()=>response(bytes,f.entry)
  }),/Untrusted texture response|byte budget|Invalid approved PNG header|mismatch/);
 }
});
test("manifest tampering is rejected before any network call",async()=>{
 const f=bundle();
 const bad=structuredClone(f.manifest);
 bad.textures[0].reviewId="review:forged";
 assert.equal(await validateApprovedManifest(bad,subtle),false);
 let calls=0;
 await assert.rejects(fetchSceneTextures(bad,[f.entry.href],origin,{
  subtle,fetcher:async()=>{calls++;throw Error("must not fetch");}
 }),/Invalid manifest/);
 assert.equal(calls,0);
});
test("approved texture list cannot name other assets or remote paths",async()=>{
 const f=bundle();
 for(const hrefs of [[f.entry.href,"/private/accounts.png"],
   ["https://another.example.test/image.png"],[f.entry.href,f.entry.href]]){
  await assert.rejects(fetchSceneTextures(f.manifest,hrefs,origin,{subtle}),
   /Unapproved texture reference|Invalid scene texture set/);
 }
});
test("verified scene set returns exact bytes and only approved URLs",async()=>{
 const f=bundle(2);
 const m=await fetchSceneTextures(f.manifest,[f.entry.href],origin,{
  subtle,fetcher:async()=>response(f.bytes,f.entry)
 });
 assert.equal(m.size,1);
 assert.deepEqual([...m.get(f.entry.href)],[...f.bytes]);
});
test("untrusted origin, unsafe entry and oversized stream are rejected",async()=>{
 const f=bundle(),bad={...f.entry,href:"/data/private.png"};
 await assert.rejects(fetchApprovedTexture(bad,origin,{
  subtle,fetcher:async()=>response(f.bytes,f.entry)
 }),/Unapproved texture entry/);
 await assert.rejects(fetchApprovedTexture(f.entry,"http://localhost/",{
  subtle,fetcher:async()=>response(f.bytes,f.entry)
 }),/Invalid HTTPS origin/);
 // Advertises correct length but yields more than expected.
 const stream=new ReadableStream({start(ctrl){
  ctrl.enqueue(new Uint8Array(f.bytes));
  ctrl.enqueue(new Uint8Array([1]));ctrl.close();
 }});
 const tooMuch=new Response(stream,{headers:{"content-type":"image/png",
  "content-length":String(f.bytes.length)}});
 Object.defineProperty(tooMuch,"url",{value:origin+f.entry.href});
 await assert.rejects(fetchApprovedTexture(f.entry,origin,{
  subtle,fetcher:async()=>tooMuch
 }),/Texture byte budget/);
});
