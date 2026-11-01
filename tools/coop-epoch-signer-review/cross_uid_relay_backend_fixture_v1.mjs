// Disposable REVIEW FIXTURE: real Node grant broker under synthetic relay UID.
// No network ports, game assets, public renderer, or scene epoch attestation.
import {readFileSync} from "node:fs";
import {createPublicKey,createHash} from "node:crypto";
import {PrivateRoomGrantBroker} from "./owner_room_grant_broker_v1.mjs";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
import {PrivateOwnerGrantIpc} from "./owner_room_grant_ipc_v1.mjs";

if (process.argv.length !== 6 || process.env.SAM_UID_FIXTURE_ONLY !== "1") {
  throw Error("Disposable UID fixture arguments required");
}
const [socketPath,spkiPath,room,hostToken] = process.argv.slice(2);
const ownerKey=createPublicKey({key:readFileSync(spkiPath),format:"der",type:"spki"});
const receipts=[];
const observer=new PrivateRelayRoomObserver({onReceipt:r=>receipts.push(r)});
const broker=new PrivateRoomGrantBroker({
  pinnedOwnerKey:ownerKey,observer,ttlMs:12000
});
const ipc=new PrivateOwnerGrantIpc({broker,socketPath});
const sha=s=>createHash("sha256").update(s).digest("hex");
const checkpoint=(seat,index,n)=>JSON.stringify({
  n,b:{kind:"CHECKPOINT",key:null,author:seat,payload:{
    index,kind:"waveStart",wave:1,turn:0,
    phaseName:"CommandPhase",hash:"0123456789abcd"
  }}
});
let interval;
let terminated=false;
const fail=async(err)=>{
  if(terminated)return;
  terminated=true;
  if(interval)clearInterval(interval);
  try{await ipc.close();}catch{}
  console.error("CROSS_UID_BACKEND_FAILURE",String(err?.message||err));
  process.exitCode=1;
};
process.once("SIGTERM",()=>{void fail("terminated");});
await ipc.start();
ipc.onRoomCreated({roomHandle:room,hostTokenDigest:sha(hostToken)});
console.log("CROSS_UID_PRIVATE_BACKEND_READY");
const deadline=Date.now()+9500;
interval=setInterval(async()=>{
  if(terminated)return;
  if(Date.now()>deadline){await fail("room grant deadline");return;}
  if(ipc.status.authorized!==1)return;
  terminated=true;clearInterval(interval);
  try{
    const host=ipc.onForwardedCheckpoint({
      roomHandle:room,seat:"host",text:checkpoint("host",0,1)
    });
    const guest=ipc.onForwardedCheckpoint({
      roomHandle:room,seat:"guest",text:checkpoint("guest",0,1)
    });
    if(host.status!=="pending" || guest.status!=="matched" ||
       receipts.length!==1 || guest.receipt.productionSceneEligible!==false) {
      throw Error("authenticated room failed diagnostic two-seat match");
    }
    if(!ipc.onRoomClosed({roomHandle:room}))throw Error("room close failed");
    console.log("CROSS_UID_DIAGNOSTIC_MATCH_OK");
    await ipc.close();
  }catch(err){
    console.error("CROSS_UID_BACKEND_FAILURE",String(err?.message||err));
    process.exitCode=1;
    try{await ipc.close();}catch{}
  }
},25);
