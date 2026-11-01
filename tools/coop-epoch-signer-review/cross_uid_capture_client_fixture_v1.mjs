// Disposable REVIEW FIXTURE: capture enrollment over genuine separated UIDs.
// Enrollment is diagnostic; never claim a real scene epoch or game state.
import {createCaptureOwnerRoomEnrollment} from "./capture_owner_room_enrollment_v1.mjs";
import {privateGrantRequest} from "./owner_room_grant_ipc_v1.mjs";

if (process.argv.length!==7 || process.env.SAM_UID_FIXTURE_ONLY!=="1"){
  throw Error("Disposable capture fixture arguments required");
}
const [relaySocket,signerSocket,room,runId,token]=process.argv.slice(2);
const relayRequest=req=>privateGrantRequest(relaySocket,req);
const signerRequest=req=>privateGrantRequest(signerSocket,req);

// An incorrect owner token cannot request the challenge, cannot waste
// the signer one-time grant, and cannot upgrade an unrelated room.
const wrong=createCaptureOwnerRoomEnrollment({runId,relayRequest,signerRequest});
let rejected=false;
try{
  await wrong.enroll({roomHandle:room,hostSeatToken:"ff".repeat(16)});
}catch{rejected=true;}
if(!rejected)throw Error("incorrect host token unexpectedly authorized");

const owner=createCaptureOwnerRoomEnrollment({runId,relayRequest,signerRequest});
const result=await owner.enroll({roomHandle:room,hostSeatToken:token});
if(result.status!=="diagnostic-room-bound" ||
   result.captureWorkerAuthenticated!==false ||
   result.sceneEpochAttested!==false ||
   result.productionSceneEligible!==false){
  throw Error("enrollment incorrectly asserted production scene eligibility");
}
console.log("CROSS_UID_CAPTURE_ENROLLMENT_OK");
