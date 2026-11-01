import test from "node:test";
import assert from "node:assert/strict";
import {SCHEMA,validateFieldUniforms,activeTimeTint,applyFieldTintData}
  from "./field_sprite_cpu.mjs";
function uniform(extra={}){
  return {schema:SCHEMA,time:0,ignoreTimeTint:false,isOutside:true,
    overrideTint:[0,0,0],dayTint:[.5,.5,.5],
    duskTint:[.6,.3,.4],nightTint:[.2,.2,.4],
    terrainColorRatio:0,tintMode:"neutral",...extra};
}
test("neutral 0.5 hard-light tint preserves pixels",()=>{
 const bytes=new Uint8ClampedArray([0,64,255,255,128,192,12,255]);
 applyFieldTintData(bytes,uniform());
 assert.deepEqual([...bytes],[0,64,255,255,128,192,12,255]);
});
test("night tint is multiplied in the low-tint hard-light branch",()=>{
 const bytes=new Uint8ClampedArray([255,128,0,255]);
 applyFieldTintData(bytes,uniform({time:.65}));
 assert.deepEqual([...bytes],[102,51,0,255]);
});
test("indoor dawn interpolation uses day and night, not dusk",()=>{
 const u=uniform({time:.375,isOutside:false});
 const tint=activeTimeTint(u);
 assert.ok(Math.abs(tint[0]-.35)<.00001);
 assert.ok(Math.abs(tint[2]-.45)<.00001);
});
test("override tint supersedes time and ignored tint is pass-through",()=>{
 assert.deepEqual(activeTimeTint(uniform({
   time:.65,overrideTint:[.7,.6,.5]})),[.7,.6,.5]);
 const d=new Uint8ClampedArray([42,27,23,128]);
 const result=applyFieldTintData(d,uniform({ignoreTimeTint:true}));
 assert.deepEqual([...result],[42,27,23,128]);
});
test("unsupported terrain recolor or tint modes fail closed",()=>{
 assert.equal(validateFieldUniforms(uniform({terrainColorRatio:.2})),false);
 assert.equal(validateFieldUniforms(uniform({tintMode:"solid"})),false);
 assert.equal(validateFieldUniforms(uniform({time:NaN})),false);
 assert.throws(()=>applyFieldTintData(new Uint8ClampedArray(4),
   uniform({terrainColorRatio:.2})),/Unsupported/);
});
