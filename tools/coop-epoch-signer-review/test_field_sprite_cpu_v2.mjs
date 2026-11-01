import test from "node:test";
import assert from "node:assert/strict";
import {SCHEMA,validateFieldUniforms,applyFieldTintData,rgb2hsl,hsl2rgb}
  from "./field_sprite_cpu_v2.mjs";
function uniform(extra={}){
 return {schema:SCHEMA,time:0,ignoreTimeTint:false,isOutside:true,
   overrideTint:[0,0,0],dayTint:[.5,.5,.5],duskTint:[.3,.4,.5],
   nightTint:[.2,.2,.4],terrainColor:[1,0,0],
   terrainColorRatio:0,tintMode:"neutral",...extra};
}
test("full GLSL terrain hue applies only below the texture-UV threshold",()=>{
 const bytes=new Uint8ClampedArray(Array.from({length:4},()=>[0,0,255,255]).flat());
 const u=uniform({terrainColorRatio:.5});
 assert.equal(validateFieldUniforms(u),true);
 applyFieldTintData(bytes,u,{width:1,sourceHeight:4,sourceY:0});
 assert.deepEqual([...bytes],[
   0,0,255,255, 0,0,255,255, 255,0,0,255, 255,0,0,255]);
});
test("HSL round-trip preserves color luminance and saturation",()=>{
 const rgb=[.1,.5,.8];
 const out=hsl2rgb(rgb2hsl(rgb));
 for(let i=0;i<3;i++)assert.ok(Math.abs(out[i]-rgb[i])<1e-10);
});
test("terrain ratio and RGBA shape cannot bypass validation",()=>{
 assert.equal(validateFieldUniforms(uniform({terrainColorRatio:1.2})),false);
 assert.equal(validateFieldUniforms(uniform({terrainColor:[2,0,0]})),false);
 assert.throws(()=>applyFieldTintData(new Uint8ClampedArray(5),uniform()),/RGBA/);
 assert.throws(()=>applyFieldTintData(new Uint8ClampedArray(4),
  uniform({terrainColorRatio:.5}),{width:0,sourceHeight:0}),/geometry/);
});
test("no terrain tint preserves neutral daytime RGB",()=>{
 const u=uniform({terrainColorRatio:0});
 const bytes=new Uint8ClampedArray([12,128,245,255]);
 applyFieldTintData(bytes,u);
 assert.deepEqual([...bytes],[12,128,245,255]);
});
