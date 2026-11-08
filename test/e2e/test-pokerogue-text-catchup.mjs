import assert from "node:assert/strict";
import test from "node:test";
import {shouldFlushSlowCoopText} from "../../src/coop/text-catchup.ts";

function state(overrides={}) {
  return {
    linked:true,actualFps:2.08,delayMs:20,
    text:"Player sent out a Pokemon!",
    hasInlineEffects:false,...overrides,
  };
}

test("slow linked co-op ordinary text uses existing zero-delay callback path",()=>{
  assert.equal(shouldFlushSlowCoopText(state()),true);
  assert.equal(shouldFlushSlowCoopText(state({actualFps:1.19})),true);
  assert.equal(shouldFlushSlowCoopText(state({actualFps:7.99})),true);
  assert.equal(shouldFlushSlowCoopText(state({delayMs:null})),true);
});
test("solo and healthy co-op retain normal typewriter animation",()=>{
  assert.equal(shouldFlushSlowCoopText(state({linked:false})),false);
  assert.equal(shouldFlushSlowCoopText(state({actualFps:8})),false);
  assert.equal(shouldFlushSlowCoopText(state({actualFps:30})),false);
  assert.equal(shouldFlushSlowCoopText(state({actualFps:60})),false);
});
test("never skip explicitly timed or effect-bearing message sequences",()=>{
  assert.equal(shouldFlushSlowCoopText(state({delayMs:80})),false);
  assert.equal(shouldFlushSlowCoopText(state({delayMs:0})),false);
  assert.equal(shouldFlushSlowCoopText(state({hasInlineEffects:true})),false);
});
test("invalid, missing and startup FPS values fail closed",()=>{
  for(const fps of [0,-1,Infinity,-Infinity,NaN,undefined])
    assert.equal(shouldFlushSlowCoopText(state({actualFps:fps})),false);
  assert.equal(shouldFlushSlowCoopText(state({text:""})),false);
  assert.equal(shouldFlushSlowCoopText(state({text:"Hey"})),false);
});
