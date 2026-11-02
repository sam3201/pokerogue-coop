// Experimental, read-only Phaser display-list serializer.
// Not a public exporter; run only after co-op clients are linked.
// It NEVER exports game state, UI text, room codes, cookies or model traces.
// Unsupported draws are counted rather than silently painted incorrectly.
export const SCHEMA = "sam.coop.phaser-sprites.probe.v1";
const MAX_OBJECTS = 320;
const MAX_TEXTURES = 64;
const finite = value => typeof value === "number" && Number.isFinite(value);
const bounded = (n, limit = 100000) => finite(n) && Math.abs(n) <= limit;
const n = value => { const rounded=Math.round(value * 10000) / 10000;
  return Object.is(rounded,-0) ? 0 : rounded; };

function assetPath(raw) {
  if (typeof raw !== "string") return null;
  try {
    const trustedOrigin = globalThis.location?.origin;
    if (typeof trustedOrigin !== "string" || !/^https?:\/\//.test(trustedOrigin)) return null;
    const u = new URL(raw, trustedOrigin);
    // Never turn a third-party URL into a same-origin browser asset request.
    if (u.origin !== trustedOrigin) return null;
    // No cross-origin proxying, data URLs, or arbitrary application resources.
    if (!/\/(?:assets\/)?images\/[A-Za-z0-9_./-]+\.(?:png|webp)$/i.test(u.pathname) ||
        u.pathname.includes("..") || /%2f|%5c/i.test(u.pathname)) return null;
    const pos = u.pathname.indexOf("/images/");
    return pos >= 0 ? u.pathname.slice(pos) : null;
  } catch { return null; }
}

// Render only well-defined, bounded rectangular stencil masks. Never serialize
// arbitrary Phaser Graphics commands, JavaScript, or textual game content.
function rectangularStencil(obj) {
  const m=obj?.mask;
  if (!m || m.constructor?.name!=="GeometryMask") return null;
  const geometry=m.geometryMask;
  if (!geometry || typeof geometry.getWorldTransformMatrix!=="function") return null;
  let bounds, polygons=null;
  if (geometry.type==="Rectangle") {
    bounds=[-geometry.displayOriginX,-geometry.displayOriginY,
      geometry.width,geometry.height];
  } else if(geometry.type==="Graphics") {
    const ops=geometry.commandBuffer;
    if (Array.isArray(ops) && ops.length>0 && ops.length<=32) {
      let rect=null;
      for (let i=0;i<ops.length;) {
        const op=ops[i++];
        if (op===1) continue; // BEGIN_PATH
        if (op===7) { // FILL_STYLE,color,alpha
          if(i+2>ops.length) return null;
          i+=2; continue;
        }
        if (op===3) { // exactly one filled rectangle
          if(rect || i+4>ops.length) return null;
          rect=ops.slice(i,i+4);i+=4;continue;
        }
        return null;
      }
      bounds=rect;
    } else if (geometry.geom && typeof geometry.geom==="object") {
      const shapes=Array.isArray(geometry.geom)?geometry.geom:Object.values(geometry.geom);
      if(shapes.length<1 || shapes.length>32) return null;
      polygons=[];
      for(const shape of shapes) {
        if (shape?.isFilled!==true) continue;
        const path=shape.pathData;
        if (!Array.isArray(path)||path.length<8||path.length>64||
            path.length%2!==0||!path.every(v=>bounded(v,100000))) return null;
        if (path[0]!==path[path.length-2] ||
            path[1]!==path[path.length-1]) return null;
        polygons.push(path.slice(0,-2).map(n));
      }
      if(polygons.length===0) return null;
      if(m.invertAlpha && polygons.length>1) {
        const rects=[];
        for(const path of polygons) {
          if(path.length!==8) return null;
          const xs=[path[0],path[2],path[4],path[6]];
          const ys=[path[1],path[3],path[5],path[7]];
          const x0=Math.min(...xs),x1=Math.max(...xs);
          const y0=Math.min(...ys),y1=Math.max(...ys);
          if(x1<=x0||y1<=y0) return null;
          if(!xs.every(x=>x===x0||x===x1) ||
             !ys.every(y=>y===y0||y===y1)) return null;
          for(const r of rects){
            if(Math.min(r[2],x1)>Math.max(r[0],x0) &&
               Math.min(r[3],y1)>Math.max(r[1],y0)) return null;
          }
          rects.push([x0,y0,x1,y1]);
        }
      }
    } else return null;
  } else return null;
  if (!polygons && (!Array.isArray(bounds) || bounds.length!==4 ||
      !bounds.every(v=>bounded(v,100000)) || bounds[2]<=0 || bounds[3]<=0)) return null;
  const mat=geometry.getWorldTransformMatrix();
  const matrix=[mat?.a,mat?.b,mat?.c,mat?.d,mat?.tx,mat?.ty];
  const scroll=[geometry.scrollFactorX??1,geometry.scrollFactorY??1];
  if (![...matrix,...scroll].every(v=>bounded(v,100000)) ||
      scroll.some(v=>v<0||v>4)) return null;
  return {...(polygons?{polygons}:{rect:bounds.map(n)}),
    inverted:!!m.invertAlpha,matrix:matrix.map(n),scroll:scroll.map(n)};
}

function projectSpriteShadow(obj){
  if(!obj?.pipelineData?.hasShadow)return null;
  const parent=obj.parentContainer;
  const entity=["Pokemon","Trainer","MysteryEncounterIntroVisuals"].includes(
    parent?.constructor?.name);
  const field=entity?parent?.parentContainer:parent;
  if(!field || !finite(field.scale) || field.scale<=0)return null;
  const fieldScale=field.scale;
  const scale=entity?parent?.scale:obj.scale;
  if(!finite(scale)||scale<=0)return null;
  const ratioX=field.x/fieldScale,ratioY=field.y/fieldScale;
  const ignore=!!obj.pipelineData.ignoreFieldPos;
  let x=entity?parent.x:obj.x,y=entity?parent.y:obj.y;
  x+=ratioX;y+=ratioY;
  x+=-(obj.width-obj.frame.width)/2+obj.frame.x+
    (ignore?0:obj.x-field.x);
  if(obj.originY===.5){
    y+=(obj.height/2)*(scale-1)+(ignore?0:obj.y-field.y);
  }
  const yOffset=obj.height-obj.frame.height*scale;
  const width=obj.frame.width-yOffset/2;
  const yShadowOffset=obj.pipelineData.yShadowOffset??0;
  // SpritePipeline shader: spriteX=...+0.5, spriteY=... + origin shift.
  const centerX=x*fieldScale;
  const centerY=(y+yShadowOffset+
    (.975-(obj.originY===.5?.5:1))*obj.height)*fieldScale;
  const rx=width*.5*fieldScale;
  const ry=obj.height*.075*fieldScale;
  const vals=[centerX,centerY,rx,ry];
  if(!vals.every(v=>bounded(v,100000))||rx<=0||ry<=0||rx>4096||ry>4096)
    return null;
  return vals.map(n);
}

function safeBaseSprite(obj){
  const p=obj?.pipelineData||{};
  const tone=p.tone;
  if(tone!==undefined&&(!Array.isArray(tone)||tone.length!==4||
      tone.some(v=>!finite(v)||v!==0)))return false;
  return !p.isTerastallized&&!p.shiny&&
    !p.spriteColors?.length&&!p.fusionSpriteColors?.length&&
    !p.spriteColorsBase?.length&&!p.fusionSpriteColorsBase?.length;
}

function unsupportedReason(obj, options = {}, clip = null) {
  if (!obj?.visible || obj.active === false || obj.alpha <= 0) return "hidden";
  if (!obj.frame || !obj.texture || typeof obj.getWorldTransformMatrix !== "function") return "type";
  // Separate effect classes for an evidence-backed future renderer adapter.
  // None is silently dropped or approximated on the public viewer.
  if (obj.mask && !clip && !(options.labIgnoreGeometryMask === true &&
      obj.mask.constructor?.name === "GeometryMask")) return "mask";
  if (obj.isTinted || obj.tintFill) return "tint";
  if (obj.blendMode && obj.blendMode !== 0) return "blend";
  if (obj.isCropped) return "crop";
  if (obj.postPipelines?.length) return "postfx";
  if (obj.pipeline?.name && !["TextureTintPipeline", "MultiPipeline"].includes(obj.pipeline.name)
      && !(options.labFieldPipeline === true && obj.pipeline.name === "FieldSprite")
      && !(options.labSpriteBasePipeline===true && obj.pipeline.name==="Sprite" &&
        safeBaseSprite(obj)))
    return "pipeline";
  return null;
}

export function capturePhaserSprites(scene, options = {}) {
  const camera = scene?.cameras?.main;
  if (!camera || !scene?.children?.list) throw Error("Phaser scene not ready");
  const viewport = { width: camera.width, height: camera.height };
  if (![viewport.width, viewport.height, camera.scrollX, camera.scrollY, camera.zoom,
    camera.rotation, camera.x, camera.y].every(x => bounded(x))) throw Error("Invalid camera");
  if (camera.rotation !== 0 || camera.zoom <= 0 || camera.zoom > 8 ||
      viewport.width !== 1920 || viewport.height !== 1080) throw Error("Unsupported camera");
  const commands = [];
  const textures = new Set();
  const skipped = {};
  const approximated={fieldShader:0,geometryMask:0,spriteBase:0,spriteShadow:0};
  let inspected = 0;
  let truncated = false;
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const visit = (list, inheritedVisibility = true, inheritedAlpha = 1, depth = 0) => {
    if (!Array.isArray(list) || depth > 12) { skip("nesting"); return; }
    for (const obj of list) {
      if (inspected >= MAX_OBJECTS) { truncated = true; break; }
      inspected++;
      const visible = inheritedVisibility && obj?.visible !== false;
      const alpha = inheritedAlpha * (finite(obj?.alpha) ? obj.alpha : 1);
      if (!visible || alpha <= 0 || obj?.active === false) { skip("hidden"); continue; }
      if (Array.isArray(obj?.list)) {
        visit(obj.list, visible, alpha, depth + 1);
        continue;
      }
      const clip=options.labRectGeometryMask===true ? rectangularStencil(obj) : null;
      const reason = unsupportedReason(obj, options, clip);
      if (reason) { skip(reason); continue; }
      const usedFieldShaderApprox=options.labFieldPipeline === true &&
        obj.pipeline?.name === "FieldSprite";
      const usedSpriteBase=options.labSpriteBasePipeline===true &&
        obj.pipeline?.name==="Sprite"&&safeBaseSprite(obj);
      const shader=(usedFieldShaderApprox||usedSpriteBase) &&
        typeof options.labFieldUniforms==="function"
        ? options.labFieldUniforms(obj,scene) : null;
      if ((usedFieldShaderApprox||usedSpriteBase)&&
          typeof options.labFieldUniforms==="function"&&!shader){
        skip("shader-uniforms");continue;
      }
      const usedGeometryApprox=options.labIgnoreGeometryMask === true && !clip &&
        obj.mask?.constructor?.name === "GeometryMask";
      const shadow=usedSpriteBase&&options.labProjectedShadow===true
        ?projectSpriteShadow(obj):null;
      const frame = obj.frame;
      const source = frame.source?.image;
      let url = assetPath(source?.currentSrc || source?.src);
      if (!url && typeof options.labTextureResolver === "function") {
        const candidate = options.labTextureResolver(source);
        if (/^\/images\/__lab_memory__\/[0-9]{1,3}\.png$/.test(candidate)) url = candidate;
      }
      if (!url) { skip("asset"); continue; }
      if (textures.size >= MAX_TEXTURES && !textures.has(url)) { skip("textures-limit"); continue; }
      const isNineSlice=obj.type==="NineSlice";
      const drawWidth=isNineSlice?obj.width:frame.width;
      const drawHeight=isNineSlice?obj.height:frame.height;
      const borders=isNineSlice?
        [obj.leftWidth,obj.rightWidth,obj.topHeight,obj.bottomHeight]:null;
      const vals = [frame.cutX,frame.cutY,frame.cutWidth,frame.cutHeight,drawWidth,drawHeight,
        obj.displayOriginX,obj.displayOriginY,obj.scrollFactorX,obj.scrollFactorY];
      if(borders && (!borders.every(x=>bounded(x,4096)&&x>=0) ||
        borders[0]+borders[1]>frame.cutWidth ||
        borders[2]+borders[3]>frame.cutHeight ||
        borders[0]+borders[1]>drawWidth ||
        borders[2]+borders[3]>drawHeight)) {skip("nine-slice-bounds");continue;}
      const mat = obj.getWorldTransformMatrix();
      const transform = [mat?.a,mat?.b,mat?.c,mat?.d,mat?.tx,mat?.ty];
      if (![...vals,...transform,alpha].every(x => bounded(x,100000)) ||
          vals.slice(0,6).some(x => x < 0) || frame.cutWidth < 1 || frame.cutHeight < 1 ||
          frame.width < 1 || frame.height < 1 || alpha > 1) {
        skip("geometry"); continue;
      }
      textures.add(url);
      if (usedFieldShaderApprox) approximated.fieldShader++;
      if (usedSpriteBase){
        approximated.spriteBase++;
        if(obj.pipelineData?.hasShadow)approximated.spriteShadow++;
      }
      if (usedGeometryApprox) approximated.geometryMask++;
      commands.push({
        op: isNineSlice?"nineSlice":"sprite", texture: url,
        src: [frame.cutX,frame.cutY,frame.cutWidth,frame.cutHeight].map(n),
        dst: [-obj.displayOriginX,-obj.displayOriginY,drawWidth,drawHeight].map(n),
        ...(isNineSlice?{borders:borders.map(n)}:{}),
        ...(clip?{clip}:{}),
        ...(shader?{shader}:{}),
        ...(shadow?{shadow}:{}),
        matrix: transform.map(n), alpha: n(alpha),
        flipX: Boolean(obj.flipX), flipY: Boolean(obj.flipY),
        scroll: [obj.scrollFactorX,obj.scrollFactorY].map(n),
      });
    }
  };
  visit(scene.children.list);
  const envelope = {
    schema: SCHEMA, visualScope: "partial-original-sprites",
    labOnly: typeof options.labTextureResolver === "function" || options.labFieldPipeline === true ||
      options.labIgnoreGeometryMask === true || options.labRectGeometryMask === true ||
      options.labSpriteBasePipeline === true || options.labProjectedShadow===true,
    camera: { ...viewport, x:n(camera.x),y:n(camera.y),
      scrollX:n(camera.scrollX),scrollY:n(camera.scrollY),zoom:n(camera.zoom)},
    commands, coverage: { inspected, captured: commands.length,
      skipped, approximated, truncated,
      complete: !truncated && Object.entries(skipped).every(
        ([reason,count])=>reason==="hidden" || count===0) &&
        Object.values(approximated).every(count=>count===0) },
  };
  if (JSON.stringify(envelope).length > 96000) throw Error("Scene probe exceeds size bound");
  return envelope;
}
