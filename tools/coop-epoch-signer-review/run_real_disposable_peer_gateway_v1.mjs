// Cross-runtime diagnostic: Node broker <-> Python SO_PEERCRED gateway.
// All processes run under the current UID; distinct UID is NOT proven here.
// No live relay, production signing keys, or public site files are used.
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync} from "node:crypto";
import {mkdtempSync,mkdirSync,chmodSync,existsSync,rmSync,statSync}
 from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {PrivateRoomGrantBroker,issuePrivateRoomGrant}
 from "./owner_room_grant_broker_v1.mjs";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
import {PrivateOwnerGrantIpc,privateGrantRequest}
 from "./owner_room_grant_ipc_v1.mjs";
import {createCaptureOwnerRoomEnrollment}
 from "./capture_owner_room_enrollment_v1.mjs";

const sha=x=>createHash("sha256").update(x).digest("hex");
const root=mkdtempSync(join(tmpdir(),"sam-relay-gateway-check-"));
chmodSync(root,0o700);
const backendDir=join(root,"private"),frontDir=join(root,"capture");
mkdirSync(backendDir,{mode:0o700});mkdirSync(frontDir,{mode:0o750});
chmodSync(backendDir,0o700);chmodSync(frontDir,0o750);
const back=join(backendDir,"owner-grants.sock");
const front=join(frontDir,"capture-owner-gateway.sock");
const key=generateKeyPairSync("ed25519");
const receipts=[];
const observer=new PrivateRelayRoomObserver({onReceipt:r=>receipts.push(r)});
const broker=new PrivateRoomGrantBroker({pinnedOwnerKey:key.publicKey,observer});
let ipc=null,child=null;
function checkpoint(seat,index){
 return JSON.stringify({n:index+1,b:{kind:"CHECKPOINT",author:seat,
  key:null,payload:{index,kind:"turn",wave:1,turn:index,
   phaseName:"CommandPhase",hash:"0123456789abcd"}}});
}
async function until(fn,ms=6000){
 const end=Date.now()+ms;
 while(Date.now()<end){
  if(fn())return;
  await delay(40);
 }
 throw Error("Private gateway fixture startup timeout");
}
async function main(){
 ipc=new PrivateOwnerGrantIpc({broker,socketPath:back});
 await ipc.start();
 assert.equal(statSync(back).mode&0o777,0o600);
 child=spawn("python3",["-u",join(dirname(new URL(import.meta.url).pathname),
  "run_relay_gateway_lab_fixture_v1.py"),front,back,
  String(process.getuid()),String(process.getgid())],{
  env:{...process.env,SAM_RELAY_GATEWAY_LAB_ONLY:"1"},
  stdio:["ignore","pipe","pipe"]
 });
 let out="",err="";
 child.stdout.on("data",b=>out+=String(b));
 child.stderr.on("data",b=>err+=String(b).slice(0,1500));
 await until(()=>{
  if(child.exitCode!==null)throw Error("Gateway exited: "+err);
  return out.includes("RELAY_PEER_GATEWAY_LAB_READY")&&existsSync(front);
 });
 assert.equal(statSync(front).mode&0o777,0o660);
 const roomHandle="ABC234",hostSeatToken="12".repeat(16);
 const runId="12345678-1234-4123-8123-123456789abc";
 ipc.onRoomCreated({roomHandle,hostTokenDigest:sha(hostSeatToken)});
 const signer=async req=>{
  const p=req.payload;
  return {ok:true,grant:issuePrivateRoomGrant({
   roomHandle:p.roomHandle,runId:p.runId,challenge:p.challenge,
   hostSeatToken,issuedAt:p.issuedAt,expiresAt:p.expiresAt,
   signingKey:key.privateKey
  })};
 };
 const owner=createCaptureOwnerRoomEnrollment({
  runId,relayRequest:r=>privateGrantRequest(front,r),
  signerRequest:signer
 });
 const enrolled=await owner.enroll({roomHandle,hostSeatToken});
 assert.equal(enrolled.status,"diagnostic-room-bound");
 assert.equal(enrolled.productionSceneEligible,false);
 assert.equal(broker.status.authorized,1);
 const wrong=await privateGrantRequest(front,{
  op:"challenge",roomHandle,hostTokenDigest:sha("aa".repeat(16))});
 assert.deepEqual(wrong,{ok:false});
 const first=ipc.onForwardedCheckpoint({
  roomHandle,seat:"host",text:checkpoint("host",0)});
 const second=ipc.onForwardedCheckpoint({
  roomHandle,seat:"guest",text:checkpoint("guest",0)});
 assert.equal(first.status,"pending");
 assert.equal(second.status,"matched");
 assert.equal(receipts.length,1);
 assert.equal(receipts[0].productionSceneEligible,false);
 const bad=await privateGrantRequest(front,{
  op:"authorize",grant:{schema:"tampered"}});
 assert.deepEqual(bad,{ok:false});
 assert.equal(ipc.onRoomClosed({roomHandle}),true);
 const output={scope:"disposable-same-uid-lab-only",
  realNodeBroker:true,realPythonGateway:true,unixPeerCredentials:true,
  publicSocketMode:"0660",privateSocketMode:"0600",
  matched:receipts.length,wrongHostDigestRejected:true,
  malformedGrantRejected:true,distinctUidVerified:false,
  realGameSceneAttested:false,productionSceneEligible:false};
 console.log("PRIVATE_RELAY_PEER_GATEWAY_V1",JSON.stringify(output));
}
try{await main();}
finally{
 if(child&&child.exitCode===null){
  child.kill("SIGTERM");
  await until(()=>child.exitCode!==null,5000).catch(()=>{child.kill("SIGKILL");});
 }
 if(ipc)await ipc.close();
 rmSync(root,{recursive:true,force:true});
}
