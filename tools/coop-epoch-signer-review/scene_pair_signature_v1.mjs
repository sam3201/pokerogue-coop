// Private detached Ed25519 pair authentication. No persistent key generation,
// no public deployment, and no license/coverage gate bypass.
import {sign,verify,createHash} from "node:crypto";
import {bindPairedScenes} from "./scene_asset_binding_v1.mjs";
const sha=s=>createHash("sha256").update(s).digest("hex");
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function keyId(key){
 return sha(key.export({format:"der",type:"spki"}));
}
export function signScenePair(pair,sam,jevbot,manifest,privateKey,publicKey){
 const trusted=bindPairedScenes(sam,jevbot,manifest);
 if(!trusted||!equal(trusted,pair)||
    privateKey?.type!=="private"||publicKey?.type!=="public"||
    privateKey.asymmetricKeyType!=="ed25519"||
    publicKey.asymmetricKeyType!=="ed25519")
   throw Error("Pair identity, signer, or manifest invalid");
 const signature=sign(null,Buffer.from(trusted.digest,"hex"),privateKey)
   .toString("base64url");
 return {schema:"sam.coop.scene-pair-signed.v1",
   scope:"private-staging-only",pair:trusted,
   signerKeyId:keyId(publicKey),signature};
}
export function verifySignedScenePair(payload,sam,jevbot,manifest,pinnedKey){
 if(!payload||payload.schema!=="sam.coop.scene-pair-signed.v1"||
    payload.scope!=="private-staging-only"||
    pinnedKey?.type!=="public"||pinnedKey.asymmetricKeyType!=="ed25519"||
    payload.signerKeyId!==keyId(pinnedKey)||
    !/^[A-Za-z0-9_-]{86}$/.test(payload.signature||"")||
    Object.keys(payload).sort().join(",")!==
      ["pair","schema","scope","signature","signerKeyId"].sort().join(","))
   return false;
 const expected=bindPairedScenes(sam,jevbot,manifest);
 if(!expected||!equal(expected,payload.pair))return false;
 try{
  const signatureBytes=Buffer.from(payload.signature,"base64url");
  if(signatureBytes.length!==64||
     signatureBytes.toString("base64url")!==payload.signature)return false;
  return verify(null,Buffer.from(expected.digest,"hex"),
    pinnedKey,signatureBytes);
 }catch{return false;}
}
