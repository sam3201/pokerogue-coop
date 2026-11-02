// Isolated owner-side Ed25519 key custody contract.
// No production key creation and no relay source modification.
// Production owner must provision and distribute the pinned public fingerprint
// through a separately reviewed, authenticated configuration path.
import {
  openSync,readFileSync,closeSync,fstatSync,lstatSync,realpathSync,
  constants as fsC
} from "node:fs";
import {resolve,dirname,basename} from "node:path";
import {createPrivateKey,createPublicKey,createHash} from "node:crypto";

const SHA256=/^[a-f0-9]{64}$/;
const sha=buf=>createHash("sha256").update(buf).digest("hex");
export function ownerKeyFingerprint(publicKey){
 if(publicKey?.type!=="public"||publicKey.asymmetricKeyType!=="ed25519")
  throw Error("Expected a public Ed25519 key");
 return sha(publicKey.export({type:"spki",format:"der"}));
}
function assertSafeDirectory(path){
 if(typeof path!=="string"||resolve(path)!==path)throw Error("Owner directory not absolute");
 const st=lstatSync(path);
 if(!st.isDirectory()||st.isSymbolicLink()||
    realpathSync(path)!==path||st.uid!==process.getuid()||
    (st.mode&0o077)!==0)
  throw Error("Owner directory not private");
}
export function loadPrivateOwnerKey({
  keyPath,privateDirectory,expectedPublicKeyId
}={}){
 if(typeof privateDirectory!=="string"||
    typeof keyPath!=="string"||
    dirname(keyPath)!==privateDirectory||
    basename(keyPath)!=="owner-ed25519.pk8"||
    !SHA256.test(expectedPublicKeyId||""))
  throw Error("Invalid signing-key configuration");
 assertSafeDirectory(privateDirectory);
 const before=lstatSync(keyPath,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||
    before.nlink!==1n||before.uid!==BigInt(process.getuid())||
    (before.mode&0o177n)!==0n||
    before.size<40n||before.size>4096n)
  throw Error("Private signing-key file unsafe");
 // Prevent following symlink swaps between the lstat and open.
 const descriptor=openSync(keyPath,
   fsC.O_RDONLY|fsC.O_NOFOLLOW|fsC.O_CLOEXEC);
 let material=null;
 try{
  const fromFd=fstatSync(descriptor,{bigint:true});
  if(!fromFd.isFile()||fromFd.nlink!==1n||
     fromFd.uid!==before.uid||
     (fromFd.mode&0o177n)!==0n||
     fromFd.dev!==before.dev||fromFd.ino!==before.ino||
     fromFd.size!==before.size)
    throw Error("Signing-key race or permissions");
  material=readFileSync(descriptor);
  const after=fstatSync(descriptor,{bigint:true});
  if(material.length!==Number(before.size)||
     after.dev!==before.dev||after.ino!==before.ino||
     after.size!==before.size||
     after.mtimeNs!==fromFd.mtimeNs||
     after.ctimeNs!==fromFd.ctimeNs)
    throw Error("Signing-key changed during read");
  let privateKey,publicKey;
  try{
   privateKey=createPrivateKey({
     key:material,format:"der",type:"pkcs8"
   });
   if(privateKey.type!=="private"||
      privateKey.asymmetricKeyType!=="ed25519")
    throw Error("Unexpected signing-key algorithm");
   publicKey=createPublicKey(privateKey);
   if(ownerKeyFingerprint(publicKey)!==expectedPublicKeyId)
    throw Error("Private signer does not match pinned public key");
  }catch(e){
   throw Error("Owner signing key rejected: "+e.message);
  }
  // Keep only Node's protected KeyObject; do not retain raw file bytes.
  const result=Object.freeze({
   privateKey,publicKey,keyId:expectedPublicKeyId
  });
  return result;
 }finally{
  if(material)material.fill(0);
  closeSync(descriptor);
 }
}
// Review a candidate public signing key BEFORE owner private-key enrollment.
// Never infer trust from a public key accompanying the private key.
export function checkOwnerPublicPin({
 publicKey,expectedFingerprint
}={}){
 return SHA256.test(expectedFingerprint||"")&&
   ownerKeyFingerprint(publicKey)===expectedFingerprint;
}
