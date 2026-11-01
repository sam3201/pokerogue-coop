// Browser-compatible verifier for privately approved, content-addressed PNGs.
// No public deployment, no Phaser blob/canvas export, no unverified decode.
const bytesMax=4*1024*1024, pixelMax=4*1024*1024, totalMax=16*1024*1024;
const hex=/^[a-f0-9]{64}$/;
const digestBytes=async(bytes,subtle)=>{
 if(!subtle)throw Error("WebCrypto unavailable");
 return [...new Uint8Array(await subtle.digest("SHA-256",bytes))]
   .map(x=>x.toString(16).padStart(2,"0")).join("");
};
const isObj=o=>o!==null&&typeof o==="object"&&!Array.isArray(o);
const shape=(o,keys)=>isObj(o)&&Object.keys(o).length===keys.length&&
  keys.every(k=>Object.hasOwn(o,k));
const idRegex=/^review:[A-Za-z0-9_-]{4,50}$/;
const isCount=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function requiredPNGHeader(data,entry){
 const b=new Uint8Array(data),dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(b.length<57||b.length!==entry.bytes||b.length>bytesMax)return false;
 const signature=[137,80,78,71,13,10,26,10];
 if(!signature.every((v,i)=>b[i]===v))return false;
 if(dv.getUint32(8)!==13 || String.fromCharCode(...b.slice(12,16))!=="IHDR")
   return false;
 if(dv.getUint32(16)!==entry.width||dv.getUint32(20)!==entry.height||
    b[24]!==8||b[25]!==6||b[26]!==0||b[27]!==0||b[28]!==0)return false;
 if(String.fromCharCode(...b.slice(-8,-4))!=="IEND")return false;
 return true;
}
export async function validateApprovedManifest(manifest,subtle=globalThis.crypto?.subtle){
 if(!shape(manifest,["schema","scope","textures","digest"])||
    manifest.schema!=="sam.coop.textures.approved.v1"||
    manifest.scope!=="private-staging-only"||
    !Array.isArray(manifest.textures)||!isCount(manifest.textures.length,1,64)||
    !hex.test(manifest.digest||""))return false;
 let prior="";
 for(const e of manifest.textures){
  if(!shape(e,["id","href","sha256","bytes","width","height",
    "licenseId","reviewId"])||!hex.test(e.sha256||"")||
     (prior&&e.sha256<=prior)||
     e.id!=="sha256:"+e.sha256||
     e.href!=="/images/approved-sha256/"+e.sha256+".png"||
     e.licenseId!=="CC0-1.0"||!idRegex.test(e.reviewId||"")||
     !isCount(e.bytes,57,bytesMax)||!isCount(e.width,1,4096)||
     !isCount(e.height,1,4096)||e.width*e.height>pixelMax)return false;
  prior=e.sha256;
 }
 const base={schema:manifest.schema,scope:manifest.scope,textures:manifest.textures};
 return await digestBytes(new TextEncoder().encode(JSON.stringify(base)),subtle)===
   manifest.digest;
}
function responsePath(response,expected){
 if(!response?.ok||response.redirected||!response.body?.getReader||
    !response.headers?.get)return false;
 const type=response.headers.get("content-type");
 if(type?.toLowerCase().trim()!=="image/png")return false;
 const length=response.headers.get("content-length");
 if(length!==null&&(!/^[0-9]+$/.test(length)||
    Number(length)!==expected.bytes))return false;
 if(!response.url)return false;
 try{
  const url=new URL(response.url);
  return url.origin===expected.origin&&url.pathname===expected.path&&
    !url.search&&!url.hash&&url.protocol==="https:";
 }catch{return false;}
}
export async function fetchApprovedTexture(entry,origin,{
  fetcher=globalThis.fetch,subtle=globalThis.crypto?.subtle,
  signal
}={}){
 if(!shape(entry,["id","href","sha256","bytes","width","height",
    "licenseId","reviewId"])||!hex.test(entry.sha256||"")||
    entry.id!=="sha256:"+entry.sha256||
    entry.href!=="/images/approved-sha256/"+entry.sha256+".png"||
    entry.licenseId!=="CC0-1.0"||!idRegex.test(entry.reviewId||"")||
    !isCount(entry.bytes,57,bytesMax)||!isCount(entry.width,1,4096)||
    !isCount(entry.height,1,4096)||entry.width*entry.height>pixelMax)
    throw Error("Unapproved texture entry");
 if(typeof fetcher!=="function")throw Error("No fetch transport");
 const base=new URL(origin);
 if(base.protocol!=="https:"||base.pathname!=="/"||base.search||base.hash)
   throw Error("Invalid HTTPS origin");
 const target=new URL(entry.href,base);
 const response=await fetcher(target.href,{
   method:"GET",credentials:"omit",redirect:"error",cache:"no-store",
   mode:"same-origin",referrerPolicy:"no-referrer",signal,
   headers:{"Accept":"image/png"}
 });
 if(!responsePath(response,{origin:base.origin,path:entry.href,bytes:entry.bytes}))
   throw Error("Untrusted texture response");
 const reader=response.body.getReader(),chunks=[];
 let length=0;
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   if(!(value instanceof Uint8Array))throw Error("Invalid texture stream");
   length+=value.byteLength;
   if(length>entry.bytes||length>bytesMax)throw Error("Texture byte budget");
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 if(length!==entry.bytes)throw Error("Truncated texture response");
 const bytes=new Uint8Array(length);
 let offset=0;
 for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
 if(!requiredPNGHeader(bytes,entry))throw Error("Invalid approved PNG header");
 if(await digestBytes(bytes,subtle)!==entry.sha256)
   throw Error("Texture SHA-256 mismatch");
 return bytes;
}
export async function fetchSceneTextures(manifest,hrefs,origin,opts={}){
 if(!await validateApprovedManifest(manifest,opts.subtle))throw Error("Invalid manifest");
 if(!Array.isArray(hrefs)||hrefs.length<1||hrefs.length>64||
    hrefs.some(h=>typeof h!=="string")||
    new Set(hrefs).size!==hrefs.length)throw Error("Invalid scene texture set");
 const registry=new Map(manifest.textures.map(e=>[e.href,e]));
 let budget=0;
 for(const href of hrefs){
  const e=registry.get(href);
  if(!e)throw Error("Unapproved texture reference");
  budget+=e.bytes;
  if(budget>totalMax)throw Error("Scene texture memory budget");
 }
 const verified=new Map();
 for(const href of hrefs)verified.set(href,
   await fetchApprovedTexture(registry.get(href),origin,opts));
 return verified;
}
