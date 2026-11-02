import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {encodeAgnosticXorDelta} from "./agnostic_xor_byte_delta_v1.mjs";
import {TrustedPairedByteDeltaReceiver,CHAINED_BYTE_FRAME_SCHEMA}
 from "./trusted_paired_delta_chain_v1.mjs";
const run="12345678-1234-4123-8123-123456789abc";
const other="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const third="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const keys=generateKeyPairSync("ed25519");
const pinned=new Uint8Array(keys.publicKey.export({format:"der",type:"spki"}));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const frame=(seq,seat,len=1024)=>{
 const b=new Uint8Array(len);
 b.fill(seat==="sam"?10:24);
 if(len)b[(seq*(seat==="sam"?7:11))%len]^=(seq%199)+1;
 return b;
};
async function seat({runId=run,seq,seat,previous=null,next=frame(seq,seat),
 kind=previous===null?"keyframe":"delta",signatureKey=keys.privateKey}){
 const base=previous??new Uint8Array();
 const delta=await encodeAgnosticXorDelta({before:base,after:next});
 const statement={
  schema:CHAINED_BYTE_FRAME_SCHEMA,scope:"private-staging-only",
  runId,seat,sequence:seq,frameId:runId+":"+seq,kind,
  baseSha256:sha(base),targetSha256:sha(next),byteLength:next.length
 };
 const signature=sign(null,Buffer.from(JSON.stringify(statement)),
  signatureKey).toString("base64url");
 return {statement,signature,delta};
}
async function pair({runId=run,seq,previous=null,len=1024}){
 return {
  sam:await seat({runId,seq,seat:"sam",
   previous:previous?previous.sam:null,next:frame(seq,"sam",len)}),
  jevbot:await seat({runId,seq,seat:"jevbot",
   previous:previous?previous.jevbot:null,next:frame(seq,"jevbot",len)})
 };
}
const rec=()=>new TrustedPairedByteDeltaReceiver({trustedRunId:run,
 pinnedSpki:pinned});
function commit(rx,admitted){
 return rx.commit({frameId:admitted.frameId,sequence:admitted.sequence,
  admissionId:admitted.admissionId});
}
test("keyframe + two deltas chain exactly and only after external atomic commits",async()=>{
 const rx=rec();
 const initial=await rx.stage(await pair({seq:1}));
 assert.equal(initial.sequence,1);
 assert.equal(initial.seats.sam.pixels.length,1024);
 assert.deepEqual(initial.seats.sam.pixels,frame(1,"sam"));
 assert.equal(rx.status.committedSequence,null);
 assert.equal(rx.status.pendingFrameId,run+":1");
 const old=commit(rx,initial);
 assert.equal(old.committedSequence,1);
 assert.equal(old.pendingFrameId,null);
 const second=await rx.stage(await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}}));
 assert.deepEqual(second.seats.jevbot.pixels,frame(2,"jevbot"));
 assert.equal(rx.status.committedSequence,1);
 assert.throws(()=>rx.commit({frameId:second.frameId,
  sequence:second.sequence,admissionId:99}),/matching/);
 commit(rx,second);
 const thirdFrame=await rx.stage(await pair({seq:3,
  previous:{sam:frame(2,"sam"),jevbot:frame(2,"jevbot")}}));
 assert.deepEqual(thirdFrame.seats.sam.pixels,frame(3,"sam"));
 commit(rx,thirdFrame);
 assert.equal(rx.status.committedSequence,3);
});
test("discarded candidate never advances trusted baseline",async()=>{
 const rx=rec();
 const first=await rx.stage(await pair({seq:1}));
 rx.discard();
 assert.equal(rx.status.committedSequence,null);
 await assert.rejects(rx.stage(await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}})),/keyframe|identity/);
 const retry=await rx.stage(await pair({seq:1}));
 commit(rx,retry);
 assert.equal(rx.status.committedSequence,1);
 const delta=await rx.stage(await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}}));
 rx.discard();
 assert.equal(rx.status.committedSequence,1);
 const retryDelta=await rx.stage(await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}}));
 assert.deepEqual(retryDelta.seats.sam.pixels,frame(2,"sam"));
 assert.ok(retryDelta.admissionId>delta.admissionId);
 commit(rx,retryDelta);
});
test("replayed/gapped/cross-run and crossed-seat signed identity all fail",async()=>{
 const rx=rec();
 const first=await rx.stage(await pair({seq:1}));commit(rx,first);
 await assert.rejects(rx.stage(await pair({seq:1})),/identity|baseline/);
 await assert.rejects(rx.stage(await pair({seq:3,
  previous:{sam:frame(2,"sam"),jevbot:frame(2,"jevbot")}})),/identity/);
 await assert.rejects(rx.stage(await pair({runId:other,seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}})),/identity/);
 const candidate=await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}});
 candidate.jevbot=candidate.sam;
 await assert.rejects(rx.stage(candidate),/identity/);
 assert.equal(rx.status.committedSequence,1);
 assert.equal(rx.status.pendingFrameId,null);
});
test("untrusted signer and altered statement or XOR bytes fail without state changes",async()=>{
 const rx=rec();
 const item=await pair({seq:1});
 item.sam.signature="A".repeat(86);
 await assert.rejects(rx.stage(item),/Untrusted signed|signature/);
 const second=await pair({seq:1});
 second.jevbot.statement.targetSha256="0".repeat(64);
 await assert.rejects(rx.stage(second),/Untrusted signed/);
 const thirdPacket=await pair({seq:1});
 thirdPacket.sam.delta={...thirdPacket.sam.delta,
  payload:new Uint8Array(thirdPacket.sam.delta.payload)};
 thirdPacket.sam.delta.payload[10]^=1;
 await assert.rejects(rx.stage(thirdPacket),/SHA-256 mismatch|XOR payload/);
 assert.equal(rx.status.committedSequence,null);
 assert.equal(rx.status.pendingFrameId,null);
});
test("no commitment when only one seat verifies",async()=>{
 const rx=rec(),item=await pair({seq:1});
 item.jevbot.signature="A".repeat(86);
 await assert.rejects(rx.stage(item),/Untrusted signed|signature/);
 assert.equal(rx.status.pendingFrameId,null);
 const success=await rx.stage(await pair({seq:1}));
 assert.equal(rx.status.committedSequence,null);
 commit(rx,success);
});
test("arbitrary byte data and dense full fallback are supported in a signed delta",async()=>{
 const rx=rec();
 const a=await rx.stage(await pair({seq:1,len:128}));commit(rx,a);
 const previous={sam:frame(1,"sam",128),jevbot:frame(1,"jevbot",128)};
 const nextSam=new Uint8Array(128).fill(3);
 const nextJevbot=new Uint8Array(128).fill(19);
 const first=await seat({seq:2,seat:"sam",previous:previous.sam,
  next:nextSam});
 const second=await seat({seq:2,seat:"jevbot",previous:previous.jevbot,
  next:nextJevbot});
 assert.equal(first.delta.mode,"full");
 assert.equal(second.delta.mode,"full");
 const current=await rx.stage({sam:first,jevbot:second});
 assert.deepEqual(current.seats.sam.pixels,nextSam);
 commit(rx,current);
});
test("mutating original payload after staging cannot alter committed or next baseline",async()=>{
 const rx=rec(),first=await pair({seq:1});
 const p=await rx.stage(first);
 first.sam.statement.targetSha256="0".repeat(64);
 first.sam.delta.payload.fill(2);
 p.seats.sam.pixels.fill(0);
 commit(rx,p);
 const next=await rx.stage(await pair({seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}}));
 assert.deepEqual(next.seats.sam.pixels,frame(2,"sam"));
 commit(rx,next);
});
test("pending frame blocks a second stage and recovery until explicit discard",async()=>{
 const rx=rec();const p=await rx.stage(await pair({seq:1}));
 await assert.rejects(rx.stage(await pair({seq:1})),/pending/);
 assert.throws(()=>rx.beginNewRun(other),/pending/);
 rx.discard();assert.equal(rx.status.pendingFrameId,null);
 assert.equal(rx.status.committedSequence,null);
 const reset=rx.beginNewRun(other);
 assert.equal(reset.runId,other);
});
test("recovery requires distinct trusted run ID and new signed keyframe",async()=>{
 const rx=rec(),first=await rx.stage(await pair({seq:1}));
 commit(rx,first);
 rx.beginNewRun(other);
 assert.equal(rx.status.committedSequence,null);
 await assert.rejects(rx.stage(await pair({runId:run,seq:1})),/identity/);
 await assert.rejects(rx.stage(await pair({runId:other,seq:2,
  previous:{sam:frame(1,"sam"),jevbot:frame(1,"jevbot")}})),/identity|keyframe/);
 const fresh=await rx.stage(await pair({runId:other,seq:1}));commit(rx,fresh);
 assert.equal(rx.status.committedFrameId,other+":1");
 assert.throws(()=>rx.beginNewRun(run),/fresh/);
 rx.beginNewRun(third);
 assert.throws(()=>rx.beginNewRun(other),/fresh/);
});
test("pinned trusted key and signature semantics are not controlled by packet",async()=>{
 assert.throws(()=>new TrustedPairedByteDeltaReceiver({
  trustedRunId:run,pinnedSpki:new Uint8Array(44)}),/Ed25519/);
 assert.throws(()=>new TrustedPairedByteDeltaReceiver({
  trustedRunId:"invalid",pinnedSpki:pinned}),/runId/);
 const rx=rec();
 const wrong=generateKeyPairSync("ed25519");
 const tampered=await pair({seq:1});
 tampered.sam.signature=sign(null,
  Buffer.from(JSON.stringify(tampered.sam.statement)),
  wrong.privateKey).toString("base64url");
 await assert.rejects(rx.stage(tampered),/Untrusted/);
});
