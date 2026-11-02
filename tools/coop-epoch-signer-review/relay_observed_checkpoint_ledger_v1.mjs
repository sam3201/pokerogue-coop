// Private, bounded observer for CHECKPOINT frames the real WebSocket relay
// actually forwarded. Input must originate inside the relay's authenticated
// room/seat attach handler, AFTER successful peer.send(text).
// It never parses or stores unrelated gameplay frames, room codes or tokens.
// A shared client-reported 14-hex state hash is evidence of CONCORDANCE,
// not independent verification of the simulation or a production game epoch.
import {createHash} from "node:crypto";
export const SCHEMA="sam.coop.relay-observed-checkpoint.v1";
const sha=s=>createHash("sha256").update(s).digest("hex");
const HEX14=/^[0-9a-f]{14}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS=new Set(["turn","waveStart","waveEnd","rewards"]);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validInteger=n=>Number.isSafeInteger(n)&&n>=0;
const other=s=>s==="host"?"guest":"host";
const ignored=reason=>Object.freeze({status:"ignored",reason});
const copy=c=>({
 index:c.index,kind:c.kind,wave:c.wave,turn:c.turn,
 phaseName:c.phaseName,hash:c.hash
});
export function extractForwardedCheckpoint(seat,text){
 if(!["host","guest"].includes(seat)||typeof text!=="string"||
    text.length<10||text.length>4096)return null;
 let wire;
 try{wire=JSON.parse(text);}catch{return null;}
 if(!wire||typeof wire!=="object"||Array.isArray(wire)||
    !validInteger(wire.n)||wire.n<1||
    !wire.b||typeof wire.b!=="object"||Array.isArray(wire.b)||
    wire.b.kind!=="CHECKPOINT"||wire.b.author!==seat||
    wire.b.key!==null||!Object.hasOwn(wire.b,"payload")||
    wire.b.seq!==undefined||wire.b.takeover!==undefined||
    (wire.b.epoch!==undefined&&!validInteger(wire.b.epoch)))return null;
 const p=wire.b.payload;
 if(!p||typeof p!=="object"||Array.isArray(p)||
    Object.keys(p).length!==6||
    !["index","kind","wave","turn","phaseName","hash"].every(k=>
      Object.hasOwn(p,k))||!validInteger(p.index)||p.index>100000||
    !KINDS.has(p.kind)||!validInteger(p.wave)||p.wave>100000||
    !validInteger(p.turn)||p.turn>100000||
    typeof p.phaseName!=="string"||p.phaseName.length<1||
    p.phaseName.length>64||!HEX14.test(p.hash))return null;
 return {n:wire.n,epoch:wire.b.epoch??0,checkpoint:copy(p),
   rawDigest:sha(text)};
}
export class RelayObservedCheckpointLedger{
 #runId;#roomHandle;#created=Date.now();#closed=false;#compromised=false;
 #expected={host:0,guest:0};
 #lastN={host:0,guest:0};#seen={host:new Map(),guest:new Map()};
 #pending=new Map();#latest=-1;#chain="0".repeat(64);#total=0;
 #epoch=null;#receipts=[];#ttlMs;#maxPending;
 constructor({runId,roomHandle,ttlMs=600000,maxPending=32}={}){
  if(!UUID.test(runId||"")||typeof roomHandle!=="string"||
     roomHandle.length<6||roomHandle.length>128||
     !Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>3600000||
     !Number.isSafeInteger(maxPending)||maxPending<1||maxPending>64)
   throw Error("Invalid relay room ledger initialization");
  this.#runId=runId;this.#roomHandle=roomHandle;
  this.#ttlMs=ttlMs;this.#maxPending=maxPending;
 }
 get status(){
  return Object.freeze({runId:this.#runId,lastCompleted:this.#latest,
   count:this.#total,unpaired:this.#pending.size,
   rejected:this.#compromised,closed:this.#closed});
 }
 close(){
  this.#closed=true;this.#pending.clear();
  this.#seen.host.clear();this.#seen.guest.clear();
 }
 #reject(reason){
  this.#compromised=true;this.#pending.clear();
  return Object.freeze({status:"rejected",reason,
   productionSceneEligible:false});
 }
 observeForwarded({seat,text,forwarded=true,now=Date.now()}={}){
  if(this.#closed||this.#compromised)
   return this.#reject("room disabled");
  if(forwarded!==true)return ignored("not forwarded");
  if(typeof now!=="number"||!Number.isFinite(now)||
     now<this.#created-5000||now>this.#created+this.#ttlMs)
   return this.#reject("observation outside room lifetime");
  const event=extractForwardedCheckpoint(seat,text);
  if(!event)return ignored("not a valid checkpoint");
  const seen=this.#seen[seat];
  if(seen.has(event.n))
   return seen.get(event.n)===event.rawDigest?
     ignored("retransmission"):this.#reject("conflicting transport replay");
  if(event.n<=this.#lastN[seat])
   return ignored("old unseen transport frame");
  this.#lastN[seat]=event.n;
  seen.set(event.n,event.rawDigest);
  if(seen.size>128)seen.delete(seen.keys().next().value);
  if(this.#epoch===null)this.#epoch=event.epoch;
  if(event.epoch!==this.#epoch)
   return this.#reject("epoch changed without rebind");
  const cp=event.checkpoint;
  if(cp.index!==this.#expected[seat])
   return this.#reject("checkpoint index missing, repeated or out of order");
  this.#expected[seat]++;
  if(!this.#pending.has(cp.index)){
   if(this.#pending.size>=this.#maxPending)
    return this.#reject("unpaired checkpoint budget exhausted");
   this.#pending.set(cp.index,{});
  }
  const pending=this.#pending.get(cp.index);
  pending[seat]=cp;
  if(!pending[other(seat)])
   return Object.freeze({status:"pending",index:cp.index});
  if(!equal(pending.host,pending.guest))
   return this.#reject("host and guest checkpoint mismatch");
  if(cp.index!==this.#latest+1)
   return this.#reject("noncontiguous checkpoint consensus");
  this.#pending.delete(cp.index);
  this.#latest=cp.index;
  const checkpointDigest=sha(JSON.stringify(cp));
  const prior=this.#chain;
  this.#chain=sha(JSON.stringify({
    prev:prior,runId:this.#runId,index:cp.index,
    epoch:this.#epoch,checkpointDigest
  }));
  const receipt=Object.freeze({
   schema:SCHEMA,runId:this.#runId,
   index:cp.index,epoch:this.#epoch,
   checkpointDigest,transcriptDigest:this.#chain,
   checkpoint:Object.freeze({...cp}),
   relayObserved:true,
   stateHashOrigin:"both-clients",relayIssuedSignature:false,
   gameStateIndependentlyVerified:false,sceneEpochAttested:false,
   productionSceneEligible:false
  });
  this.#receipts.push(receipt);this.#total++;
  if(this.#receipts.length>128)this.#receipts.shift();
  return Object.freeze({status:"matched",receipt});
 }
 receipts(){return this.#receipts.map(r=>({...r,checkpoint:{...r.checkpoint}}));}
}
