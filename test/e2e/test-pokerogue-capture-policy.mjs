import test from "node:test";
import assert from "node:assert/strict";
import {
  proposeCapture, validateCaptureSnapshot, observeCaptureOutcome, requestCapture,
} from "./pokerogue-capture-policy.mjs";

function game({
  seat="host", speciesId=25, caughtAttr="0", hp=25, maxHp=100,
  catchRate=190, battleType=0, specialBattle=false, isChallenge=false,
  boss=false, ballCounts=[9,4,2,0,0], enemies,
}={}){
  return {
    source:"loaded-game-battle",seat,ui:"COMMAND",wave:4,turn:2,
    battleType,specialBattle,isChallenge,ballCounts,
    enemies:enemies??[{speciesId,hp,maxHp,catchRate,boss,caughtAttr}],
  };
}
test("new weak wild species produces bounded real-game capture intent",()=>{
  const s=game();
  const p=proposeCapture(s);
  assert.equal(p.kind,"propose-capture");
  assert.equal(p.ballType,0);
  assert.equal(p.seat,"host");
  assert.equal(p.speciesId,25);
  assert.equal(p.verifiedCatch,false);
  assert.equal(p.estimateType,"heuristic-not-catch-probability");
  assert.equal(proposeCapture(s,{alreadyAttempted:true}).kind,"fight");
});
test("already-caught and unweakened species never spend Poké Balls",()=>{
  assert.equal(proposeCapture(game({caughtAttr:"16"})).kind,"fight");
  assert.equal(proposeCapture(game({hp:80})).kind,"fight");
  assert.equal(proposeCapture(game({hp:0})).kind,"fight");
  assert.equal(proposeCapture(game({ballCounts:[0,0,0,0,1]})).kind,"fight");
});
test("trainer, challenged, boss, special, multi-target and invalid state rejected",()=>{
  for(const s of [
    game({battleType:1}),game({isChallenge:true}),game({specialBattle:true}),
    game({boss:true}),game({enemies:[]}),
    game({enemies:[game().enemies[0],game().enemies[0]]}),
  ])assert.equal(proposeCapture(s).kind,"fight");
  assert.throws(()=>validateCaptureSnapshot(game({hp:-4})),/invalid/);
  assert.throws(()=>validateCaptureSnapshot(game({ballCounts:[4,-1,0,0,0]})),/invalid/);
  assert.throws(()=>validateCaptureSnapshot({...game(),source:"synthetic"}),/invalid/);
});
test("capture outcome distinguishes attempted input, caught ownership and saved unlock",()=>{
  const before=game();
  const after={source:"loaded-game-dex",seat:"host",entries:[{speciesId:25,caughtAttr:"1",caughtCount:1}]};
  assert.deepEqual(observeCaptureOutcome(before,after,{saveConfirmed:true}),{
    speciesId:25,newlyUnlocked:true,eligibleAfterConfirmedSave:true,source:"observed-dex-transition",
  });
  assert.equal(observeCaptureOutcome(before,after,{saveConfirmed:false}).eligibleAfterConfirmedSave,false);
  assert.equal(observeCaptureOutcome(before,{...after,entries:[]}).newlyUnlocked,false);
});
test("expired capture proposal and cross-seat proposal cannot send input",async()=>{
  const proposal=proposeCapture(game());
  const fake={page:{evaluate:async()=>game({seat:"host",speciesId:26})}};
  await assert.rejects(()=>requestCapture(fake,"guest",proposal),/invalid capture proposal/);
  await assert.rejects(()=>requestCapture(fake,"host",{...proposal,wave:5}),/expired/);
});
