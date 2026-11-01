// Trust boundary for prospective relay-issued signed logical checkpoints.
// Existing co-op relays do NOT issue this format. No listener, key creation,
// relay modification, or publication occurs in this module.
import {createHash,verify} from "node:crypto";
import {preparePrivateEpoch,inspectPrivateEpoch}
 from "./private_epoch_capture_contract_v1.mjs";
export const CHECKPOINT_SCHEMA="sam.coop.relay-checkpoint.v1";
const sha=b=>createHash("sha256").update(b).digest("hex");
const HEX=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(o,k)=>o&&typeof o==="object"&&!Array.isArray(o)&&
 Object.keys(o).length===k.length&&k.every(x=>Object.hasOwn(o,x));
const envelopeKeys=["schema","issuerKeyId","payload","signature"];
const payloadKeys=["schema","runId","sequence","relayCommitHash","gameStateHash",
 "issuedAt","expiresAt"];
export function keyFingerprint(publicKey){
 if(publicKey?.type!=="public"||publicKey.asymmetricKeyType!=="ed25519")
  throw Error("A pinned Ed25519 public key is required");
 return sha(publicKey.export({format:"der",type:"spki"}));
}
export function verifySignedRelayCheckpoint(
 token,pinnedKey,{runId,sequence,now=Date.now()}={}
){
 let fingerprint;
 try{fingerprint=keyFingerprint(pinnedKey);}catch{return false;}
 if(!exact(token,envelopeKeys)||
    token.schema!==CHECKPOINT_SCHEMA||
    token.issuerKeyId!==fingerprint||
    !exact(token.payload,payloadKeys)||
    token.payload.schema!==CHECKPOINT_SCHEMA||
    !UUID.test(token.payload.runId||"")||
    !Number.isSafeInteger(token.payload.sequence)||
    token.payload.sequence<1||token.payload.sequence>100000000||
    !HEX.test(token.payload.relayCommitHash||"")||
    !HEX.test(token.payload.gameStateHash||"")||
    (runId!==undefined&&token.payload.runId!==runId)||
    (sequence!==undefined&&token.payload.sequence!==sequence)||
    typeof token.signature!=="string"||
    !/^[A-Za-z0-9_-]{86}$/.test(token.signature)||
    !Number.isFinite(now))return false;
 const issued=Date.parse(token.payload.issuedAt||"");
 const expires=Date.parse(token.payload.expiresAt||"");
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||
    typeof token.payload.issuedAt!=="string"||
    typeof token.payload.expiresAt!=="string"||
    !/Z$/.test(token.payload.issuedAt)||
    !/Z$/.test(token.payload.expiresAt)||
    issued>now+3000||now<issued-3000||expires<=now||
    expires<=issued||expires-issued>15000)return false;
 try{
  const signature=Buffer.from(token.signature,"base64url");
  if(signature.length!==64||
     signature.toString("base64url")!==token.signature)return false;
  return verify(null,Buffer.from(JSON.stringify(token.payload)),
    pinnedKey,signature);
 }catch{return false;}
}
// This verifies checkpoint origin IF and ONLY IF the named public key is
// independently pinned to the real relay. Browser postrender provenance is
// a separate gate. The result remains diagnostic even if checkpoint verified.
export async function prepareCheckpointAuthenticatedEpoch({
 runId,sequence,readSignedCheckpoint,captureSeat,pinnedPublicKey,signal,now
}){
 if(typeof readSignedCheckpoint!=="function"||
   typeof captureSeat!=="function"||
   !UUID.test(runId||"")||
   !Number.isSafeInteger(sequence)||sequence<1)
   throw Error("Invalid relay checkpoint capture request");
 const checkpoints=[];
 const readRelayCheckpoint=async()=>{
  const token=await readSignedCheckpoint();
  if(!verifySignedRelayCheckpoint(token,pinnedPublicKey,{
   runId,sequence,now:typeof now==="function"?now():Date.now()
  }))throw Error("Relay checkpoint signature invalid");
  checkpoints.push(token);
  const {relayCommitHash,gameStateHash}=token.payload;
  return {runId,relayCommitHash,gameStateHash};
 };
 const evidence=await preparePrivateEpoch({
  runId,sequence,readRelayCheckpoint,captureSeat,signal
 });
 if(checkpoints.length!==2||!inspectPrivateEpoch(evidence))
  throw Error("Incomplete authenticated diagnostic capture");
 return {
  ...evidence,
  signedRelayCheckpoints:{before:checkpoints[0],after:checkpoints[1]},
  // This means only a PINNED relay checkpoint was verified.
  // No true scene source/production authority is implied.
  relayCheckpointVerified:true,
  productionSceneEligible:false
 };
}
export function verifyCheckpointAuthenticatedEpoch(
 result,pinnedPublicKey,{now=Date.now()}={}
){
 if(!result||result.relayCheckpointVerified!==true||
    result.productionSceneEligible!==false||
    !inspectPrivateEpoch(result)||
    !exact(result.signedRelayCheckpoints,["before","after"]))
   return false;
 const {before,after}=result.signedRelayCheckpoints;
 const {runId,sequence,relayCommitHash,gameStateHash}=result.receipt;
 return [before,after].every(token=>
   verifySignedRelayCheckpoint(token,pinnedPublicKey,{runId,sequence,now})&&
   token.payload.relayCommitHash===relayCommitHash&&
   token.payload.gameStateHash===gameStateHash);
}
