import test from "node:test";
import assert from "node:assert/strict";
import {sha256,SCHEMA as TEXTURE_SCHEMA} from "./texture_registry_v1.mjs";
import {bindScene,validateBoundScene,bindPairedScenes}
  from "./scene_asset_binding_v1.mjs";
const id="12345678-1234-4123-8123-123456789abc";
const digest="a".repeat(64),href="/images/approved-sha256/"+digest+".png";
function manifest(){
 const base={schema:TEXTURE_SCHEMA,scope:"private-staging-only",
  textures:[{id:"sha256:"+digest,href,sha256:digest,
   bytes:73,width:1,height:1,licenseId:"CC0-1.0",
   reviewId:"review:demo-approved"}]};
 return {...base,digest:sha256(Buffer.from(JSON.stringify(base)))};
}
function scene(extra={}){
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:href,
   src:[0,0,1,1],dst:[0,0,1,1],
   matrix:[1,0,0,1,0,0],alpha:1,
   flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{inspected:1,captured:1,truncated:false,complete:true,
   skipped:{},approximated:{fieldShader:0,geometryMask:0,
    spriteBase:0,spriteShadow:0}},...extra};
}
test("approved scene binds to exact run, seat and frame",()=>{
 const m=manifest();
 const p=bindScene({scene:scene(),manifest:m,runId:id,seat:"sam",sequence:7});
 assert.equal(p.frameId,id+":7");
 assert.equal(p.manifestDigest,m.digest);
 assert.equal(validateBoundScene(p,m),true);
});
test("private source object metadata cannot leak into serialized scene",()=>{
 const m=manifest(),s=scene({secret:"PRIVATE_ROOM_CODE",
  sessionToken:"USER_TOKEN"});
 s.commands[0].secret="HIDDEN_ACCOUNT";
 s.camera.internalSecret="SENSITIVE";
 const p=bindScene({scene:s,manifest:m,runId:id,seat:"jevbot",sequence:7});
 const json=JSON.stringify(p);
 for(const str of ["PRIVATE_ROOM_CODE","HIDDEN_ACCOUNT","SENSITIVE","USER_TOKEN"])
  assert.equal(json.includes(str),false);
 assert.equal(validateBoundScene(p,m),true);
});
test("zero or mismatched frame identity fails closed",()=>{
 const m=manifest();
 for(const o of [{seat:"host"},{sequence:0},{runId:"../../other"},
    {sequence:1.5}]){
  assert.throws(()=>bindScene({scene:scene(),manifest:m,
    runId:id,seat:"sam",sequence:1,...o}));
 }
});
test("unapproved texture, lab-only source and incomplete coverage refused",()=>{
 const m=manifest();
 for(const s of [
   scene({labOnly:true}),
   scene({coverage:{...scene().coverage,complete:false}}),
   scene({commands:[{...scene().commands[0],
      texture:"/images/__lab_memory__/1.png"}]})
 ]){
  assert.throws(()=>bindScene({scene:s,manifest:m,
    runId:id,seat:"sam",sequence:1}));
 }
});
test("tampered commands or manifest bind invalidates scene",()=>{
 const m=manifest();
 const p=bindScene({scene:scene(),manifest:m,
  runId:id,seat:"sam",sequence:1});
 const bad=structuredClone(p);
 bad.scene.commands[0].dst[0]=4;
 assert.equal(validateBoundScene(bad,m),false);
 const swapped=structuredClone(m);
 swapped.textures[0].reviewId="review:swapped";
 assert.equal(validateBoundScene(p,swapped),false);
});
test("two seats may pair only at the exact same verified frame",()=>{
 const m=manifest();
 const sam=bindScene({scene:scene(),manifest:m,
  runId:id,seat:"sam",sequence:9});
 const jevbot=bindScene({scene:scene(),manifest:m,
  runId:id,seat:"jevbot",sequence:9});
 const p=bindPairedScenes(sam,jevbot,m);
 assert.equal(p.frameId,id+":9");
 assert.equal(p.runId,id);
 assert.equal(p.samDigest,sam.digest);
 assert.equal(p.jevbotDigest,jevbot.digest);
 assert.equal(bindPairedScenes(jevbot,sam,m),null);
 const wrong=bindScene({scene:scene(),manifest:m,
  runId:id,seat:"jevbot",sequence:10});
 assert.equal(bindPairedScenes(sam,wrong,m),null);
});

test("forged packets with extra private fields are rejected even with recomputed digests",()=>{
 const m=manifest();
 const original=bindScene({scene:scene(),manifest:m,
  runId:id,seat:"sam",sequence:42});
 for(const change of [
   p=>{p.secret="PRIVATE_DATA";},
   p=>{p.scene.secret="PRIVATE_DATA";},
   p=>{p.scene.camera.secret="PRIVATE_DATA";},
   p=>{p.scene.commands[0].secret="PRIVATE_DATA";},
 ]){
  const p=structuredClone(original);change(p);
  const base={schema:p.schema,scope:p.scope,runId:p.runId,seat:p.seat,
   sequence:p.sequence,frameId:p.frameId,
   manifestDigest:p.manifestDigest,scene:p.scene};
  p.digest=sha256(Buffer.from(JSON.stringify(base)));
  assert.equal(validateBoundScene(p,m),false);
 }
});
test("manifest must reject undeclared keys and unreviewed alterations",()=>{
 const m=manifest();
 const bad=structuredClone(m);
 bad.secret="PRIVATE";
 assert.equal(validateBoundScene(bindScene({scene:scene(),manifest:m,
  runId:id,seat:"sam",sequence:1}),bad),false);
 const badAsset=structuredClone(m);
 badAsset.textures[0].secret="PRIVATE";
 assert.equal(validateBoundScene(bindScene({scene:scene(),manifest:m,
  runId:id,seat:"sam",sequence:1}),badAsset),false);
});
