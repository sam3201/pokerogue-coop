// Atomic private Pi lab staging. Not a web publisher. All writes confined
// to the experimental_render/texture-staging subtree.
import {mkdirSync,readFileSync,existsSync,lstatSync,writeFileSync,
  openSync,closeSync,renameSync,unlinkSync} from "node:fs";
import {dirname,resolve,join,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {validateRegistry,verifyTexture,sha256} from "./texture_registry_v1.mjs";
const LAB_ROOT=dirname(fileURLToPath(import.meta.url));
const PRIVATE_ROOT=resolve(LAB_ROOT,"texture-staging");
function guardedDirectory(folder){
 const path=resolve(folder);
 if(path!==PRIVATE_ROOT&&!path.startsWith(PRIVATE_ROOT+sep))
   throw Error("Refusing staging outside private texture lab");
 mkdirSync(PRIVATE_ROOT,{recursive:true,mode:0o700});
 let p=PRIVATE_ROOT;
 if(lstatSync(p).isSymbolicLink())throw Error("Symlinked private root");
 const rest=path.slice(PRIVATE_ROOT.length).split(sep).filter(Boolean);
 for(const segment of rest){
  if(!/^[A-Za-z0-9_-]{1,48}$/.test(segment))throw Error("Unsafe stage directory");
  p=join(p,segment);
  mkdirSync(p,{recursive:true,mode:0o700});
  if(lstatSync(p).isSymbolicLink())throw Error("Symlink in private staging");
 }
 return path;
}
function writeAtomic(file,bytes){
 const tmp=file+".tmp-"+randomBytes(8).toString("hex");
 let fd;
 try{
  fd=openSync(tmp,"wx",0o600);
  writeFileSync(fd,bytes);closeSync(fd);fd=undefined;
  renameSync(tmp,file);
 }finally{
  if(fd!==undefined)closeSync(fd);
  if(existsSync(tmp))unlinkSync(tmp);
 }
}
export function stagePrivateRegistry(bundle,dir){
 const m=bundle?.manifest,files=bundle?.files;
 if(!validateRegistry(m)||!(files instanceof Map)||
    files.size!==m.textures.length)throw Error("Invalid staged registry");
 // Validate every byte before creating any directories.
 for(const row of m.textures){
  const raw=files.get(row.sha256);
  if(!raw||!verifyTexture(m,row.href,raw))
   throw Error("Unverified texture in staging request");
 }
 const root=guardedDirectory(dir),staged=[];
 for(const row of m.textures){
  const target=join(root,row.sha256+".png");
  if(existsSync(target)){
   if(lstatSync(target).isSymbolicLink() ||
      !verifyTexture(m,row.href,readFileSync(target)))
     throw Error("Existing staged image conflicts with approved digest");
  }else writeAtomic(target,files.get(row.sha256));
  staged.push(target);
 }
 const manifestFile=join(root,"manifest.json");
 if(existsSync(manifestFile)){
  if(lstatSync(manifestFile).isSymbolicLink() ||
    sha256(readFileSync(manifestFile))!==
       sha256(Buffer.from(JSON.stringify(m,null,2)+"\n")))
    throw Error("Existing manifest differs");
 }else writeAtomic(manifestFile,Buffer.from(JSON.stringify(m,null,2)+"\n"));
 return {scope:"private-only",count:staged.length,
    manifestDigest:m.digest,manifestFile,files:staged};
}
