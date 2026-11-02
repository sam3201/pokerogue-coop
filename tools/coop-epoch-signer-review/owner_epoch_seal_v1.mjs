// SAM isolated capture receipt, signed at the capture-OWNER boundary.
// This seals the bytes of a private diagnostic; it DOES NOT turn a browser-
// supplied checkpoint into an authenticated relay observation.
// Never persist test keys or place them in a web-served directory.
import {createHash,createPublicKey,sign,verify} from "node:crypto";
import {inspectPrivateEpoch} from "./private_epoch_capture_contract_v1.mjs";
export const SEALED_SCHEMA="sam.coop.epoch-diagnostic-sealed.v1";
const sha=b=>createHash("sha256").update(b).digest("hex");
const hex=/^[0-9a-f]{64}$/;
const exactly=(o,fields)=>!!o&&typeof o==="object"&&!Array.isArray(o)&&
 Object.keys(o).length===fields.length&&fields.every(f=>Object.hasOwn(o,f));
const fields=["schema","scope","issuerKeyId","payload","signature"];
const payloadFields=["schema","scope","runId","sequence","frameId","capturedAt",
 "relayCommitHash","gameStateHash","frameManifestHash","pngHashes",
 "sceneHashes","frameTicks","sceneComplete","issuerAuthenticated",
 "sceneEpochAttested","productionSceneEligible","source"];
function ownPayload(e){
 const r=e.receipt;
 return {
  schema:SEALED_SCHEMA,scope:"private-diagnostic-only",
  runId:r.runId,sequence:r.sequence,frameId:r.frameId,
  capturedAt:e.frameSync.capturedAt,
  relayCommitHash:r.relayCommitHash,gameStateHash:r.gameStateHash,
  frameManifestHash:r.frameManifestHash,
  pngHashes:{sam:r.pngHashes.sam,jevbot:r.pngHashes.jevbot},
  sceneHashes:{sam:r.sceneHashes.sam,jevbot:r.sceneHashes.jevbot},
  frameTicks:{sam:r.frameTicks.sam,jevbot:r.frameTicks.jevbot},
  sceneComplete:r.sceneComplete,
  issuerAuthenticated:false,sceneEpochAttested:false,
  productionSceneEligible:false,source:"caller-supplied-postrender"
 };
}
function keyId(key){return sha(key.export({format:"der",type:"spki"}));}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function sealPrivateEpoch(e,privateKey,publicKey){
 if(!inspectPrivateEpoch(e))throw Error("Private capture evidence invalid");
 if(privateKey?.type!=="private"||
   privateKey.asymmetricKeyType!=="ed25519"||
   publicKey?.type!=="public"||
   publicKey.asymmetricKeyType!=="ed25519"||
   keyId(createPublicKey(privateKey))!==keyId(publicKey))
  throw Error("Issuer key mismatch");
 const payload=ownPayload(e);
 const message=Buffer.from(JSON.stringify(payload));
 const signature=sign(null,message,privateKey).toString("base64url");
 return {schema:SEALED_SCHEMA,scope:"private-diagnostic-only",
   issuerKeyId:keyId(publicKey),payload,signature};
}
export function verifyPrivateEpochSeal(sealed,e,pinnedPublicKey){
 if(!inspectPrivateEpoch(e)||
    pinnedPublicKey?.type!=="public"||
    pinnedPublicKey.asymmetricKeyType!=="ed25519"||
    !exactly(sealed,fields)||sealed.schema!==SEALED_SCHEMA||
    sealed.scope!=="private-diagnostic-only"||
    !hex.test(sealed.issuerKeyId||"")||
    sealed.issuerKeyId!==keyId(pinnedPublicKey)||
    !exactly(sealed.payload,payloadFields)||
    sealed.payload.issuerAuthenticated!==false||
    sealed.payload.sceneEpochAttested!==false||
    sealed.payload.productionSceneEligible!==false||
    !same(sealed.payload,ownPayload(e))||
    typeof sealed.signature!=="string"||
    !/^[A-Za-z0-9_-]{86}$/.test(sealed.signature))
   return false;
 try{
  const bytes=Buffer.from(sealed.signature,"base64url");
  if(bytes.length!==64||bytes.toString("base64url")!==sealed.signature)
   return false;
  return verify(null,Buffer.from(JSON.stringify(sealed.payload)),
    pinnedPublicKey,bytes);
 }catch{return false;}
}
// Memory-only monotonic display guard, not global counter or relay receipt.
// Call only AFTER verifyPrivateEpochSeal. A new run requires explicit reset.
export class PrivateEpochSequence{
 #runId=null;#latest=0;#issuerKeyId=null;
 accept(sealed,e,pinnedPublicKey){
  if(!verifyPrivateEpochSeal(sealed,e,pinnedPublicKey))return false;
  const {runId,sequence}=sealed.payload;
  if(this.#runId!==null&&
    (this.#runId!==runId||this.#issuerKeyId!==sealed.issuerKeyId||
      sequence<=this.#latest))return false;
  this.#runId=runId;
  this.#latest=sequence;
  this.#issuerKeyId=sealed.issuerKeyId;
  return true;
 }
 status(){return Object.freeze({runId:this.#runId,lastSequence:this.#latest});}
 reset(){this.#runId=null;this.#latest=0;this.#issuerKeyId=null;}
}
