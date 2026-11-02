import test from "node:test";
import assert from "node:assert/strict";
import {capturePhaserSprites} from "./phaser_sprite_probe.mjs";
import {validateSpriteScene,PhaserSpriteCanvas} from "./phaser_sprite_canvas.mjs";

const gameOrigin="http://127.0.0.1:8000";
globalThis.location={origin:gameOrigin};
const camera={width:1920,height:1080,x:0,y:0,scrollX:30,scrollY:40,zoom:1,rotation:0};
function sprite(extra={}) {
  return {
    visible:true,active:true,alpha:1,blendMode:0,displayOriginX:16,displayOriginY:8,
    scrollFactorX:1,scrollFactorY:1,
    texture:{key:"safe"},
    frame:{cutX:0,cutY:0,cutWidth:32,cutHeight:16,width:32,height:16,
      source:{image:{src:gameOrigin+"/images/pokemon/pikachu.png"}}},
    getWorldTransformMatrix:()=>({a:1,b:0,c:0,d:1,tx:100,ty:120}),...extra
  };
}
const scene=children=>({cameras:{main:camera},children:{list:children}});
function mockCanvas() {
  const log=[];
  const ctx={
    setTransform(...args){log.push(["transform",...args]);},
    clearRect(...args){log.push(["clear",...args]);},
    drawImage(...args){log.push(["draw",...args]);},
    save(){log.push(["save"]);},
    restore(){log.push(["restore"]);},
    beginPath(){log.push(["begin-path"]);},
    rect(...args){log.push(["rect",...args]);},
    moveTo(...args){log.push(["move-to",...args]);},
    lineTo(...args){log.push(["line-to",...args]);},
    closePath(){log.push(["close-path"]);},
    clip(...args){log.push(["clip",...args]);},
    ellipse(...args){log.push(["ellipse",...args]);},
    fill(){log.push(["fill"]);},
    scale(...args){log.push(["scale",...args]);},
    set globalAlpha(v){log.push(["alpha",v]);},
    set imageSmoothingEnabled(v){log.push(["smoothing",v]);},
  };
  return {width:0,height:0,getContext:()=>ctx,log};
}
test("one real Phaser sprite becomes one bounded texture draw",async()=>{
  const snapshot=capturePhaserSprites(scene([sprite()]));
  assert.equal(snapshot.schema,"sam.coop.phaser-sprites.probe.v1");
  assert.equal(snapshot.coverage.complete,true);
  assert.equal(snapshot.coverage.captured,1);
  assert.ok(validateSpriteScene(snapshot));
  const canvas=mockCanvas();
  const compositor=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  const result=await compositor.render(snapshot);
  assert.equal(result.ok,true);
  assert.equal(canvas.width,320);
  assert.equal(canvas.height,180);
  assert.deepEqual(canvas.log.find(x=>x[0]==="draw").slice(2),[0,0,32,16,-16,-8,32,16]);
  const transform=canvas.log.find(x=>x[0]==="transform"&&x[5]!==0);
  assert.ok(transform);
  assert.ok(Math.abs(transform[5]-(100-30)/6)<0.001);
});
test("unsupported Phaser text is never serialized",async()=>{
  const snapshot=capturePhaserSprites(scene([sprite(),{
    visible:true,alpha:1,active:true,type:"Text",text:"SECRET_ROOM_ABC123"
  }]));
  assert.equal(snapshot.coverage.complete,false);
  assert.equal(snapshot.coverage.skipped.type,1);
  assert.equal(JSON.stringify(snapshot).includes("SECRET_ROOM"),false);
  const compositor=new PhaserSpriteCanvas(mockCanvas(),async()=>({width:64,height:64}));
  assert.equal((await compositor.render(snapshot)).reason,"unaccepted-coverage");
  assert.equal((await compositor.render(snapshot,{allowPartial:true})).ok,true);
});
test("texture paths outside game image directory fail closed",()=>{
  for(const path of ["https://evil.example/images/pokemon/pikachu.png",
    "https://evil.example/secret.jpg","data:image/png;base64,AAAA",
    gameOrigin+"/login/token.png","file:///etc/passwd"]) {
    assert.equal(capturePhaserSprites(scene([sprite({frame:{
      ...sprite().frame,source:{image:{src:path}}
    }})])).coverage.captured,0);
  }
});
test("hidden, tinted, and filtered objects count as skipped",()=>{
  const s=capturePhaserSprites(scene([sprite({visible:false}),sprite({isTinted:true}),sprite({mask:{}})]));
  assert.equal(s.coverage.captured,0);
  assert.equal(s.coverage.skipped.hidden,1);
  assert.equal(s.coverage.skipped.tint,1);
  assert.equal(s.coverage.skipped.mask,1);
});
test("invalid scene protocol rejects remote URLs and executable primitives",()=>{
  const s=capturePhaserSprites(scene([sprite()]));
  s.commands[0].texture="https://evil.example/token.png";
  assert.equal(validateSpriteScene(s),false);
  s.commands[0].op="script";
  assert.equal(validateSpriteScene(s),false);
});
test("camera transformations and nested alpha preserve bounded draw semantics",()=>{
  const s=capturePhaserSprites(scene([{
    visible:true,active:true,alpha:0.5,list:[sprite({alpha:0.5})]
  }]));
  assert.equal(s.commands[0].alpha,0.25);
  assert.equal(validateSpriteScene(s),true);
});

test("blob-backed texture is usable only in explicit private memory lab",async()=>{
  const source={src:gameOrigin+"/images/pokemon/pikachu.png"};
  source.src="blob:http://127.0.0.1:8000/15e79d1f-f89e-45df-aaa0-6fb35e1c7982";
  const obj=sprite({frame:{
    ...sprite().frame,source:{image:source}
  }});
  const snapshot=capturePhaserSprites(scene([obj]),{
    labTextureResolver:(image)=>{
      assert.equal(image,source);
      return "/images/__lab_memory__/1.png";
    }
  });
  assert.equal(snapshot.labOnly,true);
  assert.equal(snapshot.coverage.captured,1);
  assert.equal(validateSpriteScene(snapshot),false);
  assert.equal(validateSpriteScene(snapshot,{allowLabMemory:true}),true);
  const renderer=new PhaserSpriteCanvas(mockCanvas(),async key=>{
    assert.equal(key,"/images/__lab_memory__/1.png");
    return {width:64,height:64};
  });
  assert.equal((await renderer.render(snapshot,{allowPartial:true})).reason,"invalid-protocol");
  assert.equal((await renderer.render(snapshot,{allowPartial:true,allowLabMemory:true})).ok,true);
});

test("field-sprite custom shader is only sampled as an explicit lab approximation",()=>{
  const input=scene([sprite({pipeline:{name:"FieldSprite"}})]);
  const production=capturePhaserSprites(input);
  assert.equal(production.coverage.captured,0);
  assert.equal(production.coverage.skipped.pipeline,1);
  const lab=capturePhaserSprites(input,{labFieldPipeline:true});
  assert.equal(lab.coverage.captured,1);
  assert.equal(lab.labOnly,true);
  assert.equal(validateSpriteScene(lab),false);
  assert.equal(validateSpriteScene(lab,{allowLabMemory:true}),true);
  const unsupported=capturePhaserSprites(scene([sprite({pipeline:{name:"sprite"}})]),{
    labFieldPipeline:true
  });
  assert.equal(unsupported.coverage.captured,0);
});

test("hidden Phaser objects do not reduce frame coverage",()=>{
  const s=capturePhaserSprites(scene([sprite(),sprite({visible:false})]));
  assert.equal(s.coverage.captured,1);
  assert.equal(s.coverage.skipped.hidden,1);
  assert.equal(s.coverage.complete,true);
  assert.equal(validateSpriteScene(s),true);
});
test("visible missing masks remain a hard coverage failure",()=>{
  const s=capturePhaserSprites(scene([sprite(),sprite({mask:{}})]));
  assert.equal(s.coverage.captured,1);
  assert.equal(s.coverage.skipped.mask,1);
  assert.equal(s.coverage.complete,false);
});

test("geometry mask approximation never enters public protocol",()=>{
  class GeometryMask {}
  const s=scene([sprite({mask:new GeometryMask()})]);
  const baseline=capturePhaserSprites(s);
  assert.equal(baseline.coverage.captured,0);
  assert.equal(baseline.coverage.skipped.mask,1);
  const approximation=capturePhaserSprites(s,{labIgnoreGeometryMask:true});
  assert.equal(approximation.coverage.captured,1);
  assert.equal(approximation.labOnly,true);
  assert.equal(validateSpriteScene(approximation),false);
  assert.equal(validateSpriteScene(approximation,{allowLabMemory:true}),true);
});

test("nine-slice expands a Phaser source frame into nine canvas draws",async()=>{
  const obj=sprite({type:"NineSlice",width:72,height:40,
    leftWidth:8,rightWidth:8,topHeight:5,bottomHeight:5,
    displayOriginX:0,displayOriginY:0});
  const packet=capturePhaserSprites(scene([obj]));
  const cmd=packet.commands[0];
  assert.equal(cmd.op,"nineSlice");
  assert.deepEqual(cmd.borders,[8,8,5,5]);
  assert.deepEqual(cmd.dst,[0,0,72,40]);
  assert.equal(validateSpriteScene(packet),true);
  const canvas=mockCanvas();
  const compositor=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await compositor.render(packet)).ok,true);
  const calls=canvas.log.filter(x=>x[0]==="draw");
  assert.equal(calls.length,9);
  assert.deepEqual(calls[4].slice(2),[8,5,16,6,8,5,56,30]);
});
test("malformed nine-slice borders are rejected",()=>{
  const obj=sprite({type:"NineSlice",width:72,height:40,
    leftWidth:40,rightWidth:8,topHeight:5,bottomHeight:5});
  const packet=capturePhaserSprites(scene([obj]));
  assert.equal(packet.coverage.captured,0);
  assert.equal(packet.coverage.skipped["nine-slice-bounds"],1);
});
test("three-slice windows draw left center right only",async()=>{
  const obj=sprite({type:"NineSlice",width:72,height:16,
    leftWidth:8,rightWidth:8,topHeight:0,bottomHeight:0});
  const packet=capturePhaserSprites(scene([obj]));
  const canvas=mockCanvas();
  const compositor=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await compositor.render(packet)).ok,true);
  assert.equal(canvas.log.filter(x=>x[0]==="draw").length,3);
});

test("640x360 private compositor preserves the native capture grid",async()=>{
  const snapshot=capturePhaserSprites(scene([sprite()]));
  const canvas=mockCanvas();
  const renderer=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await renderer.render(snapshot,{labOutputWidth:640})).ok,true);
  assert.equal(canvas.width,640);
  assert.equal(canvas.height,360);
  assert.equal((await renderer.render(snapshot,{labOutputWidth:641})).reason,
    "unsupported-output-size");
});

test("a lab shader approximation is never faithful frame coverage",()=>{
  const s=capturePhaserSprites(scene([sprite({pipeline:{name:"FieldSprite"}})]),{
    labFieldPipeline:true
  });
  assert.equal(s.coverage.captured,1);
  assert.equal(s.coverage.approximated.fieldShader,1);
  assert.equal(s.coverage.complete,false);
  assert.equal(validateSpriteScene(s),false);
  assert.equal(validateSpriteScene(s,{allowLabMemory:true}),true);
});
test("a lab geometry-mask bypass cannot be promoted as complete",async()=>{
  class GeometryMask {}
  const s=capturePhaserSprites(scene([sprite({mask:new GeometryMask()})]),{
    labIgnoreGeometryMask:true
  });
  assert.equal(s.coverage.captured,1);
  assert.equal(s.coverage.approximated.geometryMask,1);
  assert.equal(s.coverage.complete,false);
  const compositor=new PhaserSpriteCanvas(mockCanvas(),async()=>({width:64,height:64}));
  assert.equal((await compositor.render(s,{allowLabMemory:true})).reason,"unaccepted-coverage");
  s.coverage.complete=true;
  assert.equal(validateSpriteScene(s,{allowLabMemory:true}),false);
});

function rectMask(type="Rectangle",custom={}) {
  const geometry={type,width:20,height:10,displayOriginX:0,displayOriginY:0,
    scrollFactorX:1,scrollFactorY:1,
    getWorldTransformMatrix:()=>({a:1,b:0,c:0,d:1,tx:110,ty:150}),
    ...(type==="Graphics"?{commandBuffer:[7,0xffffff,1,1,3,1,2,20,10]}:{}),
    ...custom};
  return {constructor:{name:"GeometryMask"},geometryMask:geometry,invertAlpha:false};
}
test("rectangular GeometryMask is clipped with its independent world transform",async()=>{
  const packet=capturePhaserSprites(scene([sprite({mask:rectMask()})]),{
    labRectGeometryMask:true
  });
  assert.equal(packet.coverage.captured,1);
  assert.equal(packet.coverage.approximated.geometryMask,0);
  assert.equal(packet.coverage.complete,true);
  assert.deepEqual(packet.commands[0].clip.rect,[0,0,20,10]);
  assert.equal(validateSpriteScene(packet),false);
  assert.equal(validateSpriteScene(packet,{allowLabMemory:true}),true);
  const canvas=mockCanvas();
  const comp=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await comp.render(packet,{allowLabMemory:true})).ok,true);
  const ops=canvas.log.map(x=>x[0]);
  assert.ok(ops.indexOf("save")<ops.indexOf("clip"));
  assert.ok(ops.indexOf("clip")<ops.indexOf("draw"));
  assert.ok(ops.indexOf("draw")<ops.indexOf("restore"));
  assert.deepEqual(canvas.log.find(x=>x[0]==="rect").slice(1),[0,0,20,10]);
});
test("single filled Graphics rectangle can define a GeometryMask",()=>{
  const packet=capturePhaserSprites(scene([sprite({mask:rectMask("Graphics")})]),{
    labRectGeometryMask:true
  });
  assert.equal(packet.coverage.captured,1);
  assert.deepEqual(packet.commands[0].clip.rect,[1,2,20,10]);
});
test("unsupported Graphics mask paths fail closed",()=>{
  const tests=[
    rectMask("Graphics",{commandBuffer:[0,10,10,9,0,1]}),
    rectMask("Graphics",{commandBuffer:[3,1,2,20,10,3,2,3,4,5]}),
    rectMask("Rectangle",{width:-1})
  ];
  for(const mask of tests){
    const packet=capturePhaserSprites(scene([sprite({mask})]),{
      labRectGeometryMask:true
    });
    assert.equal(packet.coverage.captured,0);
    assert.equal(packet.coverage.skipped.mask,1);
    assert.equal(packet.coverage.complete,false);
  }
});

test("CustomProgress filled vector shapes reproduce bounded stencil polygons",async()=>{
  const mask=rectMask("Graphics",{commandBuffer:undefined,
    geom:[{isFilled:true,pathData:[0,0,4,0,4,6,0,6,0,0]},
          {isFilled:true,pathData:[8,0,12,0,12,6,8,6,8,0]}]});
  const packet=capturePhaserSprites(scene([sprite({mask})]),{
    labRectGeometryMask:true
  });
  assert.equal(packet.coverage.captured,1);
  assert.equal(packet.coverage.approximated.geometryMask,0);
  assert.deepEqual(packet.commands[0].clip.polygons,[
    [0,0,4,0,4,6,0,6],[8,0,12,0,12,6,8,6]]);
  const canvas=mockCanvas();
  const comp=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await comp.render(packet,{allowLabMemory:true})).ok,true);
  assert.equal(canvas.log.filter(x=>x[0]==="close-path").length,2);
  assert.equal(canvas.log.filter(x=>x[0]==="clip").length,1);
  assert.equal(validateSpriteScene(packet),false);
});
test("invalid CustomProgress paths fail closed",()=>{
  for(const shapes of [
    [{isFilled:true,pathData:[0,0,4,0,4,6,0,6]}],
    [{isFilled:true,pathData:[0,0,Infinity,0,4,6,0,6,0,0]}],
    Array.from({length:33},()=>({isFilled:true,pathData:[0,0,4,0,4,6,0,6,0,0]}))
  ]) {
    const mask=rectMask("Graphics",{commandBuffer:undefined,geom:shapes});
    const s=capturePhaserSprites(scene([sprite({mask})]),{
      labRectGeometryMask:true
    });
    assert.equal(s.coverage.captured,0);
    assert.equal(s.coverage.skipped.mask,1);
  }
});

test("inverted disjoint Rex blinds clip outside the rectangular paths",async()=>{
  const mask=rectMask("Graphics",{commandBuffer:undefined,geom:[
    {isFilled:true,pathData:[0,0,0.16,0,0.16,180,0,180,0,0]},
    {isFilled:true,pathData:[32,0,32.16,0,32.16,180,32,180,32,0]}
  ]});
  mask.invertAlpha=true;
  const packet=capturePhaserSprites(scene([sprite({mask})]),{
    labRectGeometryMask:true
  });
  assert.equal(packet.coverage.captured,1);
  assert.equal(packet.coverage.approximated.geometryMask,0);
  assert.equal(packet.commands[0].clip.inverted,true);
  const canvas=mockCanvas();
  const compositor=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
  assert.equal((await compositor.render(packet,{allowLabMemory:true})).ok,true);
  assert.deepEqual(canvas.log.find(x=>x[0]==="clip"),["clip","evenodd"]);
  assert.deepEqual(canvas.log.find(x=>x[0]==="rect").slice(1),[0,0,320,180]);
});
test("overlapping inverted mask rectangles are rejected",()=>{
  const mask=rectMask("Graphics",{commandBuffer:undefined,geom:[
    {isFilled:true,pathData:[0,0,5,0,5,9,0,9,0,0]},
    {isFilled:true,pathData:[4,0,8,0,8,9,4,9,4,0]}
  ]});
  mask.invertAlpha=true;
  const packet=capturePhaserSprites(scene([sprite({mask})]),{
    labRectGeometryMask:true
  });
  assert.equal(packet.coverage.captured,0);
  assert.equal(packet.coverage.skipped.mask,1);
});

test("FieldSprite CPU processor is private, bounded and never a public scene command",async()=>{
 const uniforms={schema:"sam.coop.field-tint-lab.v1",time:0.35,
   ignoreTimeTint:false,isOutside:true,overrideTint:[0,0,0],
   dayTint:[.5,.5,.5],duskTint:[.4,.3,.2],nightTint:[.2,.2,.4],
   terrainColor:[0,0,0],terrainColorRatio:0,tintMode:"neutral"};
 const packet=capturePhaserSprites(scene([
   sprite({pipeline:{name:"FieldSprite"}})]),{
   labFieldPipeline:true,labFieldUniforms:()=>uniforms
 });
 assert.equal(packet.commands[0].shader.schema,uniforms.schema);
 assert.equal(packet.coverage.complete,false);
 assert.equal(validateSpriteScene(packet),false);
 assert.equal(validateSpriteScene(packet,{allowLabMemory:true}),true);
 const canvas=mockCanvas();
 const renderer=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
 let calls=0;
 const result=await renderer.render(packet,{
   allowPartial:true,allowLabMemory:true,
   labShaderProcessor:async (_image,src,provided)=>{
     calls++;assert.equal(provided.time,.35);
     assert.deepEqual(src,[0,0,32,16]);
     return {width:32,height:16};
   }
 });
 assert.equal(result.ok,true);
 assert.equal(calls,1);
 assert.deepEqual(canvas.log.find(x=>x[0]==="draw").slice(2),
   [0,0,32,16,-16,-8,32,16]);
});

test("bounded shader cache reuses a static frame and invalidates on uniform change",async()=>{
 const state={schema:"sam.coop.field-tint-lab.v1",time:.2,ignoreTimeTint:false,
   isOutside:true,overrideTint:[0,0,0],dayTint:[.5,.5,.5],
   duskTint:[.4,.3,.2],nightTint:[.2,.2,.4],
   terrainColor:[0,0,0],terrainColorRatio:0,tintMode:"neutral"};
 const packet=capturePhaserSprites(scene([
   sprite({pipeline:{name:"FieldSprite"}})]),{
   labFieldPipeline:true,labFieldUniforms:()=>state
 });
 let calls=0;
 const comp=new PhaserSpriteCanvas(mockCanvas(),async()=>({width:64,height:64}));
 const opts={allowPartial:true,allowLabMemory:true,
   labShaderProcessor:async()=>{calls++;return {width:32,height:16};}};
 assert.equal((await comp.render(packet,opts)).ok,true);
 assert.equal((await comp.render(packet,opts)).ok,true);
 assert.equal(calls,1);
 packet.commands[0].shader.time=.3;
 assert.equal((await comp.render(packet,opts)).ok,true);
 assert.equal(calls,2);
 comp.clearCache();
 assert.equal((await comp.render(packet,opts)).ok,true);
 assert.equal(calls,3);
});

test("neutral SpritePipeline body can be sampled but shadow remains unaccepted",()=>{
 const uniforms={schema:"sam.coop.field-tint-lab.v1",time:.35,
   ignoreTimeTint:false,isOutside:true,overrideTint:[0,0,0],
   dayTint:[.5,.5,.5],duskTint:[.4,.3,.2],nightTint:[.2,.2,.4],
   terrainColor:[0,0,0],terrainColorRatio:0,tintMode:"neutral"};
 const obj=sprite({pipeline:{name:"Sprite"},
   pipelineData:{tone:[0,0,0,0],hasShadow:true,isTerastallized:false}});
 const packet=capturePhaserSprites(scene([obj]),{
   labSpriteBasePipeline:true,labFieldUniforms:()=>uniforms
 });
 assert.equal(packet.coverage.captured,1);
 assert.equal(packet.coverage.approximated.spriteBase,1);
 assert.equal(packet.coverage.approximated.spriteShadow,1);
 assert.equal(packet.coverage.complete,false);
 assert.equal(validateSpriteScene(packet),false);
 assert.equal(validateSpriteScene(packet,{allowLabMemory:true}),true);
});
test("nonneutral Pokémon sprite effects remain excluded",()=>{
 for(const pipelineData of [
   {tone:[1,0,0,0]},{isTerastallized:true},
   {spriteColors:[[1,2,3,4]]},{fusionSpriteColors:[[1,2,3,4]]}
 ]){
   const packet=capturePhaserSprites(scene([sprite({
     pipeline:{name:"Sprite"},pipelineData})]),{labSpriteBasePipeline:true});
   assert.equal(packet.coverage.captured,0);
   assert.equal(packet.coverage.skipped.pipeline,1);
 }
});

test("Pokemon SpritePipeline ground-shadow projection is lab-only and drawn under sprite",async()=>{
 const field={x:0,y:0,scale:6};
 const parent={constructor:{name:"Pokemon"},x:30,y:50,
   scale:1,parentContainer:field};
 const obj=sprite({x:0,y:0,width:32,height:16,originY:.5,
   parentContainer:parent,frame:{...sprite().frame,x:0},
   pipeline:{name:"Sprite"},pipelineData:{tone:[0,0,0,0],hasShadow:true}});
 const u={schema:"sam.coop.field-tint-lab.v1",time:.2,
   ignoreTimeTint:false,isOutside:true,overrideTint:[0,0,0],
   dayTint:[.5,.5,.5],duskTint:[.4,.4,.4],nightTint:[.3,.3,.3],
   terrainColor:[0,0,0],terrainColorRatio:0,tintMode:"neutral"};
 const packet=capturePhaserSprites(scene([obj]),{
   labSpriteBasePipeline:true,labProjectedShadow:true,labFieldUniforms:()=>u
 });
 assert.equal(packet.coverage.captured,1);
 assert.ok(Array.isArray(packet.commands[0].shadow));
 assert.equal(packet.coverage.complete,false);
 assert.equal(validateSpriteScene(packet),false);
 const canvas=mockCanvas();
 const comp=new PhaserSpriteCanvas(canvas,async()=>({width:64,height:64}));
 assert.equal((await comp.render(packet,{allowPartial:true,
   allowLabMemory:true})).ok,true);
 const ops=canvas.log.map(x=>x[0]);
 assert.ok(ops.indexOf("ellipse")>=0);
 assert.ok(ops.indexOf("ellipse")<ops.indexOf("draw"));
 assert.ok(ops.indexOf("fill")<ops.indexOf("draw"));
});
