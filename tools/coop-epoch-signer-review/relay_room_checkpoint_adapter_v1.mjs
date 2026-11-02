// Owner-only in-memory adapter for the optional relay forwarding callback.
// This is NOT an HTTP endpoint. The owner must bind a relay-created room
// to its run ID before the first checkpoint is forwarded. No browser value
// grants that binding. No room codes, raw frames or seat tokens are output.
import {RelayObservedCheckpointLedger}
  from "./relay_observed_checkpoint_ledger_v1.mjs";
const ROOM=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class PrivateRelayRoomObserver{
 #rooms=new Map();#maxRooms;#onReceipt;#counts={matched:0,rejected:0};
 constructor({maxRooms=32,onReceipt=()=>{}}={}){
  if(!Number.isSafeInteger(maxRooms)||maxRooms<1||maxRooms>256||
     typeof onReceipt!=="function")
   throw Error("Invalid relay observer configuration");
  this.#maxRooms=maxRooms;this.#onReceipt=onReceipt;
 }
 registerRoom({roomHandle,runId}={}){
  if(!ROOM.test(roomHandle||"")||!UUID.test(runId||""))
   throw Error("Invalid trusted room binding");
  if(this.#rooms.has(roomHandle))throw Error("Room already registered");
  if(this.#rooms.size>=this.#maxRooms)
   throw Error("Observer room limit");
  this.#rooms.set(roomHandle,new RelayObservedCheckpointLedger({
    roomHandle,runId
  }));
  return Object.freeze({runId,registered:true});
 }
 onForwardedCheckpoint({roomHandle,seat,text}={}){
  // Intended call-site: relay-server.ts AFTER the authenticated seat's
  // peer.send(text). Not evidence of client ACK or exact game correctness.
  const ledger=this.#rooms.get(roomHandle);
  if(!ledger)return Object.freeze({status:"ignored",reason:"unregistered room"});
  const result=ledger.observeForwarded({seat,text,forwarded:true});
  if(result.status==="matched"){
   this.#counts.matched++;
   try{this.#onReceipt(result.receipt);}
   catch{/* Diagnostic failures must never interrupt game forwarding. */}
  }else if(result.status==="rejected")this.#counts.rejected++;
  return Object.freeze({status:result.status,
    ...(result.status==="matched"?{receipt:result.receipt}:{}),
    ...(result.status==="rejected"?{reason:result.reason}:{})});
 }
 unregisterRoom(roomHandle){
  const ledger=this.#rooms.get(roomHandle);
  if(!ledger)return false;
  ledger.close();this.#rooms.delete(roomHandle);
  return true;
 }
 get status(){
  return Object.freeze({activeRooms:this.#rooms.size,
   matched:this.#counts.matched,rejected:this.#counts.rejected,
   productionSceneEligible:false});
 }
}
