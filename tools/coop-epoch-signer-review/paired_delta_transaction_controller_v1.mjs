// Isolated, review-only supervisor for receiver -> verified cursor ->
// detached seat preparation -> ONE atomic paired DOM commit.
// The receiver baseline moves ONLY after the presenter commits BOTH seats.
// No game-producer authority, privileged provisioning or network access.
import {VerifiedPairCursor} from "./paired_frame_cursor_v1.mjs";
import {PairedFramePresenter} from "./paired_frame_presenter_v1.mjs";

export class PairedDeltaTransactionController {
 #receiver;#cursor;#viewer;#active=null;#busy=false;#poisoned=false;
 constructor({receiver,root,renderSeat}={}){
  if(!receiver||typeof receiver.stage!=="function"||
     typeof receiver.commit!=="function"||
     typeof receiver.discard!=="function"||
     typeof receiver.beginNewRun!=="function"||
     typeof receiver.status!=="object"||
     typeof renderSeat!=="function")
   throw Error("A trusted paired receiver and seat renderer are required");
  this.#receiver=receiver;
  this.#cursor=new VerifiedPairCursor({
   verifier:input=>this.#receiver.stage(input)
  });
  this.#viewer=new PairedFramePresenter({
   root,cursor:this.#cursor,renderSeat
  });
 }
 get status(){
  const c=this.#cursor.status,r=this.#receiver.status,v=this.#viewer.status;
  return Object.freeze({
   runId:r.runId,committedFrameId:r.committedFrameId,
   committedSequence:r.committedSequence,
   visibleFrameId:c.frameId,
   visibleStep:v.step,ready:v.ready,
   pendingFrameId:this.#active?.frameId??null,
   busy:this.#busy,poisoned:this.#poisoned,
   productionSceneEligible:false
  });
 }
 #checkReady(){
  const a=this.#active;
  const p=this.#cursor.nextReady();
  const r=this.#receiver.status;
  const v=this.#viewer.status;
  if(!a||!p||!v.ready||
     p.admissionId!==a.cursorAdmission||
     p.frameId!==a.frameId||
     r.pendingAdmission!==a.receiverAdmission||
     r.pendingFrameId!==a.frameId||
     v.preparedFrameId!==a.frameId)
   throw Error("Paired delta transaction admissions diverged");
  return p;
 }
 // Internal nonvisible rollback. If the cursor itself refused the
 // verified result after receiver admission, only receiver has a
 // pending frame; both halves are still cleaned.
 #discard(){
  this.#viewer.cancelPrepared();
  const staged=this.#cursor.nextReady();
  if(staged)this.#cursor.discardPending(
   staged.frameId,staged.admissionId);
  if(this.#receiver.status.pendingFrameId)this.#receiver.discard();
  this.#active=null;
 }
 async stage(wire){
  if(this.#busy||this.#poisoned)
   throw Error("Paired delta controller unavailable");
  if(this.#active||this.#receiver.status.pendingFrameId)
   throw Error("Commit or discard the current paired frame first");
  this.#busy=true;
  try{
   await this.#cursor.stage(wire);
   const pair=this.#cursor.nextReady();
   const receiver=this.#receiver.status;
   if(!pair||!Number.isSafeInteger(pair.admissionId)||
      !Number.isSafeInteger(receiver.pendingAdmission)||
      receiver.pendingFrameId!==pair.frameId||
      receiver.runId!==pair.runId||
      pair.sequence!==(receiver.committedSequence??0)+1)
    throw Error("Receiver and viewer admission identities disagree");
   this.#active={
    frameId:pair.frameId,runId:pair.runId,sequence:pair.sequence,
    cursorAdmission:pair.admissionId,
    receiverAdmission:receiver.pendingAdmission
   };
   if(this.#viewer.prepareNext()!==true)
    throw Error("Both seats were not prepared synchronously");
   this.#checkReady();
   return this.status;
  }catch(error){
   try{this.#discard();}
   catch(cleanupError){
    this.#poisoned=true;
    throw new AggregateError([error,cleanupError],
     "Paired delta rollback failed: explicit recovery required");
   }
   throw error;
  }finally{this.#busy=false;}
 }
 // The owner invokes this on a real user Next press. It performs no
 // async work: no event can interleave between the DOM swap and the
 // trusted baseline commit.
 pressNext(){
  if(this.#busy||this.#poisoned)
   throw Error("Paired delta controller unavailable");
  if(!this.#active)return null;
  const pair=this.#checkReady();
  const a=this.#active;
  let accepted;
  try{
   accepted=this.#viewer.pressNext();
   if(!accepted||accepted.frameId!==a.frameId||
      accepted.sequence!==a.sequence||
      accepted.runId!==a.runId)
    throw Error("Paired viewer did not commit the expected frame");
   this.#receiver.commit({
    frameId:accepted.frameId,sequence:accepted.sequence,
    admissionId:a.receiverAdmission
   });
  }catch(error){
   // If the cursor already committed but the receiver did not, there
   // is no safe same-run rollback. Fail CLOSED: blank the view and
   // require an owner-authorized fresh run/keyframe.
   this.#poisoned=true;
   try{this.#viewer.reset();}catch{/* remain poisoned */}
   try{this.#receiver.discard();}catch{/* remain poisoned */}
   this.#active=null;
   throw Error("Paired frame transaction failed; fresh-run recovery required",
    {cause:error});
  }
  this.#active=null;
  return Object.freeze({...accepted,productionSceneEligible:false});
 }
 // Pre-press cancellation leaves the prior visible/committed frame intact.
 cancelPending(){
  if(this.#busy||this.#poisoned)
   throw Error("Cannot cancel while verification/recovery is blocked");
  try{this.#discard();}
  catch(error){this.#poisoned=true;throw error;}
  return this.status;
 }
 // Requires an independently owner-provisioned fresh run ID. Callers
 // should not generate one from untrusted packets or browser UI input.
 recoverNewRun(trustedRunId){
  if(this.#busy||this.#cursor.status.waiting)
   throw Error("Cannot recover during paired verification");
  if(this.#active||this.#receiver.status.pendingFrameId)
   throw Error("Cancel pending pair before owner-authorized recovery");
  // Validate the fresh run ID first; do not clear the display on
  // rejected or previously spent IDs.
  this.#receiver.beginNewRun(trustedRunId);
  try{this.#viewer.reset();this.#poisoned=false;}
  catch(error){
   this.#poisoned=true;
   throw Error("Viewer reset failed during trusted run recovery",
    {cause:error});
  }
  this.#active=null;
  return this.status;
 }
}
