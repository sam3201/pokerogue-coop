import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,createPublicKey,sign,verify} from "node:crypto";
import {
 mkdtempSync,writeFileSync,chmodSync,symlinkSync,
 linkSync,rmSync,statSync,renameSync
} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
 loadPrivateOwnerKey,ownerKeyFingerprint,checkOwnerPublicPin
} from "./owner_signing_key_custody_v1.mjs";
function setup(){
 const root=mkdtempSync(join(tmpdir(),"sam-keys-private-"));
 chmodSync(root,0o700);
 const file=join(root,"owner-ed25519.pk8");
 const keys=generateKeyPairSync("ed25519");
 const bytes=keys.privateKey.export({type:"pkcs8",format:"der"});
 writeFileSync(file,bytes,{mode:0o600});
 const expectedPublicKeyId=ownerKeyFingerprint(keys.publicKey);
 const opts={keyPath:file,privateDirectory:root,expectedPublicKeyId};
 return {root,file,keys,opts,bytes,
  close(){rmSync(root,{recursive:true,force:true});}
 };
}
test("0600 PKCS8 Ed25519 load verifies against out-of-band pinned public id",()=>{
 const x=setup();
 try{
  const key=loadPrivateOwnerKey(x.opts);
  assert.equal(key.keyId,x.opts.expectedPublicKeyId);
  assert.equal(checkOwnerPublicPin({
    publicKey:key.publicKey,
    expectedFingerprint:x.opts.expectedPublicKeyId}),true);
  const msg=Buffer.from("capture-owner test challenge");
  assert.equal(verify(null,msg,x.keys.publicKey,
    sign(null,msg,key.privateKey)),true);
  assert.equal(Object.keys(key).includes("privateKey"),true);
  assert.equal(statSync(x.file).mode&0o777,0o600);
 }finally{x.close();}
});
test("wrong pinned fingerprint is rejected even with a valid Ed25519 key",()=>{
 const x=setup();
 try{
  assert.throws(()=>loadPrivateOwnerKey({
   ...x.opts,expectedPublicKeyId:"f".repeat(64)
  }),/does not match pinned/);
  const other=generateKeyPairSync("ed25519").publicKey;
  assert.equal(checkOwnerPublicPin({
   publicKey:other,
   expectedFingerprint:x.opts.expectedPublicKeyId}),false);
 }finally{x.close();}
});
test("group-readable and world-readable files are rejected",()=>{
 const x=setup();
 try{
  for(const mode of [0o640,0o644,0o666,0o777]){
   chmodSync(x.file,mode);
   assert.throws(()=>loadPrivateOwnerKey(x.opts),
    /Private signing-key file unsafe/);
  }
 }finally{x.close();}
});
test("private directory with group or world access is rejected",()=>{
 const x=setup();
 try{
  chmodSync(x.root,0o755);
  assert.throws(()=>loadPrivateOwnerKey(x.opts),
   /Owner directory not private/);
 }finally{x.close();}
});
test("symlinked private key is rejected even if target bytes match",()=>{
 const x=setup();
 try{
  const old=join(x.root,"original.pk8");
  // Original key moved to another private path and symlinked back.
  renameSync(x.file,old);symlinkSync("original.pk8",x.file);
  assert.throws(()=>loadPrivateOwnerKey(x.opts),
    /Private signing-key file unsafe/);
 }finally{x.close();}
});
test("hardlinked key is rejected to prevent alias modification",()=>{
 const x=setup();
 try{
  linkSync(x.file,join(x.root,"other.pk8"));
  assert.throws(()=>loadPrivateOwnerKey(x.opts),
   /Private signing-key file unsafe/);
 }finally{x.close();}
});
test("wrong key path name, relative dir and missing key id rejected",()=>{
 const x=setup();
 try{
  assert.throws(()=>loadPrivateOwnerKey({
   ...x.opts,keyPath:join(x.root,"something-else.pk8")
  }),/Invalid signing-key configuration/);
  assert.throws(()=>loadPrivateOwnerKey({
   ...x.opts,privateDirectory:"."
  }),/Invalid signing-key configuration/);
  assert.throws(()=>loadPrivateOwnerKey({
   ...x.opts,expectedPublicKeyId:""
  }),/Invalid signing-key configuration/);
 }finally{x.close();}
});
test("malformed private DER and unrelated key algorithm rejected",()=>{
 const x=setup();
 try{
  writeFileSync(x.file,Buffer.alloc(100,7));
  assert.throws(()=>loadPrivateOwnerKey(x.opts),/Owner signing key rejected/);
  const ec=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  writeFileSync(x.file,ec.privateKey.export({format:"der",type:"pkcs8"}));
  assert.throws(()=>loadPrivateOwnerKey(x.opts),/Unexpected signing-key algorithm/);
 }finally{x.close();}
});
test("file size bounds reject empty and oversized key material",()=>{
 const x=setup();
 try{
  writeFileSync(x.file,Buffer.from([1,2,3]));
  assert.throws(()=>loadPrivateOwnerKey(x.opts),/Private signing-key file unsafe/);
  writeFileSync(x.file,Buffer.alloc(5000,1));
  assert.throws(()=>loadPrivateOwnerKey(x.opts),/Private signing-key file unsafe/);
 }finally{x.close();}
});
