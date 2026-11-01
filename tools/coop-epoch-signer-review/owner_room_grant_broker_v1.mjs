// Private relay-side room/run authorization. No HTTP endpoint, no publisher.
// The relay creates a random challenge and retains the host's 128-bit seat
// token digest. Only the trusted capture-owner may sign a binding; the
// browser's room code, claimed runId or callback cannot authorize one.
// The challenge must reach that owner through a separately authenticated
// private IPC channel (NOT a public WebSocket or page variable).
import {createHash,randomBytes,createPublicKey,sign,verify}
  from "node:crypto";
import {PrivateRelayRoomObserver} from "./relay_room_checkpoint_adapter_v1.mjs";
import {extractForwardedCheckpoint}
  from "./relay_observed_checkpoint_ledger_v1.mjs";
export const SCHEMA="sam.coop.owner-room-grant.v1";
const ROOM=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX64=/^[a-f0-9]{64}$/;
const TOKEN=/^[a-f0-9]{32}$/;
const sha=x=>createHash("sha256").update(x).digest("hex");
const exact=(x,keys)=>x&&typeof x==="object"&&!Array.isArray(x)&&
 Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const KEY_FIELDS=["schema","keyId","payload","signature"];
const PAYLOAD_FIELDS=["schema","roomHandle","runId","challenge",
  "hostTokenDigest","issuedAt","expiresAt"];
const keyId=key=>sha(key.export({type:"spki",format:"der"}));
function checkPublicKey(key){
 return key?.type==="public"&&key.asymmetricKeyType==="ed25519";
}
function validPayload(p){
 return exact(p,PAYLOAD_FIELDS)&&p.schema===SCHEMA&&
  ROOM.test(p.roomHandle||"")&&UUID.test(p.runId||"")&&
  HEX64.test(p.challenge||"")&&HEX64.test(p.hostTokenDigest||"")&&
  Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
  p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=15000;
}
export function issuePrivateRoomGrant({
  roomHandle,runId,challenge,hostSeatToken,issuedAt,expiresAt,
  signingKey
}){
 if(!TOKEN.test(hostSeatToken||"")||
    signingKey?.type!=="private"||
    signingKey.asymmetricKeyType!=="ed25519")
  throw Error("Invalid owner grant issuer");
 const p={schema:SCHEMA,roomHandle,runId,challenge,
  hostTokenDigest:sha(hostSeatToken),issuedAt,expiresAt};
 if(!validPayload(p))throw Error("Malformed owner grant");
 const publicKey=createPublicKey(signingKey);
 return Object.freeze({
  schema:SCHEMA,keyId:keyId(publicKey),
  payload:Object.freeze(p),
  signature:sign(null,Buffer.from(JSON.stringify(p)),signingKey)
    .toString("base64url")
 });
}
export class PrivateRoomGrantBroker{
 #pinned;#observer;#now;#ttlMs;#rooms=new Map();#runs=new Set();
 #maxRooms;
 constructor({pinnedOwnerKey,observer,now=Date.now,
    ttlMs=12000,maxRooms=32}={}){
  if(!checkPublicKey(pinnedOwnerKey)||
     typeof now!=="function"||
     !(observer instanceof PrivateRelayRoomObserver)||
     !Number.isSafeInteger(ttlMs)||ttlMs<2000||ttlMs>15000||
     !Number.isSafeInteger(maxRooms)||maxRooms<1||maxRooms>256)
   throw Error("Invalid private room broker configuration");
  this.#pinned=pinnedOwnerKey;this.#observer=observer;
  this.#now=now;this.#ttlMs=ttlMs;this.#maxRooms=maxRooms;
 }
 // The relay MUST call this with created.code and SHA-256(created.token)
 // obtained in-process, before sending relay:created or accepting checkpoints.
 // The callback never receives the raw bearer seat token.
 onRoomCreated({roomHandle,hostTokenDigest}={}){
  if(!ROOM.test(roomHandle||"")||!HEX64.test(hostTokenDigest||"")||
     this.#rooms.has(roomHandle)||this.#rooms.size>=this.#maxRooms)
   throw Error("Untrusted relay room creation");
  const createdAt=this.#now();
  if(!Number.isSafeInteger(createdAt))throw Error("Invalid clock");
  const item={challenge:randomBytes(32).toString("hex"),
    hostTokenDigest,createdAt,
    expiresAt:createdAt+this.#ttlMs,
    authorized:false,closed:false,priorCheckpoint:false};
  this.#rooms.set(roomHandle,item);
  // PRIVATE IPC ONLY: never send challenge or token digest in relay:created.
  return Object.freeze({roomHandle,challenge:item.challenge,
    expiresAt:item.expiresAt});
 }
 authorize(grant){
  const p=grant?.payload;
  if(!exact(grant,KEY_FIELDS)||grant.schema!==SCHEMA||
     grant.keyId!==keyId(this.#pinned)||!validPayload(p)||
     typeof grant.signature!=="string"||
     !/^[A-Za-z0-9_-]{86}$/.test(grant.signature))
   return false;
  const item=this.#rooms.get(p.roomHandle);
  const now=this.#now();
  if(!item||item.closed||item.authorized||item.priorCheckpoint||
     this.#runs.has(p.runId)||p.challenge!==item.challenge||
     p.hostTokenDigest!==item.hostTokenDigest||
     !Number.isSafeInteger(now)||
     p.issuedAt<item.createdAt-1000||p.issuedAt>now+1000||
     p.expiresAt>item.expiresAt||
     now>p.expiresAt||now>item.expiresAt)return false;
  let bytes;
  try{
   bytes=Buffer.from(grant.signature,"base64url");
   if(bytes.length!==64||
      bytes.toString("base64url")!==grant.signature||
      !verify(null,Buffer.from(JSON.stringify(p)),
        this.#pinned,bytes))return false;
  }catch{return false;}
  try{
   this.#observer.registerRoom({
     roomHandle:p.roomHandle,runId:p.runId
   });
  }catch{return false;}
  item.authorized=true;
  item.runId=p.runId;
  this.#runs.add(p.runId);
  return true;
 }
 onForwardedCheckpoint(event){
  const room=this.#rooms.get(event?.roomHandle);
  if(!room||room.closed)return {status:"ignored",reason:"unregistered relay room"};
  if(!room.authorized){
   if(extractForwardedCheckpoint(event.seat,event.text))
     room.priorCheckpoint=true;
   return {status:"ignored",reason:"owner grant absent"};
  }
  return this.#observer.onForwardedCheckpoint(event);
 }
 onRoomClosed({roomHandle}={}){
  const item=this.#rooms.get(roomHandle);
  if(!item)return false;
  item.closed=true;
  this.#observer.unregisterRoom(roomHandle);
  this.#rooms.delete(roomHandle);
  // A runId is a one-use owner authorization identity, not a per-room
  // lease. Closing a room revokes its active binding but must NOT release
  // its identity for a new room while this broker is alive.
  return true;
 }
 get status(){
  return Object.freeze({rooms:this.#rooms.size,
   authorized:[...this.#rooms.values()].filter(r=>r.authorized).length,
   productionSceneEligible:false});
 }
}
