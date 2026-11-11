import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {checkpointSeatState, restoreSeatState, validateSeatSnapshot}
  from "./pokerogue-seat-state.mjs";

const origin="http://127.0.0.1:8000";
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),"sam-pokemon-save-"));
function mockClient(value="encrypted-game-system-data") {
  const state={origins:[{origin,localStorage:[
    {name:"data_undefined",value}, {name:"settings",value:"not-allowed"},
  ]}], cookies:[{name:"secret",value:"do-not-store"}]};
  let flush=0;
  return {client:{
    page:{url:()=>origin+"/", evaluate:async()=>{flush++},
      context:()=>({storageState:async()=>state})}},
    flushes:()=>flush
  };
}
test("checkpoint stores only game-generated data and preserves seat isolation",async()=>{
  const base=dir();
  try {
    const fixture=mockClient();
    const saved=await checkpointSeatState(fixture.client,"sam",base);
    assert.equal(saved.verifiedGameSave,true);
    assert.equal(fixture.flushes(),1);
    const raw=fs.readFileSync(path.join(base,"sam.json"),"utf8");
    assert.doesNotMatch(raw,/secret|settings/);
    assert.equal(fs.statSync(path.join(base,"sam.json")).mode & 0o777,0o600);
    const target={init:null,addInitScript:async (_fn,payload)=>{target.init=payload}};
    const restored=await restoreSeatState(target,"sam",base,origin);
    assert.equal(restored.restored,true);
    assert.deepEqual(target.init.localStorage,[{name:"data_undefined",value:"encrypted-game-system-data"}]);
    await assert.rejects(()=>restoreSeatState(target,"jevbot",base,origin),/./).catch(()=>{});
    assert.equal((await restoreSeatState(target,"jevbot",base,origin)).restored,false);
    assert.throws(()=>validateSeatSnapshot(JSON.parse(raw),"jevbot",origin),/wrong seat/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test("rejects invalid origin, snapshots and empty game state",async()=>{
  const base=dir();
  try {
    const fixture=mockClient();
    await assert.rejects(()=>checkpointSeatState(fixture.client,"third",base),/unknown seat/);
    const x={page:{url:()=>"http://example.com/",context:()=>({storageState:async()=>({origins:[]})})}};
    await assert.rejects(()=>checkpointSeatState(x,"sam",base,{flushGameSave:false}),/local test origin/);
    const empty={page:{url:()=>origin+"/",context:()=>({storageState:async()=>({origins:[]})})}};
    await assert.rejects(()=>checkpointSeatState(empty,"sam",base,{flushGameSave:false}),/no valid/);
    assert.equal(fs.existsSync(path.join(base,"sam.json")),false);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test("detects tampering and does not import another player's save",async()=>{
  const base=dir();
  try {
    await checkpointSeatState(mockClient("owned").client,"sam",base,{flushGameSave:false});
    const file=path.join(base,"sam.json");
    const raw=JSON.parse(fs.readFileSync(file,"utf8"));raw.localStorage[0].value="tampered";
    fs.writeFileSync(file,JSON.stringify(raw));
    await assert.rejects(()=>restoreSeatState({addInitScript:async()=>{}},"sam",base,origin),/checksum/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
