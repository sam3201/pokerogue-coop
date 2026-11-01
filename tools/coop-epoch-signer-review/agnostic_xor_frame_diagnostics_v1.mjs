// Optional, private XOR diagnostics for already-verified synthetic frame bytes.
// Format-agnostic byte views (Buffer, Uint8Array, DataView, ArrayBuffer, etc.)
// and arbitrary 1..4 pixel channels / row strides. A complete XOR scan detects
// byte differences exactly; XOR reductions or sparse samples do NOT authenticate
// game state. Never use this diagnostic instead of signatures and SHA-256.
export const XOR_SCHEMA="sam.coop.agnostic-xor-frame-diagnostic.v1";
const MAX_FRAME_BYTES=4*1024*1024;
const TILE_SIZES=new Set([8,16,32,64]);
const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const POPCNT=Uint8Array.from({length:256},(_,value)=>{
 let bits=0;
 while(value){bits+=value&1;value>>>=1;}
 return bits;
});
const positive=(x,max)=>Number.isSafeInteger(x)&&x>=1&&x<=max;

function bytesOf(input){
 if(input instanceof ArrayBuffer)return new Uint8Array(input);
 if(ArrayBuffer.isView(input)&&input.buffer instanceof ArrayBuffer)
  return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
 // SharedArrayBuffer is intentionally rejected: an untrusted shared writer
 // could change pixels while the scan is in progress, making it racy.
 throw Error("Expected non-shared byte buffer");
}
function frameDescriptor(value){
 if(!value||typeof value!=="object"||Array.isArray(value))
  throw Error("Invalid XOR frame descriptor");
 const {data,width,height,channels=4}=value;
 if(!positive(width,4096)||!positive(height,4096)||
    !positive(channels,4)||width*height>4*1024*1024)
  throw Error("Invalid XOR frame geometry");
 const required=width*channels;
 const strideBytes=value.strideBytes??required;
 if(!Number.isSafeInteger(strideBytes)||strideBytes<required||
    strideBytes>required+4096||strideBytes*height>MAX_FRAME_BYTES)
  throw Error("Invalid XOR frame row stride");
 const bytes=bytesOf(data);
 if(bytes.length!==strideBytes*height)
  throw Error("XOR frame buffer length mismatch");
 return {bytes,width,height,channels,strideBytes};
}
function cloneFrame(original){
 const d=frameDescriptor(original);
 return {data:new Uint8Array(d.bytes),width:d.width,height:d.height,
  channels:d.channels,strideBytes:d.strideBytes};
}

export function scanAgnosticXorFrame({before,after,tileSize=16}={}){
 if(!TILE_SIZES.has(tileSize))throw Error("Unsupported XOR tile size");
 const a=frameDescriptor(before),b=frameDescriptor(after);
 if(a.width!==b.width||a.height!==b.height||a.channels!==b.channels)
  throw Error("Incompatible XOR pixel layouts");
 const {width,height,channels}=a;
 const tileColumns=Math.ceil(width/tileSize);
 const tileRows=Math.ceil(height/tileSize);
 const dirtyTileMask=new Uint8Array(tileColumns*tileRows);
 let changedPixels=0,changedChannelBytes=0,flippedBits=0;
 let firstChangedPixel=null;
 // An aligned packed RGBA buffer permits one XOR per whole pixel. This is
 // independent of host byte order: counts and zero/nonzero byte detection
 // are symmetric under every permutation of the four byte lanes.
 const packedRgba=channels===4&&
   a.strideBytes===width*4&&b.strideBytes===width*4&&
   a.bytes.byteOffset%4===0&&b.bytes.byteOffset%4===0;
 const wa=packedRgba?new Uint32Array(a.bytes.buffer,
   a.bytes.byteOffset,width*height):null;
 const wb=packedRgba?new Uint32Array(b.bytes.buffer,
   b.bytes.byteOffset,width*height):null;
 if(packedRgba){
  for(let y=0;y<height;y++){
   const row=y*width,tileRow=(y/tileSize)|0;
   for(let x=0;x<width;x++){
    const xor=(wa[row+x]^wb[row+x])>>>0;
    if(xor===0)continue;
    changedPixels++;
    if(firstChangedPixel===null)firstChangedPixel={x,y};
    const b0=xor&255,b1=(xor>>>8)&255,
      b2=(xor>>>16)&255,b3=(xor>>>24)&255;
    changedChannelBytes+=(b0!==0)+(b1!==0)+(b2!==0)+(b3!==0);
    flippedBits+=POPCNT[b0]+POPCNT[b1]+POPCNT[b2]+POPCNT[b3];
    dirtyTileMask[tileRow*tileColumns+((x/tileSize)|0)]=1;
   }
  }
 }else{
  // General route supports packed RGB, greyscale, byte-offset views and
  // padded rows without interpreting data as a particular host format.
  for(let y=0;y<height;y++){
   const ra=y*a.strideBytes,rb=y*b.strideBytes;
   const tileRow=(y/tileSize)|0;
   for(let x=0;x<width;x++){
    let changed=false;
    for(let channel=0;channel<channels;channel++){
     const xor=a.bytes[ra+x*channels+channel]^
       b.bytes[rb+x*channels+channel];
     if(xor){
      changed=true;
      changedChannelBytes++;
      flippedBits+=POPCNT[xor];
     }
    }
    if(changed){
     changedPixels++;
     if(firstChangedPixel===null)firstChangedPixel={x,y};
     dirtyTileMask[tileRow*tileColumns+((x/tileSize)|0)]=1;
    }
   }
  }
 }
 let dirtyTileCount=0;
 for(const marked of dirtyTileMask)dirtyTileCount+=marked;
 return {
  schema:XOR_SCHEMA,scope:"private-diagnostic-only",
  width,height,channels,tileSize,tileColumns,tileRows,
  scanMode:packedRgba?"packed-rgba-word32":"bytewise-fallback",
  pixelsScanned:width*height,bytesCompared:width*height*channels,
  identicalPixels:changedPixels===0,
  changedPixels,changedChannelBytes,flippedBits,
  firstChangedPixel,dirtyTileCount,dirtyTileMask,
  issuerAuthenticated:false,productionSceneEligible:false
 };
}

function privateSummary(diff){
 return Object.freeze({
  changedPixels:diff.changedPixels,
  changedChannelBytes:diff.changedChannelBytes,
  flippedBits:diff.flippedBits,dirtyTileCount:diff.dirtyTileCount,
  identicalPixels:diff.identicalPixels
 });
}

// Two-phase diagnostic state: verification and canvas rendering must already
// have passed; only a successful paired viewer commit advances our baseline.
export class PrivateAgnosticXorPairTracker{
 #previous=null;#pending=null;#lastAdmission=0;
 constructor({tileSize=16}={}){
  if(!TILE_SIZES.has(tileSize))throw Error("Unsupported XOR tile size");
  this.tileSize=tileSize;
 }
 get status(){
  return Object.freeze({
   committedFrameId:this.#previous?.frameId??null,
   committedSequence:this.#previous?.sequence??null,
   pendingFrameId:this.#pending?.frameId??null,
   lastAdmission:this.#lastAdmission,
   productionSceneEligible:false
  });
 }
 stage({runId,frameId,sequence,admissionId,images}={}){
  if(this.#pending)throw Error("XOR diagnostic admission already pending");
  if(!RUN.test(runId||"")||!positive(sequence,100000000)||
     frameId!==runId+":"+sequence||
     !positive(admissionId,Number.MAX_SAFE_INTEGER)||
     admissionId<=this.#lastAdmission||
     !images||!images.sam||!images.jevbot)
   throw Error("Invalid XOR diagnostic admission");
  const current={runId,frameId,sequence,admissionId,
   images:{sam:cloneFrame(images.sam),jevbot:cloneFrame(images.jevbot)}};
  const a=frameDescriptor(current.images.sam),
    b=frameDescriptor(current.images.jevbot);
  if(a.width!==b.width||a.height!==b.height||a.channels!==b.channels)
   throw Error("Incompatible seat image layouts");
  const prev=this.#previous;
  if(prev&&(prev.runId!==runId||sequence!==prev.sequence+1))
   throw Error("XOR diagnostic sequence or run mismatch");
  let delta=null;
  if(prev){
   const sam=scanAgnosticXorFrame({before:prev.images.sam,
    after:current.images.sam,tileSize:this.tileSize});
   const jevbot=scanAgnosticXorFrame({before:prev.images.jevbot,
    after:current.images.jevbot,tileSize:this.tileSize});
   let bothDirtyTiles=0,samOnlyDirtyTiles=0,jevbotOnlyDirtyTiles=0;
   for(let i=0;i<sam.dirtyTileMask.length;i++){
    if(sam.dirtyTileMask[i]&&jevbot.dirtyTileMask[i])bothDirtyTiles++;
    else if(sam.dirtyTileMask[i])samOnlyDirtyTiles++;
    else if(jevbot.dirtyTileMask[i])jevbotOnlyDirtyTiles++;
   }
   delta=Object.freeze({sam:privateSummary(sam),
    jevbot:privateSummary(jevbot),bothDirtyTiles,samOnlyDirtyTiles,
    jevbotOnlyDirtyTiles});
  }
  const report=Object.freeze({
   schema:XOR_SCHEMA,scope:"private-diagnostic-only",runId,frameId,
   sequence,admissionId,baselineAvailable:prev!==null,
   xor:delta,issuerAuthenticated:false,sceneEpochAttested:false,
   productionSceneEligible:false
  });
  this.#pending={...current,report};
  return report;
 }
 commit({frameId,admissionId}={}){
  if(!this.#pending||frameId!==this.#pending.frameId||
     admissionId!==this.#pending.admissionId)
   throw Error("Stale or missing XOR diagnostic commit");
  const accepted=this.#pending;
  this.#pending=null;
  this.#previous=accepted;
  this.#lastAdmission=accepted.admissionId;
  return accepted.report;
 }
 discard(){this.#pending=null;return this.status;}
 reset(){
  this.#previous=null;this.#pending=null;
  // Keep the admission high-watermark to reject stale IDs after reset.
  return this.status;
 }
}
