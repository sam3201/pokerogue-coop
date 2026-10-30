/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Low-power browser presentation: logical 1920x1080, physical 320x180.
 * Runs only on ARM Linux or when explicitly requested with ?graphics=low.
 * Simulated game logic is never throttled.
 */
import { globalScene } from "#app/global-scene";
import type Phaser from "phaser";

const PHYSICAL_WIDTH = 320;
const PHYSICAL_HEIGHT = 180;
const VIRTUAL_WIDTH = 1920;
const VIRTUAL_HEIGHT = 1080;
const HEARTBEAT = 120;

function requested(): boolean {
  const mode = new URLSearchParams(window.location.search).get("graphics");
  if (mode === "full") {
    return false;
  }
  if (mode === "low") {
    return true;
  }
  return /Linux/i.test(navigator.userAgent) && /arm|aarch64/i.test(navigator.userAgent);
}

/** Does nothing on conventional desktop browsers. */
export function enableLowPowerRenderer(game: Phaser.Game): void {
  if (!requested()) {
    return;
  }
  let attempts = 0;
  const install = (): void => {
    if (!game.isBooted || !globalScene?.ui || !game.canvas || !game.renderer) {
      if (++attempts < 240) {
        window.setTimeout(install, 125);
      }
      return;
    }

    const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    const gl = renderer.gl;
    const canvas = game.canvas;
    if (!gl || game.scale.gameSize.width !== VIRTUAL_WIDTH || game.scale.gameSize.height !== VIRTUAL_HEIGHT) {
      return;
    }
    const widthProperty = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
    const heightProperty = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height");
    if (!widthProperty?.get || !widthProperty.set || !heightProperty?.get || !heightProperty.set) {
      return;
    }

    try {
      // WebGL allocation is small, but Phaser's layout coordinates do not change.
      widthProperty.set.call(canvas, PHYSICAL_WIDTH);
      heightProperty.set.call(canvas, PHYSICAL_HEIGHT);
      Object.defineProperty(canvas, "width", {
        configurable: true,
        get: () => VIRTUAL_WIDTH,
        set(value: number) {
          widthProperty.set?.call(canvas, Math.max(1, Math.round((value * PHYSICAL_WIDTH) / VIRTUAL_WIDTH)));
        },
      });
      Object.defineProperty(canvas, "height", {
        configurable: true,
        get: () => VIRTUAL_HEIGHT,
        set(value: number) {
          heightProperty.set?.call(canvas, Math.max(1, Math.round((value * PHYSICAL_HEIGHT) / VIRTUAL_HEIGHT)));
        },
      });
      canvas.style.imageRendering = "pixelated";

      // Offscreen GPU render targets retain native dimensions.
      const originalViewport = gl.viewport.bind(gl);
      const originalScissor = gl.scissor.bind(gl);
      gl.viewport = (x, y, width, height) => {
        if (renderer.currentFramebuffer) {
          return originalViewport(x, y, width, height);
        }
        return originalViewport(
          Math.floor((x * PHYSICAL_WIDTH) / VIRTUAL_WIDTH),
          Math.floor((y * PHYSICAL_HEIGHT) / VIRTUAL_HEIGHT),
          Math.ceil((width * PHYSICAL_WIDTH) / VIRTUAL_WIDTH),
          Math.ceil((height * PHYSICAL_HEIGHT) / VIRTUAL_HEIGHT),
        );
      };
      gl.scissor = (x, y, width, height) => {
        if (renderer.currentFramebuffer) {
          return originalScissor(x, y, width, height);
        }
        return originalScissor(
          Math.floor((x * PHYSICAL_WIDTH) / VIRTUAL_WIDTH),
          Math.floor((y * PHYSICAL_HEIGHT) / VIRTUAL_HEIGHT),
          Math.ceil((width * PHYSICAL_WIDTH) / VIRTUAL_WIDTH),
          Math.ceil((height * PHYSICAL_HEIGHT) / VIRTUAL_HEIGHT),
        );
      };
      Reflect.set(renderer, "drawingBufferHeight", VIRTUAL_HEIGHT);
      renderer.setProjectionMatrix(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      originalViewport(0, 0, PHYSICAL_WIDTH, PHYSICAL_HEIGHT);
      originalScissor(0, 0, PHYSICAL_WIDTH, PHYSICAL_HEIGHT);

      // Real elapsed time prevents very slow GPUs from freezing summon tweens.
      game.loop.smoothStep = false;
      game.loop.resetDelta();

      let dirty = true;
      let draw = true;
      let frames = 0;
      let phaseKey = "";
      const invalidate = () => {
        dirty = true;
      };
      window.addEventListener("keydown", invalidate, { capture: true, passive: true });
      window.addEventListener("keyup", invalidate, { capture: true, passive: true });
      window.addEventListener("pointerdown", invalidate, { capture: true, passive: true });
      window.addEventListener("pointerup", invalidate, { capture: true, passive: true });
      window.addEventListener("touchstart", invalidate, { capture: true, passive: true });
      document.addEventListener("visibilitychange", invalidate);

      const manager = game.scene;
      const originalPre = renderer.preRender;
      const originalRender = manager.render;
      const originalPost = renderer.postRender;
      renderer.preRender = function () {
        frames++;
        const phase = globalScene.phaseManager?.getCurrentPhase();
        const key = `${phase?.constructor.name ?? "unknown"}/${globalScene.ui?.mode ?? ""}`;
        draw = dirty || key !== phaseKey || frames % HEARTBEAT === 0;
        phaseKey = key;
        dirty = false;
        if (draw) {
          return originalPre.call(this);
        }
      };
      manager.render = function (rendererArg) {
        if (draw) {
          return originalRender.call(this, rendererArg);
        }
        Reflect.set(this, "isProcessing", false);
      };
      renderer.postRender = function () {
        if (draw) {
          return originalPost.call(this);
        }
      };
    } catch (error) {
      console.warn("Low-resource rendering could not be enabled", error);
    }
  };
  install();
}
