// Private, display-only paired-frame presentation gate.
// Consumes preverified VerifiedPairCursor admissions. A press performs one
// synchronous DOM replacement of BOTH seats, never two asynchronous updates.
// There is no browser-issued authorization, capture, data fetch or producer
// backpressure here. It does not promote scenes to production authority.
export class PairedFramePresenter {
 #root;#cursor;#renderSeat;#prepared=null;
 constructor({root,cursor,renderSeat}={}){
  if(!root||root.nodeType!==1||!root.ownerDocument||
     typeof root.replaceChildren!=="function"||
     !cursor||typeof cursor.nextReady!=="function"||
     typeof cursor.commitNext!=="function"||
     typeof cursor.reset!=="function"||
     typeof renderSeat!=="function")
   throw Error("Invalid paired display controller");
  this.#root=root;this.#cursor=cursor;this.#renderSeat=renderSeat;
 }
 get status(){
  const c=this.#cursor.status;
  return Object.freeze({step:c.step,frameId:c.frameId,
   ready:this.#prepared!==null,queued:c.queued,
   waiting:c.waiting,preparedFrameId:this.#prepared?.frameId??null});
 }
 prepareNext(){
  const pair=this.#cursor.nextReady();
  if(!pair){this.#prepared=null;return false;}
  if(this.#prepared?.admissionId===pair.admissionId&&
     this.#prepared.frameId===pair.frameId)return true;
  if(typeof pair.frameId!=="string"||
     !Number.isSafeInteger(pair.admissionId)||
     pair.admissionId<1||!pair.seats?.sam||!pair.seats?.jevbot||
     !(pair.textures instanceof Map))
    throw Error("Unverified paired display admission");
  const doc=this.#root.ownerDocument;
  const prior=Array.from(this.#root.childNodes);
  const pane=doc.createElement("section");
  pane.dataset.pairFrameId=pair.frameId;
  pane.dataset.pairAdmission=String(pair.admissionId);
  pane.className="sam-private-paired-frame";
  // Construct a complete, detached two-seat DOM tree. Neither half can
  // become visible until the ONE replaceChildren() performed on a press.
  for(const seat of ["sam","jevbot"]){
   const slot=doc.createElement("div");
   slot.dataset.seat=seat;
   slot.dataset.frameId=pair.frameId;
   slot.className="sam-private-paired-seat";
   const node=this.#renderSeat({
    seat,scene:pair.seats[seat],textures:pair.textures,
    frameId:pair.frameId,sequence:pair.sequence,runId:pair.runId,
    admissionId:pair.admissionId
   });
   if(!node||node.nodeType!==1||node.ownerDocument!==doc||
      node.parentNode!==null||node.isConnected||
      typeof node.then==="function")
    throw Error("Both seat renderers must return detached synchronous DOM nodes");
   slot.appendChild(node);
   pane.appendChild(slot);
  }
  const now=Array.from(this.#root.childNodes);
  if(now.length!==prior.length||now.some((n,i)=>n!==prior[i]))
    throw Error("Renderer changed the visible surface while preparing");
  this.#prepared={pane,frameId:pair.frameId,
    admissionId:pair.admissionId};
  return true;
 }
 // Wire this directly to a manual Next button. No timers, awaits, frame
 // skipping or asynchronous seat swaps. If pre-rendering is incomplete,
 // leave the currently visible frame unchanged.
 pressNext(){
  const staged=this.#prepared;
  if(!staged)return null;
  const next=this.#cursor.nextReady();
  if(!next||next.admissionId!==staged.admissionId||
     next.frameId!==staged.frameId){
   this.#prepared=null;
   return null;
  }
  const previous=Array.from(this.#root.childNodes);
  // DOM mutation and cursor acceptance run in the same JS task. A browser
  // cannot paint an intermediate state between these synchronous calls.
  this.#root.replaceChildren(staged.pane);
  let accepted;
  try{
   accepted=this.#cursor.commitNext(staged.frameId,staged.admissionId);
  }catch(error){
   this.#root.replaceChildren(...previous);
   this.#prepared=null;
   throw error;
  }
  this.#prepared=null;
  return Object.freeze({step:accepted.step,frameId:accepted.frameId,
    sequence:accepted.sequence,runId:accepted.runId,
    previousFrameId:accepted.previousFrameId});
 }
 // Forget a detached but not-yet-presented pane without changing
 // the current visible DOM. The coordinator discards its paired cursor
 // and receiver admissions separately, then may safely restage.
 cancelPrepared(){
  this.#prepared=null;
  return this.status;
 }
 reset(){
  this.#cursor.reset(); // A pending verification correctly blocks reset.
  this.#prepared=null;
  this.#root.replaceChildren();
  return this.status;
 }
}
