import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,
  readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {deflateSync} from "node:zlib";
import {observeStoredPair,compareScenePairToWitness,SCHEMA}
  from "./real_pair_witness_v1.mjs";
const id="12345678-1234-4123-8123-123456789abc";
const sha=x=>createHash("sha256").update(x).digest("hex");
const crc=b=>{let n=-1;for(const x of b){n^=x;for(let j=0;j<8;j++)n=(n>>>1)^(0xedb88320&-(n&1));}return(n^(-1))>>>0;};
function chunk(name,data){
 const x=Buffer.from(data),h=Buffer.alloc(8),t=Buffer.alloc(4);
 h.writeUInt32BE(x.length,0);h.write(name,4);
 t.writeUInt32BE(crc(Buffer.concat([h.subarray(4),x])),0);
 return Buffer.concat([h,x,t]);
}
function png(seed){
 const raw=Buffer.alloc(180*(1+320*4));
 for(let y=0;y<180;y++){
   raw[y*(1+320*4)]=0;
   for(let x=0;x<320;x++){
     const i=y*(1+320*4)+1+x*4;
     raw[i]=(x+seed)%256;raw[i+1]=(y+seed)%256;
     raw[i+2]=(x^y^seed)%256;raw[i+3]=255;
   }
 }
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
   chunk("IHDR",Buffer.from([0,0,1,64,0,0,0,180,8,6,0,0,0])),
   chunk("IDAT",deflateSync(raw)),chunk("IEND",[])]);
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),"sam-frame-witness-"));
 mkdirSync(join(root,"runs"));
 const run=join(root,"runs",id);mkdirSync(run);
 const sam=png(4),jevbot=png(9);
 writeFileSync(join(run,"sam.png"),sam);writeFileSync(join(run,"jevbot.png"),jevbot);
 const frame={schema:1,runId:id,sequence:22,
   capturedAt:"2026-10-30T20:34:01.123Z",
   hashes:{sam:sha(sam),jevbot:sha(jevbot)}};
 const m=join(run,"frame-sync.json");
 writeFileSync(m,JSON.stringify(frame)+"\n");
 symlinkSync("runs/"+id,join(root,"current"));
 return {root,run,m,frame,sam,jevbot};
}
function cleanup(f){rmSync(f.root,{recursive:true,force:true});}
test("real pair manifest is observed by bytes with no PNG disclosure",()=>{
 const f=fixture();
 try{
  const witness=observeStoredPair(f.root);
  assert.equal(witness.schema,SCHEMA);
  assert.equal(witness.frameId,id+":22");
  assert.equal(witness.hashes.sam,f.frame.hashes.sam);
  assert.equal(witness.images.sam.width,320);
  assert.equal(witness.images.sam.height,180);
  assert.equal(witness.evidence,"stored-png-hashes-only");
  assert.equal(witness.sceneEpochAttested,false);
  assert.equal(witness.productionSceneEligible,false);
  assert.equal(JSON.stringify(witness).includes("IHDR"),false);
  assert.equal(JSON.stringify(witness).includes(f.sam.toString("base64")),false);
 }finally{cleanup(f);}
});
test("valid run sequence can match scene metadata without upgrading provenance",()=>{
 const f=fixture();
 try{
  const w=observeStoredPair(f.root);
  const sam={seat:"sam",runId:id,sequence:22,frameId:id+":22"};
  const jevbot={...sam,seat:"jevbot"};
  const result=compareScenePairToWitness(w,sam,jevbot);
  assert.equal(result.matched,true);
  assert.equal(result.productionSceneEligible,false);
  assert.equal(compareScenePairToWitness(w,sam,{...jevbot,sequence:23}).matched,false);
  assert.equal(compareScenePairToWitness(w,{...sam,seat:"jevbot"},jevbot).matched,false);
 }finally{cleanup(f);}
});
test("modified PNG or stale manifest is rejected",()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.run,"sam.png"),Buffer.concat([f.sam,Buffer.from([123])]));
  assert.throws(()=>observeStoredPair(f.root),/PNG pair changed/);
  writeFileSync(join(f.run,"sam.png"),f.sam);
  f.frame.sequence=0;
  writeFileSync(f.m,JSON.stringify(f.frame));
  assert.throws(()=>observeStoredPair(f.root),/Invalid authoritative/);
 }finally{cleanup(f);}
});
test("cross-run or unsafe source pointer cannot escape runs root",()=>{
 const f=fixture();
 try{
  assert.throws(()=>observeStoredPair(f.root,"../elsewhere"),/Unsafe run selector/);
  assert.throws(()=>observeStoredPair(f.root,"featured"));
  rmSync(join(f.root,"current"));
  symlinkSync("../",join(f.root,"current"));
  assert.throws(()=>observeStoredPair(f.root));
 }finally{cleanup(f);}
});
test("symlinked images are rejected regardless of digest",()=>{
 const f=fixture();
 try{
  const p=join(f.run,"sam.png");
  rmSync(p);
  symlinkSync("jevbot.png",p);
  assert.throws(()=>observeStoredPair(f.root),/Unsafe evidence file/);
 }finally{cleanup(f);}
});
test("manifest extra secret fields and invalid timestamps fail closed",()=>{
 const f=fixture();
 try{
  f.frame.secret="private";
  writeFileSync(f.m,JSON.stringify(f.frame));
  assert.throws(()=>observeStoredPair(f.root),/Invalid authoritative/);
  delete f.frame.secret;
  f.frame.capturedAt="yesterday";
  writeFileSync(f.m,JSON.stringify(f.frame));
  assert.throws(()=>observeStoredPair(f.root),/Invalid authoritative/);
 }finally{cleanup(f);}
});
test("uncommitted second-seat frame is refused",()=>{
 const f=fixture();
 try{
  rmSync(join(f.run,"jevbot.png"));
  assert.throws(()=>observeStoredPair(f.root));
 }finally{cleanup(f);}
});
