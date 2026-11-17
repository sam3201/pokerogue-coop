import test from "node:test";
import assert from "node:assert/strict";
import { assessMacGameplayFrames } from "./pokerogue-mac-fps-acceptance.mjs";

const valid = () => ({
  frameIntervalsMs: Array.from({length:239},()=>33.3),
  elapsedMs:8000, frameCount:240,
  waveAtStart:1,phaseAtStart:"SummonPhase",
  waveAtEnd:1,phaseAtEnd:"SummonPhase",
  visibility:"visible",focused:true,renderBackend:2,canvasCount:1,
  phaserReportedFps:32,submittedInputs:3,rendererString:"ANGLE Metal",
});

test("focused visible co-op battle can meet Mac 30 FPS / p95 target",()=>{
  const result=assessMacGameplayFrames(valid());
  assert.equal(result.validGameplaySample,true);
  assert.equal(result.meetsFrameTarget,true);
  assert.equal(result.measuredFps,30);
  assert.equal(result.p95IntervalMs,33.3);
  assert.equal(result.gamePolicyTrainingPerformed,false);
  assert.equal(result.macHardwareAccelerationVerified,false);
});
test("does not accept background or unfocused browser frames",()=>{
  for(const values of [{visibility:"hidden"},{focused:false}]){
    const result=assessMacGameplayFrames({...valid(),...values});
    assert.equal(result.validGameplaySample,false);
    assert.equal(result.meetsFrameTarget,false);
  }
});
test("game must be in a live wave with real attempted inputs and WebGL",()=>{
  for(const change of [
    {waveAtStart:0},{phaseAtStart:"SelectModifierPhase"},
    {phaseAtStart:"GameOverPhase"},{phaseAtStart:"TitlePhase"},
    {phaseAtStart:""},{phaseAtStart:"UNKNOWN"},
    {phaseAtEnd:"SelectModifierPhase"},{phaseAtEnd:"GameOverPhase"},
    {waveAtEnd:2},{waveAtEnd:0},{phaseAtEnd:"UNKNOWN"},
    {renderBackend:1},
    {submittedInputs:0},{canvasCount:0}
  ]){
    const result=assessMacGameplayFrames({...valid(),...change});
    assert.equal(result.meetsFrameTarget,false);
  }
});
test("poor average or p95 fails even if battle state is valid",()=>{
  const slow=assessMacGameplayFrames({...valid(),elapsedMs:16000});
  assert.equal(slow.validGameplaySample,true);
  assert.equal(slow.meetsFrameTarget,false);
  const jitter=valid();
  jitter.frameIntervalsMs.splice(225,14,...Array(14).fill(110));
  const burst=assessMacGameplayFrames(jitter);
  assert.equal(burst.meetsFrameTarget,false);
  assert.equal(burst.p95IntervalMs,110);
});
test("rejects nonnumeric frame intervals and malformed sample quantities",()=>{
  for(const change of [
    {frameIntervalsMs:[16,NaN,18]},
    {frameIntervalsMs:[16,-2,18]},
    {frameIntervalsMs:"fast"},
    {elapsedMs:0},{elapsedMs:Infinity},{frameCount:3.5},
    {frameCount:5000},{frameIntervalsMs:[33,33]}
  ]){
    assert.throws(()=>assessMacGameplayFrames({...valid(),...change}),TypeError);
  }
  assert.throws(()=>assessMacGameplayFrames(valid(),{minFps:0}),RangeError);
});
test("invalid or missing performance samples cannot pass",()=>{
  const a=assessMacGameplayFrames({...valid(),frameCount:8,frameIntervalsMs:[33,33,33,33,33,33,33]});
  assert.equal(a.meetsFrameTarget,false);
  const b=assessMacGameplayFrames({...valid(),submittedInputs:undefined});
  assert.equal(b.meetsFrameTarget,false);
  const c=assessMacGameplayFrames({...valid(),elapsedMs:3000});
  assert.equal(c.validGameplaySample,false);
  assert.equal(c.meetsFrameTarget,false);
});
