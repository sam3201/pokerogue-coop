// Independent browser acceptance gate. Validates both frame packets, the
// texture catalog and Ed25519 pair signature BEFORE fetching approved PNGs.
// This lab module deliberately does NOT authorize production display.
import {validateApprovedManifest,fetchSceneTextures}
  from "./browser_asset_verify_v1.mjs";
const encoder=new TextEncoder();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
  .map(v=>v.toString(16).padStart(2,"0")).join("");
const shaJSON=o=>sha(encoder.encode(JSON.stringify(o)));
const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&
  Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const str64=s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
const uuid=s=>typeof s==="string"&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const num=n=>typeof n==="number"&&Number.isFinite(n)&&Math.abs(n)<100000;
const values=(x,n)=>Array.isArray(x)&&x.length===n&&x.every(num);
function validScene(scene,allow){
 if(!exact(scene,["schema","visualScope","camera","commands"])||
    scene.schema!=="sam.coop.phaser-sprites.probe.v1"||
    scene.visualScope!=="partial-original-sprites"||
    !exact(scene.camera,["width","height","x","y","scrollX","scrollY","zoom"])||
    scene.camera.width!==1920||scene.camera.height!==1080||
    !["x","y","scrollX","scrollY","zoom"].every(k=>num(scene.camera[k]))||
    scene.camera.zoom<=0||scene.camera.zoom>8||
    !Array.isArray(scene.commands)||scene.commands.length<1||
    scene.commands.length>320)return false;
 for(const c of scene.commands){
  const props=["op","texture","src","dst","matrix","alpha",
    "flipX","flipY","scroll"];
  if(c?.op==="nineSlice")props.push("borders");
  if(!exact(c,props)||!allow.has(c.texture)||
     !values(c.src,4)||!values(c.dst,4)||
     !values(c.matrix,6)||!values(c.scroll,2)||
     c.src.some(v=>v<0)||c.src[2]<=0||c.src[3]<=0||
     c.dst[2]<=0||c.dst[3]<=0||
     c.scroll.some(v=>v<0||v>4)||
     !num(c.alpha)||c.alpha<=0||c.alpha>1||
     typeof c.flipX!=="boolean"||typeof c.flipY!=="boolean")return false;
  if(c.op==="nineSlice"&&(!values(c.borders,4)||
    c.borders.some(v=>v<0)||
    c.borders[0]+c.borders[1]>c.src[2]||
    c.borders[2]+c.borders[3]>c.src[3]||
    c.borders[0]+c.borders[1]>c.dst[2]||
    c.borders[2]+c.borders[3]>c.dst[3]))return false;
 }
 return true;
}
async function verifySeat(packet,manifest,seat){
 if(!exact(packet,["schema","scope","runId","seat","sequence",
   "frameId","manifestDigest","scene","digest"])||
   packet.schema!=="sam.coop.scene-assets-bound.v1"||
   packet.scope!=="private-staging-only"||
   !uuid(packet.runId)||packet.seat!==seat||
   !Number.isSafeInteger(packet.sequence)||
   packet.sequence<1||packet.sequence>100000000||
   packet.frameId!==packet.runId+":"+packet.sequence||
   packet.manifestDigest!==manifest.digest||!str64(packet.digest))
   return false;
 const approved=new Set(manifest.textures.map(e=>e.href));
 if(!validScene(packet.scene,approved))return false;
 const base={schema:packet.schema,scope:packet.scope,
  runId:packet.runId,seat:packet.seat,sequence:packet.sequence,
  frameId:packet.frameId,manifestDigest:packet.manifestDigest,
  scene:packet.scene};
 return JSON.stringify(base).length<=110000&&await shaJSON(base)===packet.digest;
}
function basePair(sam,jevbot,manifest){
 return {schema:"sam.coop.scene-pair.v1",scope:"private-staging-only",
  frameId:sam.frameId,sequence:sam.sequence,runId:sam.runId,
  manifestDigest:manifest.digest,
  samDigest:sam.digest,jevbotDigest:jevbot.digest};
}
function signatureBytes(encoded){
 if(typeof encoded!=="string"||
    !/^[A-Za-z0-9_-]{86}$/.test(encoded))return null;
 try{
  const padded=encoded.replace(/-/g,"+").replace(/_/g,"/")+"==";
  const raw=Uint8Array.from(atob(padded),ch=>ch.charCodeAt(0));
  // Enforce canonical encoding, including the unused final padding bits.
  const canonical=btoa(String.fromCharCode(...raw))
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  return raw.length===64&&canonical===encoded?raw:null;
 }catch{return null;}
}
export async function verifyBrowserScenePair({
  sam,jevbot,signed,manifest,pinnedSpki
}){
 if(!await validateApprovedManifest(manifest))return false;
 if(!await verifySeat(sam,manifest,"sam")||
    !await verifySeat(jevbot,manifest,"jevbot")||
    sam.runId!==jevbot.runId||sam.sequence!==jevbot.sequence||
    sam.frameId!==jevbot.frameId)return false;
 const base=basePair(sam,jevbot,manifest);
 const digest=await shaJSON(base);
 const pair={...base,digest};
 if(!exact(signed,["schema","scope","pair","signerKeyId","signature"])||
   signed.schema!=="sam.coop.scene-pair-signed.v1"||
   signed.scope!=="private-staging-only"||
   !exact(signed.pair,["schema","scope","frameId","sequence","runId",
     "manifestDigest","samDigest","jevbotDigest","digest"])||
   JSON.stringify(signed.pair)!==JSON.stringify(pair)||
   !str64(signed.signerKeyId))return false;
 const signature=signatureBytes(signed.signature);
 if(!signature)return false;
 const keyBytes=pinnedSpki instanceof Uint8Array?pinnedSpki:
   pinnedSpki instanceof ArrayBuffer?new Uint8Array(pinnedSpki):null;
 // DER-encoded Ed25519 SPKI: fixed 12-byte prefix and 32-byte public key.
 if(!keyBytes||keyBytes.length!==44||
    ![48,42,48,5,6,3,43,101,112,3,33,0]
      .every((v,i)=>v===keyBytes[i])||
    await sha(keyBytes)!==signed.signerKeyId)return false;
 try{
  const key=await crypto.subtle.importKey("spki",keyBytes,
    {name:"Ed25519"},false,["verify"]);
  return await crypto.subtle.verify("Ed25519",key,signature,
    Uint8Array.from(digest.match(/../g),v=>parseInt(v,16)));
 }catch{return false;}
}
export async function verifyThenFetchScenePair({
  sam,jevbot,signed,manifest,pinnedSpki,origin,fetcher
}){
 if(!await verifyBrowserScenePair({sam,jevbot,signed,manifest,pinnedSpki}))
   throw Error("Untrusted paired scene commit");
 const hrefs=[...new Set([...sam.scene.commands,...jevbot.scene.commands]
   .map(c=>c.texture))];
 const textures=await fetchSceneTextures(manifest,hrefs,origin,{fetcher});
 return {scope:"private-staging-only",frameId:sam.frameId,
  sequence:sam.sequence,runId:sam.runId,textures,
  seats:{sam:sam.scene,jevbot:jevbot.scene}};
}
