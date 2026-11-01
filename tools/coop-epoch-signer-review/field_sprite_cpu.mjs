// Research-only CPU port of PokéRogue FieldSprite fragment's time tint path.
// Never publish raw pixels, texture contents or uniforms through the public feed.
// Terrain recolor and non-neutral vertex tint remain unsupported (fail closed).
export const SCHEMA="sam.coop.field-tint-lab.v1";
const finite=n=>typeof n==="number"&&Number.isFinite(n);
const color=v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x)&&x>=0&&x<=1);
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
export function validateFieldUniforms(u){
  return !!u&&u.schema===SCHEMA&&finite(u.time)&&u.time>=0&&u.time<=1&&
    typeof u.ignoreTimeTint==="boolean"&&typeof u.isOutside==="boolean"&&
    [u.overrideTint,u.dayTint,u.duskTint,u.nightTint].every(color)&&
    u.terrainColorRatio===0&&u.tintMode==="neutral";
}
export function activeTimeTint(u){
  if(!validateFieldUniforms(u))throw Error("Unsupported FieldSprite shader state");
  if(u.ignoreTimeTint)return null;
  if(u.overrideTint.some(x=>x>0))return u.overrideTint;
  const t=u.time,day=u.dayTint,dusk=u.duskTint,night=u.nightTint;
  if(t<.25)return day;
  if(!u.isOutside&&t<.5)return lerp(day,night,(t-.25)/.25);
  if(t<.375)return lerp(day,dusk,(t-.25)/.125);
  if(t<.5)return lerp(dusk,night,(t-.375)/.125);
  if(t<.75)return night;
  if(!u.isOutside)return lerp(night,day,(t-.75)/.25);
  if(t<.875)return lerp(night,dusk,(t-.75)/.125);
  return lerp(dusk,day,(t-.875)/.125);
}
export function applyFieldTintData(data,u){
  const tint=activeTimeTint(u);
  if(!tint)return data;
  if(!data||!(data.length>=0)||data.length%4!==0)throw Error("Invalid RGBA buffer");
  for(let i=0;i<data.length;i+=4){
    if(data[i+3]===0)continue;
    for(let k=0;k<3;k++){
      const base=data[i+k]/255,blend=tint[k];
      const out=blend<.5?2*blend*base:1-2*(1-blend)*(1-base);
      data[i+k]=Math.min(255,Math.max(0,Math.round(out*255)));
    }
  }
  return data;
}
export function shadeFieldFrame(image,src,uniforms,makeCanvas){
  if(!validateFieldUniforms(uniforms)||!Array.isArray(src)||src.length!==4||
      !src.every(finite)||src[2]<1||src[3]<1||
      src[2]>4096||src[3]>4096)throw Error("Unsupported field frame");
  const [sx,sy,sw,sh]=src;
  const canvas=makeCanvas();
  canvas.width=Math.round(sw);canvas.height=Math.round(sh);
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  if(!ctx)throw Error("Canvas context unavailable");
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(image,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  const pixel=ctx.getImageData(0,0,canvas.width,canvas.height);
  applyFieldTintData(pixel.data,uniforms);
  ctx.putImageData(pixel,0,0);
  return canvas;
}
