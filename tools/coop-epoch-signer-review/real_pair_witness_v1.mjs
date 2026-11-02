// Read-only witness of a real SAM/JevBot paired PNG commit.
// A SHA-verified pair is not a scene capture. No exporter, signer or publisher.
import {openSync,readFileSync,closeSync,fstatSync,lstatSync,realpathSync} from "node:fs";
import {resolve,join,dirname,sep,basename} from "node:path";
import {createHash} from "node:crypto";

export const SCHEMA="sam.coop.frame-witness.v1";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const keys=(x,k)=>x&&typeof x==="object"&&!Array.isArray(x)&&
  Object.keys(x).length===k.length&&k.every(v=>Object.hasOwn(x,v));
const sha=b=>createHash("sha256").update(b).digest("hex");
const legalDims=new Set(["320x180","640x360"]);
function fileSnapshot(file,max){
  const stat=lstatSync(file,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1n||
     stat.size>BigInt(max))throw Error("Unsafe evidence file");
  const fd=openSync(file,"r");
  try{
    const before=fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.ino!==stat.ino||
       before.dev!==stat.dev||before.size!==stat.size)
      throw Error("Evidence race before read");
    const data=readFileSync(fd);
    const after=fstatSync(fd,{bigint:true});
    if(data.length!==Number(before.size)||
       before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||
       before.size!==after.size||before.ino!==after.ino)
      throw Error("Evidence changed during read");
    return {data,
      fingerprint:[after.dev.toString(),after.ino.toString(),
        after.size.toString(),after.mtimeNs.toString(),after.ctimeNs.toString()]};
  }finally{closeSync(fd);}
}
function pngMeta(data){
  if(data.length<57||data.length>500000||
     !Buffer.from([137,80,78,71,13,10,26,10]).equals(data.subarray(0,8))||
     data.readUInt32BE(8)!==13||data.toString("ascii",12,16)!=="IHDR")
    throw Error("Unexpected PNG header");
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if(!legalDims.has(width+"x"+height))throw Error("Unexpected PNG size");
  return {width,height};
}
function checkManifest(obj,runId){
 if(!keys(obj,["schema","runId","sequence","capturedAt","hashes"])||
    obj.schema!==1||obj.runId!==runId||
    !Number.isSafeInteger(obj.sequence)||obj.sequence<1||
    obj.sequence>100000000||
    typeof obj.capturedAt!=="string"||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(obj.capturedAt)||
    !Number.isFinite(Date.parse(obj.capturedAt))||
    !keys(obj.hashes,["sam","jevbot"])||
    !digest.test(obj.hashes.sam)||!digest.test(obj.hashes.jevbot))
   throw Error("Invalid authoritative frame-sync");
}
function permittedRun(root,selector){
 if(typeof selector!=="string"||
    !(selector==="current"||selector==="featured"||uuid.test(selector)))
    throw Error("Unsafe run selector");
 const runs=resolve(root,"runs"),runsReal=realpathSync(runs);
 if(runsReal!==runs||lstatSync(runs).isSymbolicLink())
   throw Error("Unexpected runs root");
 const pointer=selector==="current"||selector==="featured"
    ?join(root,selector):join(runs,selector);
 if(selector==="current"||selector==="featured"){
   if(!lstatSync(pointer).isSymbolicLink())throw Error("Invalid run pointer");
 }
 const run=realpathSync(pointer);
 if(dirname(run)!==runsReal||!uuid.test(basename(run))||
    lstatSync(run).isSymbolicLink()||!lstatSync(run).isDirectory())
   throw Error("Run outside authorized directory");
 return {run,pointer,selector};
}
export function observeStoredPair(root,selector="current"){
 const base=realpathSync(resolve(root));
 if(lstatSync(base).isSymbolicLink())throw Error("Invalid run base");
 const p=permittedRun(base,selector);
 const get=()=>{
   const manifest=fileSnapshot(join(p.run,"frame-sync.json"),4096);
   let obj;
   try{obj=JSON.parse(manifest.data.toString("utf8"));}
   catch{throw Error("Invalid frame-sync JSON");}
   checkManifest(obj,basename(p.run));
   const results={};
   for(const seat of ["sam","jevbot"]){
     const snap=fileSnapshot(join(p.run,seat+".png"),500000);
     if(snap.data.length<1400)throw Error("Undersized captured PNG");
     const checksum=sha(snap.data);
     if(checksum!==obj.hashes[seat])throw Error("PNG pair changed");
     results[seat]={sha256:checksum,bytes:snap.data.length,
        ...pngMeta(snap.data),fingerprint:snap.fingerprint};
   }
   return {manifest,obj,results};
 };
 const first=get(),second=get();
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 if(!first.manifest.data.equals(second.manifest.data)||
    !same(first.manifest.fingerprint,second.manifest.fingerprint)||
    !same(first.results,second.results)||
    (p.selector==="current"||p.selector==="featured")&&
       realpathSync(p.pointer)!==p.run)
   throw Error("Frame files changed during observation");
 const o=second.obj;
 const source={
   schema:SCHEMA,runId:o.runId,sequence:o.sequence,
   frameId:o.runId+":"+o.sequence,capturedAt:o.capturedAt,
   manifestSha256:sha(second.manifest.data),
   hashes:{sam:o.hashes.sam,jevbot:o.hashes.jevbot},
   images:{
    sam:{sha256:o.hashes.sam,bytes:second.results.sam.bytes,
      width:second.results.sam.width,height:second.results.sam.height},
    jevbot:{sha256:o.hashes.jevbot,bytes:second.results.jevbot.bytes,
      width:second.results.jevbot.width,height:second.results.jevbot.height}
   },
   evidence:"stored-png-hashes-only",
   sceneEpochAttested:false,
   productionSceneEligible:false
 };
 return Object.freeze(source);
}
// Diagnostic match only. No observer-created nonce or signed scene emission.
export function compareScenePairToWitness(witness,sam,jevbot){
 if(!witness||witness.schema!==SCHEMA||
   !sam||!jevbot||!keys(witness.hashes,["sam","jevbot"]))
   return {matched:false,reason:"missing-witness"};
 if(sam.runId!==witness.runId||jevbot.runId!==witness.runId||
    sam.sequence!==witness.sequence||jevbot.sequence!==witness.sequence||
    sam.frameId!==witness.frameId||jevbot.frameId!==witness.frameId||
    sam.seat!=="sam"||jevbot.seat!=="jevbot")
   return {matched:false,reason:"frame-identity-mismatch"};
 return {matched:true,reason:"png-pair-verified-only",
   productionSceneEligible:false};
}
