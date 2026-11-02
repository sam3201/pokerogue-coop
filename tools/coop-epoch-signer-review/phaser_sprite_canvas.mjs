// Experimental local compositor. Not deployed without pixel-fidelity acceptance.
export const SCHEMA="sam.coop.phaser-sprites.probe.v1";
const number=x=>typeof x==="number"&&Number.isFinite(x);
const arr=(x,n)=>Array.isArray(x)&&x.length===n&&x.every(v=>number(v)&&Math.abs(v)<100000);
const texture=s=>typeof s==="string"&&/^\/images\/(?!.*(?:\.\.|%2f|%5c))[A-Za-z0-9_./-]+\.(?:png|webp)$/i.test(s);
export function validateSpriteScene(scene,{allowLabMemory=false}={}) {
  if (!scene||scene.schema!==SCHEMA||scene.visualScope!=="partial-original-sprites"||
      (scene.labOnly === true && !allowLabMemory)||
      !scene.camera||!Array.isArray(scene.commands)||scene.commands.length>320||
      !scene.coverage||scene.coverage.captured!==scene.commands.length||
      !scene.coverage.approximated ||
      !["fieldShader","geometryMask","spriteBase","spriteShadow"].every(k=>
        Number.isInteger(scene.coverage.approximated[k]) &&
        scene.coverage.approximated[k]>=0 &&
        scene.coverage.approximated[k]<=320) ||
      (scene.coverage.complete === true && (
        scene.coverage.truncated===true ||
        Object.values(scene.coverage.approximated).some(v=>v>0) ||
        Object.entries(scene.coverage.skipped||{}).some(
          ([reason,count])=>reason!=="hidden" && count>0))) ||
      scene.camera.width!==1920||scene.camera.height!==1080||
      ![scene.camera.x,scene.camera.y,scene.camera.scrollX,
        scene.camera.scrollY,scene.camera.zoom].every(number)||
      scene.camera.zoom<=0||scene.camera.zoom>8||JSON.stringify(scene).length>96000) return false;
  return scene.commands.every(c=>
    arr(c?.src,4)&&arr(c?.dst,4)&&
    (c?.op==="sprite" ? c.borders===undefined :
      c?.op==="nineSlice" && arr(c.borders,4) &&
      c.borders.every(v=>v>=0) &&
      c.borders[0]+c.borders[1]<=c.src[2] &&
      c.borders[2]+c.borders[3]<=c.src[3] &&
      c.borders[0]+c.borders[1]<=c.dst[2] &&
      c.borders[2]+c.borders[3]<=c.dst[3]) &&
    texture(c.texture)&&
    (!c.shadow || (allowLabMemory===true&&arr(c.shadow,4)&&
      c.shadow[2]>0&&c.shadow[3]>0&&
      c.shadow[2]<=4096&&c.shadow[3]<=4096))&&
    (!c.shader || (allowLabMemory===true &&
      c.shader.schema==="sam.coop.field-tint-lab.v1" &&
      number(c.shader.time)&&c.shader.time>=0&&c.shader.time<=1&&
      c.shader.tintMode==="neutral"&&number(c.shader.terrainColorRatio)&&
      c.shader.terrainColorRatio>=0&&c.shader.terrainColorRatio<=1&&
      typeof c.shader.ignoreTimeTint==="boolean"&&
      typeof c.shader.isOutside==="boolean"&&
      [c.shader.overrideTint,c.shader.dayTint,c.shader.duskTint,
        c.shader.nightTint,c.shader.terrainColor].every(v=>Array.isArray(v)&&v.length===3&&
        v.every(x=>number(x)&&x>=0&&x<=1))))&&
    (!c.clip || (allowLabMemory===true &&
      typeof c.clip.inverted==="boolean" &&
      arr(c.clip.matrix,6)&&arr(c.clip.scroll,2)&&
      c.clip.scroll.every(v=>v>=0&&v<=4) &&
      ((c.clip.polygons===undefined&&arr(c.clip.rect,4)&&
        c.clip.rect[2]>0&&c.clip.rect[3]>0) ||
       (c.clip.rect===undefined&&Array.isArray(c.clip.polygons)&&
        c.clip.polygons.length>=1&&c.clip.polygons.length<=32 &&
        c.clip.polygons.every(path=>Array.isArray(path)&&
          path.length>=6&&path.length<=62&&path.length%2===0&&
          path.every(v=>number(v)&&Math.abs(v)<100000)))))) &&
    arr(c.src,4)&&arr(c.dst,4)&&arr(c.matrix,6)&&arr(c.scroll,2)&&
    c.src[0]>=0&&c.src[1]>=0&&c.src[2]>0&&c.src[3]>0&&
    c.dst[2]>0&&c.dst[3]>0&&number(c.alpha)&&c.alpha>0&&c.alpha<=1&&
    typeof c.flipX==="boolean"&&typeof c.flipY==="boolean"&&
    c.scroll.every(x=>x>=0&&x<=4));
}
function drawNineSlice(ctx,image,command) {
  const [sx,sy,sw,sh]=command.src;
  const [dx,dy,dw,dh]=command.dst;
  const [left,right,top,bottom]=command.borders;
  const xSrc=[sx,sx+left,sx+sw-right],xSrcWidth=[left,sw-left-right,right];
  const ySrc=[sy,sy+top,sy+sh-bottom],ySrcHeight=[top,sh-top-bottom,bottom];
  const xDst=[dx,dx+left,dx+dw-right],xDstWidth=[left,dw-left-right,right];
  const yDst=[dy,dy+top,dy+dh-bottom],yDstHeight=[top,dh-top-bottom,bottom];
  for(let row=0;row<3;row++) {
    if(ySrcHeight[row]<=0 || yDstHeight[row]<=0) continue;
    for(let col=0;col<3;col++) {
      if(xSrcWidth[col]<=0 || xDstWidth[col]<=0) continue;
      ctx.drawImage(image,xSrc[col],ySrc[row],xSrcWidth[col],ySrcHeight[row],
        xDst[col],yDst[row],xDstWidth[col],yDstHeight[row]);
    }
  }
}
export class PhaserSpriteCanvas {
  constructor(canvas,imageLoader) {
    this.canvas=canvas;this.imageLoader=imageLoader;this.cache=new Map();
    this.shadedCache=new Map();this.epoch=0;
  }
  clearCache(){
    this.epoch++;this.cache.clear();this.shadedCache.clear();
  }
  async render(scene,{allowPartial=false,allowLabMemory=false,labSmoothingOverride=false,labOutputWidth=320,labShaderProcessor=null}={}) {
    if (!validateSpriteScene(scene,{allowLabMemory})) return {ok:false,reason:"invalid-protocol"};
    if (![320,640].includes(labOutputWidth)) return {ok:false,reason:"unsupported-output-size"};
    if (scene.commands.length===0) return {ok:false,reason:"empty-scene"};
    if (!allowPartial&&!scene.coverage.complete)
      return {ok:false,reason:"unaccepted-coverage",coverage:scene.coverage};
    const epoch=++this.epoch, textures=[...new Set(scene.commands.map(c=>c.texture))];
    if (textures.length>64) return {ok:false,reason:"texture-budget"};
    for(const key of textures) if(!this.cache.has(key))
      this.cache.set(key,Promise.resolve().then(()=>this.imageLoader(key)));
    let images;
    try {images=await Promise.all(textures.map(key=>this.cache.get(key)));}
    catch {return {ok:false,reason:"missing-asset"};}
    if(epoch!==this.epoch) return {ok:false,reason:"superseded"};
    const byKey=new Map(textures.map((key,i)=>[key,images[i]]));
    if(images.some(x=>!x||!(x.width>0&&x.height>0)))
      return {ok:false,reason:"invalid-image"};
    const ctx=this.canvas.getContext("2d",{alpha:false});
    if(!ctx) return {ok:false,reason:"no-canvas-context"};
    const labOutputHeight=labOutputWidth*9/16;
    this.canvas.width=labOutputWidth;this.canvas.height=labOutputHeight;
    const camera=scene.camera,sf=labOutputWidth/camera.width;
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,labOutputWidth,labOutputHeight);
    ctx.imageSmoothingEnabled=labSmoothingOverride===true;
    for(const command of scene.commands) {
      const [a,b,c,d,tx,ty]=command.matrix;
      const [scrollX,scrollY]=command.scroll;
      const scale=sf*camera.zoom;
      if(command.clip){
        const clip=command.clip;
        const [ca,cb,cc,cd,ctxX,ctxY]=clip.matrix;
        const [clipScrollX,clipScrollY]=clip.scroll;
        ctx.save();
        if(clip.inverted){
          ctx.setTransform(1,0,0,1,0,0);
          ctx.beginPath();
          ctx.rect(0,0,labOutputWidth,labOutputHeight);
        }
        ctx.setTransform(scale*ca,scale*cb,scale*cc,scale*cd,
          sf*camera.x+scale*(ctxX-camera.scrollX*clipScrollX),
          sf*camera.y+scale*(ctxY-camera.scrollY*clipScrollY));
        if(!clip.inverted)ctx.beginPath();
        if(Array.isArray(clip.polygons)) {
          for(const path of clip.polygons) {
            ctx.moveTo(path[0],path[1]);
            for(let p=2;p<path.length;p+=2) ctx.lineTo(path[p],path[p+1]);
            ctx.closePath();
          }
        } else ctx.rect(...clip.rect);
        ctx.clip(clip.inverted?"evenodd":"nonzero");
      }
      if(command.shadow){
        const [x,y,rx,ry]=command.shadow;
        ctx.save();
        ctx.setTransform(scale,0,0,scale,
          sf*camera.x-scale*camera.scrollX*scrollX,
          sf*camera.y-scale*camera.scrollY*scrollY);
        ctx.globalAlpha=.5;ctx.fillStyle="#000000";
        ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill();
        ctx.restore();
      }
      ctx.setTransform(scale*a,scale*b,scale*c,scale*d,
        sf*camera.x+scale*(tx-camera.scrollX*scrollX),
        sf*camera.y+scale*(ty-camera.scrollY*scrollY));
      ctx.globalAlpha=command.alpha;
      if(command.flipX||command.flipY)ctx.scale(command.flipX?-1:1,command.flipY?-1:1);
      let textureImage=byKey.get(command.texture);
      let src=command.src;
      if(command.shader&&typeof labShaderProcessor==="function"){
        const key=JSON.stringify([command.texture,src,command.shader]);
        try {
          if(!this.shadedCache.has(key)){
            const promise=Promise.resolve().then(()=>labShaderProcessor(
              textureImage,src,command.shader));
            this.shadedCache.set(key,promise);
            if(this.shadedCache.size>64)
              this.shadedCache.delete(this.shadedCache.keys().next().value);
          }
          textureImage=await this.shadedCache.get(key);
          src=[0,0,src[2],src[3]];
        } catch {
          this.shadedCache.delete(key);
          ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
          if(command.clip) ctx.restore();
          return {ok:false,reason:"unsupported-field-shader"};
        }
      }
      if(command.op==="nineSlice"){
        drawNineSlice(ctx,textureImage,{...command,src});
      } else ctx.drawImage(textureImage,...src,...command.dst);
      if(command.clip) ctx.restore();
    }
    ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;
    return {ok:true,commands:scene.commands.length,coverage:scene.coverage};
  }
}
export function browserImageLoader(path) {
  if(!texture(path))throw Error("Unsafe texture path");
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>resolve(img);
    img.onerror=()=>reject(Error("Texture missing"));
    img.src=path;
  });
}
