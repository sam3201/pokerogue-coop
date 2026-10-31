// Private capture-owner room enrollment protocol, NOT a credential boundary.
// The capture-owner process must supply a preconfigured run ID and isolated
// authenticated AF_UNIX clients. Never expose this entrypoint to a browser.
// This module does not attest a scene/PNG epoch or allow production rendering.
import {createHash} from "node:crypto";

const RUN=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ROOM=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const TOKEN=/^[a-f0-9]{32}$/;
const HEX64=/^[a-f0-9]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const SCHEMA="sam.coop.owner-room-grant.v1";
const fields=(obj,names)=>obj!==null&&typeof obj==="object"&&!Array.isArray(obj)&&
 Object.keys(obj).length===names.length&&names.every(k=>Object.hasOwn(obj,k));

export function createCaptureOwnerRoomEnrollment({
 runId,relayRequest,signerRequest,now=Date.now
}={}){
 if(!RUN.test(runId||"")||typeof relayRequest!=="function"||
    typeof signerRequest!=="function"||typeof now!=="function")
  throw Error("Invalid trusted owner enrollment configuration");
 let attempted=false;
 return Object.freeze({
  async enroll({roomHandle,hostSeatToken}={}){
   // One attempt per owner lease even if a network response is ambiguous.
   if(attempted)throw Error("Owner enrollment already attempted");
   attempted=true;
   if(!ROOM.test(roomHandle||"")||!TOKEN.test(hostSeatToken||""))
    throw Error("Invalid host-seat enrollment identity");
   const digest=createHash("sha256").update(hostSeatToken).digest("hex");
   // The challenge is relayed privately and tied to the real host token.
   const challenge=await relayRequest({
    op:"challenge",roomHandle,hostTokenDigest:digest
   });
   if(!fields(challenge,["ok","challenge","expiresAt"])||
      challenge.ok!==true||!HEX64.test(challenge.challenge||"")||
      !Number.isSafeInteger(challenge.expiresAt))
    throw Error("Relay challenge unavailable");
   const issuedAt=now();
   if(!Number.isSafeInteger(issuedAt)||
      challenge.expiresAt<=issuedAt+100||
      challenge.expiresAt>issuedAt+15000)
    throw Error("Relay challenge expired or unbounded");
   const payload={
    schema:SCHEMA,roomHandle,runId,challenge:challenge.challenge,
    hostTokenDigest:digest,issuedAt,
    expiresAt:Math.min(issuedAt+4000,challenge.expiresAt)
   };
   const signed=await signerRequest({op:"sign_room_grant",payload});
   const grant=signed?.grant;
   if(!fields(signed,["ok","grant"])||signed.ok!==true||
      !fields(grant,["schema","keyId","payload","signature"])||
      grant.schema!==SCHEMA||!HEX64.test(grant.keyId||"")||
      !SIG.test(grant.signature||"")||
      !fields(grant.payload,Object.keys(payload))||
      Object.keys(payload).some(k=>grant.payload[k]!==payload[k]))
    throw Error("Signer refused or changed owner grant");
   if(now()>=payload.expiresAt)
    throw Error("Owner grant expired before relay authorization");
   const authorized=await relayRequest({op:"authorize",grant});
   if(!fields(authorized,["ok"])||authorized.ok!==true)
    throw Error("Relay rejected owner grant");
   return Object.freeze({
    status:"diagnostic-room-bound",runId,
    captureWorkerAuthenticated:false,
    sceneEpochAttested:false,
    productionSceneEligible:false
   });
  }
 });
}
