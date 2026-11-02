// Private texture registry and integrity boundary. This module DOES NOT publish,
// grant redistribution rights or export live Phaser blob/canvas textures.
import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";
export const SCHEMA="sam.coop.textures.approved.v1";
const sig=Buffer.from([137,80,78,71,13,10,26,10]);
const hex=/^[0-9a-f]{64}$/;
const MAX_BYTES=4*1024*1024;
const MAX_PIXELS=4*1024*1024;
const MAX_ASSETS=64;
const exactKeys=(obj,keys)=>!!obj&&typeof obj==="object"&&
  !Array.isArray(obj)&&Object.keys(obj).length===keys.length&&
  keys.every(key=>Object.hasOwn(obj,key));
export const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
function crc32(bytes){
 let x=-1;
 for(const b of bytes){
  x^=b;
  for(let j=0;j<8;j++)x=(x>>>1)^(0xedb88320&-(x&1));
 }
 return (x^(-1))>>>0;
}
export function inspectPng(input){
 const b=Buffer.from(input);
 if(b.length<57||b.length>MAX_BYTES||!b.subarray(0,8).equals(sig))
   throw Error("PNG signature/byte budget");
 let at=8,width=null,height=null,idats=[],ended=false,seenIdat=false;
 while(at<b.length){
  if(at+12>b.length)throw Error("PNG chunk truncated");
  const len=b.readUInt32BE(at);
  if(len>b.length-at-12)throw Error("PNG chunk out of bounds");
  const type=b.toString("ascii",at+4,at+8);
  const content=b.subarray(at+8,at+8+len);
  const sum=b.readUInt32BE(at+8+len);
  if(crc32(b.subarray(at+4,at+8+len))!==sum)
   throw Error("PNG CRC mismatch");
  if(width===null&&type!=="IHDR")throw Error("PNG missing IHDR");
  if(type==="IHDR"){
   if(width!==null||len!==13)throw Error("PNG repeated IHDR");
   width=content.readUInt32BE(0);height=content.readUInt32BE(4);
   if(width<1||height<1||width>4096||height>4096||
      width*height>MAX_PIXELS||content[8]!==8||content[9]!==6||
      content[10]!==0||content[11]!==0||content[12]!==0)
      throw Error("Unsupported PNG geometry/format");
  }else if(type==="IDAT"){
   if(ended)throw Error("PNG data after IEND");
   seenIdat=true;idats.push(content);
  }else if(type==="IEND"){
   if(len!==0||!seenIdat||at+12!==b.length)throw Error("Invalid PNG end");
   ended=true;
  }else throw Error("PNG metadata or unsupported chunk prohibited: "+type);
  at+=len+12;
 }
 if(!ended)throw Error("PNG missing IEND");
 const stride=1+width*4,maxOutputLength=stride*height;
 let raw;
 try{raw=inflateSync(Buffer.concat(idats),{maxOutputLength});}
 catch{throw Error("Invalid or excessive PNG deflate payload");}
 if(raw.length!==maxOutputLength)throw Error("PNG pixel data length");
 for(let y=0;y<height;y++)
  if(raw[y*stride]>4)throw Error("Unsupported PNG scanline filter");
 return {width,height,bytes:b.length,sha256:sha256(b)};
}
function assertApproval(source,approval,digest){
 if(!source||source.kind!=="static-file"||
   typeof source.path!=="string"||
   !/^assets\/images\/[A-Za-z0-9_./-]+\.png$/.test(source.path)||
   source.path.split("/").includes("..")||
   !approval||approval.licenseId!=="CC0-1.0"||
   approval.redistributionGranted!==true||
   !/^review:[a-zA-Z0-9_-]{4,50}$/.test(approval.reviewId||"")||
   approval.expectedSha256!==digest)
  throw Error("Unapproved/static-asset provenance or license");
}
export function buildRegistry(records){
 if(!Array.isArray(records)||records.length<1||records.length>MAX_ASSETS)
  throw Error("Texture asset count");
 const files=new Map(),out=[];
 for(const row of records){
  const b=Buffer.from(row?.bytes||[]);
  const meta=inspectPng(b);
  assertApproval(row.source,row.approval,meta.sha256);
  if(files.has(meta.sha256))throw Error("Duplicate texture bytes");
  const id="sha256:"+meta.sha256;
  const href="/images/approved-sha256/"+meta.sha256+".png";
  files.set(meta.sha256,b);
  out.push({id,href,sha256:meta.sha256,bytes:meta.bytes,
    width:meta.width,height:meta.height,
    licenseId:row.approval.licenseId,reviewId:row.approval.reviewId});
 }
 out.sort((a,b)=>a.sha256.localeCompare(b.sha256));
 const base={schema:SCHEMA,scope:"private-staging-only",textures:out};
 const manifest={...base,digest:sha256(Buffer.from(JSON.stringify(base)))};
 return {manifest,files};
}
export function validateRegistry(manifest){
 if(!exactKeys(manifest,["schema","scope","textures","digest"])||
    manifest.schema!==SCHEMA||
    manifest.scope!=="private-staging-only"||
    !Array.isArray(manifest.textures)||
    manifest.textures.length<1||manifest.textures.length>MAX_ASSETS||
    !hex.test(manifest.digest||""))return false;
 const names=new Set();
 for(const x of manifest.textures){
  if(!exactKeys(x,["id","href","sha256","bytes","width","height",
      "licenseId","reviewId"])||
    !hex.test(x.sha256||"")||names.has(x.sha256)||
    x.id!=="sha256:"+x.sha256||
    x.href!=="/images/approved-sha256/"+x.sha256+".png"||
    x.licenseId!=="CC0-1.0"||
    !/^review:[a-zA-Z0-9_-]{4,50}$/.test(x.reviewId||"")||
    !Number.isSafeInteger(x.bytes)||x.bytes<57||x.bytes>MAX_BYTES||
    !Number.isSafeInteger(x.width)||!Number.isSafeInteger(x.height)||
    x.width<1||x.height<1||x.width*x.height>MAX_PIXELS)
    return false;
  names.add(x.sha256);
 }
 if(manifest.textures.some((x,i)=>i>0&&
    manifest.textures[i-1].sha256>=x.sha256))return false;
 const base={schema:SCHEMA,scope:"private-staging-only",textures:manifest.textures};
 return sha256(Buffer.from(JSON.stringify(base)))===manifest.digest;
}
export function verifyTexture(manifest,href,bytes){
 if(!validateRegistry(manifest))return false;
 const entry=manifest.textures.find(x=>x.href===href);
 if(!entry)return false;
 try {
  const image=inspectPng(bytes);
  return image.sha256===entry.sha256&&image.bytes===entry.bytes&&
    image.width===entry.width&&image.height===entry.height;
 }catch{return false;}
}
