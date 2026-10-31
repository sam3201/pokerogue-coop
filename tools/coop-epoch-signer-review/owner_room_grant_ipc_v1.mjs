// Private owner-to-relay IPC for signed room authorization.
// AF_UNIX only; must reside in a preexisting mode-0700 private directory.
// No public socket/TCP/HTTP listener, no browser access, no key persistence.
import net from "node:net";
import {lstatSync,statSync,chmodSync,unlinkSync,realpathSync}
 from "node:fs";
import {dirname,resolve,basename} from "node:path";
import {PrivateRoomGrantBroker} from "./owner_room_grant_broker_v1.mjs";
const ROOM=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const HEX=/^[a-f0-9]{64}$/;
const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&
 Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
export class PrivateOwnerGrantIpc{
 #broker;#socketPath;#server=null;#ownsPath=false;#socketIdentity=null;
 #sockets=new Set();#created=new Map();
 constructor({broker,socketPath}={}){
  if(!(broker instanceof PrivateRoomGrantBroker)||
     typeof socketPath!=="string"||
     !socketPath.startsWith("/")||socketPath.length>99||
     basename(socketPath)!=="owner-grants.sock"||
     resolve(socketPath)!==socketPath)
   throw Error("Invalid private IPC configuration");
  const parent=dirname(socketPath);
  const info=lstatSync(parent);
  if(!info.isDirectory()||info.isSymbolicLink()||
     realpathSync(parent)!==parent||
     (info.mode&0o077)!==0||info.uid!==process.getuid())
   throw Error("IPC directory is not owner-private");
  this.#broker=broker;this.#socketPath=socketPath;
 }
 onRoomCreated(event){
  const issued=this.#broker.onRoomCreated(event);
  this.#created.set(event.roomHandle,{
   challenge:issued.challenge,expiresAt:issued.expiresAt,
   hostTokenDigest:event.hostTokenDigest});
  return true;
 }
 onRoomClosed(event){
  this.#created.delete(event.roomHandle);
  return this.#broker.onRoomClosed(event);
 }
 onForwardedCheckpoint(event){
  return this.#broker.onForwardedCheckpoint(event);
 }
 async start(){
  if(this.#server)throw Error("IPC already started");
  try{lstatSync(this.#socketPath);
   throw Error("IPC socket path already exists");
  }catch(e){
   if(e?.code!=="ENOENT")throw e;
  }
  const server=net.createServer({allowHalfOpen:false},socket=>{
   if(this.#sockets.size>=8){socket.destroy();return;}
   this.#sockets.add(socket);
   socket.setTimeout(3000,()=>socket.destroy());
   let input="",done=false;
   socket.on("data",chunk=>{
    if(done)return;
    input+=chunk.toString("utf8");
    if(Buffer.byteLength(input)>4096){done=true;socket.destroy();return;}
    const end=input.indexOf("\n");
    if(end<0)return;
    done=true;
    let result={ok:false};
    try{
     if(end===input.length-1){
      const req=JSON.parse(input.slice(0,end));
      result=this.#respond(req);
     }
    }catch{/* Do not disclose room binding details on invalid input. */}
    socket.end(JSON.stringify(result)+"\n");
   });
   socket.on("error",()=>{});
   socket.on("close",()=>this.#sockets.delete(socket));
  });
  this.#server=server;
  try{
   await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(this.#socketPath,()=>{
     this.#ownsPath=true;
     server.off("error",reject);resolve();
    });
   });
   chmodSync(this.#socketPath,0o600);
   const st=lstatSync(this.#socketPath);
   if(!st.isSocket()||(st.mode&0o077)!==0)
    throw Error("IPC socket permissions not private");
   this.#socketIdentity={dev:st.dev,ino:st.ino};
  }catch(e){
   await this.close();
   throw e;
  }
  return {scope:"local-unix-owner-only",listening:true};
 }
 #respond(req){
  if(exact(req,["op","roomHandle","hostTokenDigest"])&&
     req.op==="challenge"&&ROOM.test(req.roomHandle||"")&&
     HEX.test(req.hostTokenDigest||"")){
   const item=this.#created.get(req.roomHandle);
   if(!item||item.hostTokenDigest!==req.hostTokenDigest)
    return {ok:false};
   return {ok:true,challenge:item.challenge,expiresAt:item.expiresAt};
  }
  if(exact(req,["op","grant"])&&req.op==="authorize"){
   const ok=this.#broker.authorize(req.grant);
   return {ok};
  }
  return {ok:false};
 }
 async close(){
  const server=this.#server;
  this.#server=null;
  for(const socket of this.#sockets)socket.destroy();
  this.#sockets.clear();
  if(server)await new Promise(resolve=>server.close(()=>resolve()));
  if(this.#ownsPath){
   this.#ownsPath=false;
   try{
    const current=lstatSync(this.#socketPath);
    if(current.isSocket()&&this.#socketIdentity&&
       current.dev===this.#socketIdentity.dev&&
       current.ino===this.#socketIdentity.ino)
     unlinkSync(this.#socketPath);
   }catch(e){if(e?.code!=="ENOENT")throw e;}
   this.#socketIdentity=null;
  }
  this.#created.clear();
 }
 get status(){
  return Object.freeze({listening:this.#server?.listening===true,
    pendingRooms:this.#created.size,...this.#broker.status});
 }
}
// One request per connection; caller validates private socket path.
export async function privateGrantRequest(socketPath,request){
 return new Promise((resolve,reject)=>{
  let done=false,buf="";
  const socket=net.connect({path:socketPath});
  socket.setTimeout(3000,()=>socket.destroy(Error("owner IPC timeout")));
  socket.on("connect",()=>socket.write(JSON.stringify(request)+"\n"));
  socket.on("data",data=>{
   buf+=data.toString("utf8");
   if(buf.length>4096){socket.destroy(Error("owner IPC overflow"));return;}
   const n=buf.indexOf("\n");
   if(n>=0&&!done){
    done=true;
    try{resolve(JSON.parse(buf.slice(0,n)));}
    catch(e){reject(e);}
    socket.end();
   }
  });
  socket.on("error",err=>{if(!done){done=true;reject(err);}});
  socket.on("close",()=>{if(!done){done=true;reject(Error("owner IPC closed"));}});
 });
}
