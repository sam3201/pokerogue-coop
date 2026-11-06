import assert from "node:assert/strict";
import test from "node:test";
import {caught, validateStarterSnapshot, rankEligibleStarters, planCoopStarters, assessCapture}
  from "./pokerogue-starter-policy.mjs";

const rows = list => list.map(([speciesId,cost,caughtAttr,caughtCount=0],gridIndex) => ({
  speciesId, cost, caughtAttr: String(caughtAttr), caughtCount, gridIndex, selectable: true,
}));
const snap = (seat, candidates, budget=10) => ({
  seat, ui:"STARTER_SELECT", source:"loaded-game-dex", budget, partyLimit:6, candidates,
});

test("save's bigint-derived caught attr is respected without inventing unlock", () => {
  assert.equal(caught("0"), false);
  assert.equal(caught("1"), true);
  assert.equal(caught("1099511627776"), true);
  assert.equal(caught("not-number"), false);
  assert.equal(caught(-1), false);
  const c = rows([[1,3,1],[25,2,0],[50,2,1]]);
  c[2].selectable = false;
  assert.deepEqual(rankEligibleStarters(snap("host",c)).ranked.map(x=>x.speciesId),[1]);
});

test("confirmed capture needs verified input, game transition and save for restart", () => {
  const before={caughtAttr:"0",caughtCount:0};
  const after={caughtAttr:"1",caughtCount:1};
  const a=assessCapture(before,after,{speciesId:25,inputAccepted:true,saveConfirmed:false});
  assert.equal(a.newlyUnlocked, true);
  assert.equal(a.availableInRun, true);
  assert.equal(a.availableAfterRestart, false);
  assert.equal(assessCapture(before,after,{speciesId:25,inputAccepted:true,saveConfirmed:true}).availableAfterRestart,true);
  assert.equal(assessCapture(before,after,{speciesId:25,inputAccepted:false,saveConfirmed:true}).catchObserved,false);
  assert.equal(assessCapture(before,before,{speciesId:25,inputAccepted:true,saveConfirmed:true}).newlyUnlocked,false);
});

test("each seat selects its OWN collected Pokémon after reload", () => {
  const h=snap("host",rows([[1,3,1],[25,2,1,1]]));
  const g=snap("guest",rows([[25,2,0],[4,3,1],[5,2,1]]));
  const selected=planCoopStarters(h,g,{hostScores:{"25":0.9},guestScores:{"25":1,"5":0.8},sharedBudget:8});
  assert.equal(selected.host.speciesId,25);
  assert.equal(selected.guest.speciesId,5);
  assert.equal(selected.decisionSource,"model-scored");
  assert.equal(selected.verifiedInGame,false);
});

test("two-player shared starter costs and distinct species enforced",()=>{
  const h=snap("host",rows([[1,7,1],[3,4,1]]));
  const g=snap("guest",rows([[2,7,1],[4,4,1]]));
  const selected=planCoopStarters(h,g,{sharedBudget:8,hostScores:{"1":10},guestScores:{"2":10}});
  assert.equal(selected.host.cost+selected.guest.cost,8);
  assert.throws(()=>planCoopStarters(h,g,{sharedBudget:3}),/no legal/);
});

test("no action can be taken from synthetic, stale, or missing ownership",()=>{
  assert.throws(()=>validateStarterSnapshot({...snap("host",rows([[1,3,1]])),source:"synthetic"}),/unverified/);
  assert.throws(()=>rankEligibleStarters(snap("solo",rows([[1,3,0]]))),/no verified/);
  assert.throws(()=>rankEligibleStarters(snap("solo",rows([[1,3,1]])),{"1":Infinity}),/invalid model/);
  assert.equal(rankEligibleStarters(snap("solo",rows([[1,3,1]]))).decisionSource,"rules-fallback");
  assert.throws(()=>planCoopStarters(snap("guest",rows([[1,3,1]])),snap("host",rows([[2,3,1]]))),/mismatched/);
});
