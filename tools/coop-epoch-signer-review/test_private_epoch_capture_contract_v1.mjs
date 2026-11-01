import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {deflateSync} from "node:zlib";
import {preparePrivateEpoch,inspectPrivateEpoch}
  from "./private_epoch_capture_contract_v1.mjs";
const RUN="12345678-1234-4123-8123-123456789abc";
const HEX=x=>createHash("sha256").update(x).digest("hex");
function crc32(bytes){
 let c=-1;for(const b of bytes){
  c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xedb88320&-(c&1));
 }
 return(c^(-1))>>>0;
}
function chunk(name,data){
 const bytes=Buffer.from(data),h=Buffer.alloc(8),tail=Buffer.alloc(4);
 h.writeUInt32BE(bytes.length);h.write(name,4,"ascii");
 tail.writeUInt32BE(crc32(Buffer.concat([h.subarray(4),bytes])),0);
 return Buffer.concat([h,bytes,tail]);
}
function png(seed){
 const width=320,height=180,row=width*4+1,raw=Buffer.alloc(row*height);
 let state=seed;
 for(let y=0;y<height;y++){
  const offset=y*row;
  for(let x=0;x<width;x++){
   const i=offset+1+x*4;
   state^=state<<13;state^=state>>>17;state^=state<<5;
   raw[i]=state&255;raw[i+1]=(state>>>8)&255;
   raw[i+2]=(state>>>16)&255;raw[i+3]=255;
  }
 }
 return Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  chunk("IHDR",Buffer.from([0,0,1,64,0,0,0,180,8,6,0,0,0])),
  chunk("IDAT",deflateSync(raw)),chunk("IEND",[])
 ]);
}
function scene(){
 return {schema:"sam.coop.phaser-sprites.probe.v1",
  visualScope:"partial-original-sprites",labOnly:false,
  camera:{width:1920,height:1080,x:0,y:0,scrollX:0,scrollY:0,zoom:1},
  commands:[{op:"sprite",texture:"/images/lab-fixture.png",
    src:[0,0,32,16],dst:[0,0,32,16],
    matrix:[1,0,0,1,100,100],alpha:1,
    flipX:false,flipY:false,scroll:[1,1]}],
  coverage:{inspected:1,captured:1,skipped:{},
   approximated:{fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0},
   truncated:false,complete:true}};
}
const checkpoint={runId:RUN,relayCommitHash:HEX("commit:900"),
 gameStateHash:HEX("game-state:900")};
function setup(){
 const images={sam:png(17),jevbot:png(23)};
 const captureSeat=async (seat,ctx)=>({
  seat,postrender:true,frameTick:seat==="sam"?900:903,
  relayCommitHash:ctx.relayCommitHash,png:images[seat],scene:scene()
 });
 const readRelayCheckpoint=async()=>({...checkpoint});
 const args={runId:RUN,sequence:900,
   readRelayCheckpoint,captureSeat};
 return {args,images};
}
test("same logical checkpoint yields two-seat diagnostic with exact hashes",async()=>{
 const {args,images}=setup();
 const proof=await preparePrivateEpoch(args);
 assert.equal(proof.frameSync.runId,RUN);
 assert.equal(proof.frameSync.sequence,900);
 assert.equal(proof.frameSync.hashes.sam,HEX(images.sam));
 assert.equal(proof.frameSync.hashes.jevbot,HEX(images.jevbot));
 assert.equal(proof.receipt.relayCommitHash,checkpoint.relayCommitHash);
 assert.deepEqual(proof.receipt.frameTicks,{sam:900,jevbot:903});
 assert.equal(proof.receipt.issuerAuthenticated,false);
 assert.equal(proof.receipt.sceneEpochAttested,false);
 assert.equal(proof.receipt.productionSceneEligible,false);
 assert.equal(inspectPrivateEpoch(proof),true);
 assert.equal(JSON.stringify(proof.receipt).includes("lab-fixture.png"),false);
});
test("relay checkpoint advanced during screenshot pair rejects",async()=>{
 const {args}=setup();
 let reads=0;
 args.readRelayCheckpoint=async()=>({
  ...checkpoint,
  gameStateHash:++reads===1?checkpoint.gameStateHash:HEX("new-state")
 });
 await assert.rejects(preparePrivateEpoch(args),/relay state advanced/);
});
test("both seats must share authoritative relay commit hash",async()=>{
 const {args}=setup(),original=args.captureSeat;
 args.captureSeat=async (seat,ctx)=>{
  const a=await original(seat,ctx);
  if(seat==="jevbot")a.relayCommitHash=HEX("other-commit");
  return a;
 };
 await assert.rejects(preparePrivateEpoch(args),/postrender epoch/);
});
test("missing postrender flag, fake frame tick, or crossed seat fail",async()=>{
 for(const property of ["postrender","frameTick","seat"]){
  const {args}=setup(),original=args.captureSeat;
  args.captureSeat=async (seat,ctx)=>{
   const item=await original(seat,ctx);
   if(seat==="jevbot"){
    item[property]=property==="postrender"?false:
      property==="frameTick"?0:"sam";
   }
   return item;
  };
  await assert.rejects(preparePrivateEpoch(args),/postrender epoch/);
 }
});
test("partial or malformed scene does not become authentic provenance",async()=>{
 const {args}=setup(),original=args.captureSeat;
 args.captureSeat=async (seat,ctx)=>{
  const item=await original(seat,ctx);
  if(seat==="sam")item.scene.commands[0].texture="https://not-allowed.invalid/private";
  return item;
 };
 await assert.rejects(preparePrivateEpoch(args),/scene protocol/);
});
test("no private metadata can be smuggled into diagnostic scene",async()=>{
 const {args}=setup(),original=args.captureSeat;
 args.captureSeat=async(seat,ctx)=>{
  const item=await original(seat,ctx);
  item.scene.roomToken="secret";
  return item;
 };
 await assert.rejects(preparePrivateEpoch(args),/scene protocol/);
});
test("tampering with stored frame or scene invalidates diagnostic",async()=>{
 const {args}=setup(),proof=await preparePrivateEpoch(args);
 proof.frames.sam=Buffer.concat([proof.frames.sam,Buffer.from([17])]);
 assert.equal(inspectPrivateEpoch(proof),false);
 const safe=await preparePrivateEpoch(args);
 safe.scenes.jevbot.commands[0].dst[0]=50;
 assert.equal(inspectPrivateEpoch(safe),false);
});
test("aborted or malformed run identity never captures",async()=>{
 const {args}=setup();let invoked=0;
 const original=args.captureSeat;
 args.captureSeat=async(...params)=>{invoked++;return original(...params);};
 await assert.rejects(preparePrivateEpoch({...args,runId:"../../etc"}));
 await assert.rejects(preparePrivateEpoch({...args,sequence:-1}));
 const ctrl=new AbortController();ctrl.abort();
 await assert.rejects(preparePrivateEpoch({...args,signal:ctrl.signal}));
 assert.equal(invoked,0);
});
test("caller-supplied diagnostic cannot bypass production scene gate",async()=>{
 const {args}=setup(),proof=await preparePrivateEpoch(args);
 assert.equal(inspectPrivateEpoch(proof),true);
 assert.equal(proof.receipt.productionSceneEligible,false);
 // Production has no trusted same-epoch source or attestation signer.
 assert.equal(Object.hasOwn(proof.frameSync,"sceneEpochNonces"),false);
 assert.equal(Object.hasOwn(proof.receipt,"signature"),false);
});

test("one-seat failure waits for other seat to settle before rejecting",async()=>{
 const {args}=setup();
 let resolveSam;
 let samFinished=false;
 args.captureSeat=async seat=>{
  if(seat==="jevbot")throw Error("screenshot failed");
  await new Promise(resolve=>{resolveSam=resolve;});
  samFinished=true;
  return {seat,postrender:true,frameTick:13,relayCommitHash:checkpoint.relayCommitHash,
    png:png(17),scene:scene()};
 };
 const result=preparePrivateEpoch(args);
 // Wait until the capture coordinator has reached both async callbacks.
 await new Promise(resolve=>setTimeout(resolve,10));
 let rejected=false;
 const observed=result.catch(()=>{rejected=true;});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(rejected,false,"must wait for surviving capture");
 assert.equal(samFinished,false);
 resolveSam();
 await observed;
 assert.equal(samFinished,true);
 assert.equal(rejected,true);
});
