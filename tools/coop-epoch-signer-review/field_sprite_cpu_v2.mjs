// Isolated CPU translation of supported PokéRogue FieldSprite GLSL operations.
// A pixel-level lab experiment, NOT an accepted network rendering protocol.
export const SCHEMA="sam.coop.field-tint-lab.v1";
const finite=n=>typeof n==="number"&&Number.isFinite(n);
const color=v=>Array.isArray(v)&&v.length===3&&v.every(x=>finite(x)&&x>=0&&x<=1);
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
export function validateFieldUniforms(u){
 return !!u&&u.schema===SCHEMA&&finite(u.time)&&u.time>=0&&u.time<=1&&
   typeof u.ignoreTimeTint==="boolean"&&typeof u.isOutside==="boolean"&&
   [u.overrideTint,u.dayTint,u.duskTint,u.nightTint,u.terrainColor].every(color)&&
   finite(u.terrainColorRatio)&&u.terrainColorRatio>=0&&u.terrainColorRatio<=1&&
   u.tintMode==="neutral";
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
const clampByte=v=>Math.max(0,Math.min(255,Math.round(v*255)));
export function rgb2hsl([r,g,b]){
 const mi=Math.min(r,g,b),ma=Math.max(r,g,b),delta=ma-mi,l=(ma+mi)*.5;
 if(delta===0)return [0,0,l];
 const s=l<.5?delta/(ma+mi):delta/(2-ma-mi);
 const dr=(((ma-r)/6)+(delta/2))/delta;
 const dg=(((ma-g)/6)+(delta/2))/delta;
 const db=(((ma-b)/6)+(delta/2))/delta;
 let h=r===ma?db-dg:g===ma?1/3+dr-db:2/3+dg-dr;
 if(h<0)h+=1;else if(h>1)h-=1;
 return [h,s,l];
}
function hue2rgb(f1,f2,h){
 if(h<0)h+=1;else if(h>1)h-=1;
 if(6*h<1)return f1+(f2-f1)*6*h;
 if(2*h<1)return f2;
 if(3*h<2)return f1+(f2-f1)*(2/3-h)*6;
 return f1;
}
export function hsl2rgb([h,s,l]){
 if(s===0)return [l,l,l];
 const f2=l<.5?l*(1+s):(l+s)-(l*s),f1=2*l-f2;
 return [hue2rgb(f1,f2,h+1/3),hue2rgb(f1,f2,h),
   hue2rgb(f1,f2,h-1/3)];
}
export function applyFieldTintData(data,u,geometry={}){
 const tint=activeTimeTint(u);
 if(!data||typeof data.length!=="number"||data.length%4!==0)
   throw Error("Invalid RGBA buffer");
 const width=geometry.width||0,sourceHeight=geometry.sourceHeight||0,
   sourceY=geometry.sourceY||0;
 const useTerrain=u.terrainColorRatio>0&&u.terrainColor.some(x=>x>0);
 if(useTerrain&&(!Number.isInteger(width)||width<1||width>4096||
   !Number.isInteger(sourceHeight)||sourceHeight<1||sourceHeight>4096||
   !finite(sourceY)||sourceY<0||sourceY>=sourceHeight))
   throw Error("Invalid terrain UV geometry");
 const terrainHue=useTerrain?rgb2hsl(u.terrainColor)[0]:0;
 for(let i=0;i<data.length;i+=4){
   if(data[i+3]===0)continue;
   let rgb=[data[i]/255,data[i+1]/255,data[i+2]/255];
   if(tint)rgb=rgb.map((base,k)=>{
      const blend=tint[k];
      return blend<.5?2*blend*base:1-2*(1-blend)*(1-base);
   });
   if(useTerrain){
     const y=Math.floor(i/4/width),v=(sourceY+y+.5)/sourceHeight;
     if((1-u.terrainColorRatio)<v){
       const hsl=rgb2hsl(rgb);
       rgb=hsl2rgb([terrainHue,hsl[1],hsl[2]]);
     }
   }
   for(let k=0;k<3;k++)data[i+k]=clampByte(rgb[k]);
 }
 return data;
}
export function shadeFieldFrame(image,src,u,makeCanvas){
 if(!validateFieldUniforms(u)||!Array.isArray(src)||src.length!==4||
   !src.every(finite)||src[2]<1||src[3]<1||src[2]>4096||src[3]>4096)
   throw Error("Unsupported FieldSprite source rectangle");
 const [sx,sy,sw,sh]=src;
 const canvas=makeCanvas();
 canvas.width=Math.round(sw);canvas.height=Math.round(sh);
 const ctx=canvas.getContext("2d",{willReadFrequently:true});
 if(!ctx)throw Error("Canvas context unavailable");
 ctx.imageSmoothingEnabled=false;
 ctx.drawImage(image,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
 applyFieldTintData(pixels.data,u,{width:canvas.width,sourceY:sy,
   sourceHeight:image.naturalHeight||image.height});
 ctx.putImageData(pixels,0,0);
 return canvas;
}
