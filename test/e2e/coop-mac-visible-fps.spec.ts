/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Opt-in, visible macOS co-op performance acceptance. Runs in two new
 * Playwright browser contexts, uses game-owned starter/turn inputs and samples
 * local requestAnimationFrame while the game is running. Does NOT collect
 * screenshots, user saves, profile cookies or model-training labels.
 *
 * From an isolated game checkout on the Mac, with its localhost game tunnel:
 * COOP_E2E=1 COOP_MAC_FPS=1 E2E_BASE_URL=http://127.0.0.1:8000 \
 *   pnpm exec playwright test test/e2e/coop-mac-visible-fps.spec.ts \
 *   --project=chromium --headed --workers=1 --reporter=line
 *
 * Mac-only and opt-in. Never add this spec to the hosted Linux CI job.
 */
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  useRelay, newClientContext, openClient, waitForTitle,
  linkClients, press, pressUntil, untilWaveOne, ui,
  playUntil, checkpointsOf, desyncOf, EXTERNAL_BASE_URL,
} from "./coop-client.ts";
import { startAutonomousCoopRun } from "./pokerogue-starter-browser.mjs";
import { assessMacGameplayFrames } from "./pokerogue-mac-fps-acceptance.mjs";

type RawSample = {
  elapsedMs: number; frameCount: number; frameIntervalsMs: number[];
  waveAtStart: number; phaseAtStart: string;
  waveAtEnd: number; phaseAtEnd: string;
  visibility: string; focused: boolean; renderBackend: number | null;
  canvasCount: number; phaserReportedFps: number | null;
  rendererString: string | null;
};

/** A foreground, browser-rendered frame sample; only summary statistics leave the page. */
async function sampleVisibleGame(page: import("@playwright/test").Page, ms: number): Promise<RawSample> {
  return page.evaluate(async sampleMs => {
    const sceneModuleUrl: string = "/src/globals/global-scene.ts";
    const { globalScene } = await import(/* @vite-ignore */ sceneModuleUrl);
    const game = globalScene?.game;
    const gl = (game?.renderer as any)?.gl as WebGLRenderingContext | undefined;
    const rendererString = gl ? String(gl.getParameter(gl.RENDERER)) : null;
    const phaseAtStart = (window as any).__coop?.phase?.name ?? "";
    const waveAtStart = (window as any).__coop?.phase?.wave ?? 0;
    const gaps: number[] = [];
    let frameCount = 0, lastTime: number | null = null;
    const start = performance.now();
    let lostForeground = !document.hasFocus() || document.visibilityState !== "visible";
    const markLost = () => { lostForeground = true; };
    window.addEventListener("blur", markLost);
    document.addEventListener("visibilitychange", markLost);
    try {
      await new Promise<void>((resolve, reject) => {
        const watchdog = window.setTimeout(() => reject(new Error("Mac frame-sampling watchdog expired")),
          sampleMs + 12000);
        const tick = (time: number) => {
          if (lastTime !== null) gaps.push(time - lastTime);
          lastTime = time; frameCount++;
          if (time - start >= sampleMs) {
            window.clearTimeout(watchdog);
            resolve();
          } else window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      });
    } finally {
      window.removeEventListener("blur", markLost);
      document.removeEventListener("visibilitychange", markLost);
    }
    return {
      elapsedMs: performance.now() - start, frameCount,
      frameIntervalsMs: gaps, phaseAtStart, waveAtStart,
      phaseAtEnd: (window as any).__coop?.phase?.name ?? "",
      waveAtEnd: (window as any).__coop?.phase?.wave ?? 0,
      visibility: document.visibilityState,
      focused: !lostForeground && document.hasFocus(),
      renderBackend: game?.renderer?.type ?? null,
      canvasCount: document.querySelectorAll("canvas").length,
      phaserReportedFps: game?.loop?.actualFps ?? null,
      rendererString,
    };
  }, ms);
}

test.describe("Mac visible, real-game co-op FPS acceptance", () => {
  useRelay();

  test("each foreground co-op player delivers 30 FPS with bounded frame stalls", async ({ browser }, info) => {
    test.skip(process.platform !== "darwin" || process.env["COOP_MAC_FPS"] !== "1",
      "Explicit Mac-only headed acceptance; disabled during normal CI");
    test.setTimeout(360_000);
    const base = new URL(EXTERNAL_BASE_URL ?? "http://localhost:8000");
    expect(base.protocol).toBe("http:");
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(base.hostname);

    // Measure normal user-facing animation settings, not the CI fast-mode preset.
    const hostContext = await newClientContext(browser, false);
    const guestContext = await newClientContext(browser, false);
    try {
      const [host, guest] = await Promise.all([
        openClient(hostContext, "mac-visible-sam"),
        openClient(guestContext, "mac-visible-jevbot"),
      ]);
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      const plan = await startAutonomousCoopRun(host, guest, {
        linkClients, press, pressUntil, untilWaveOne,
        expectConfirm: async c => {
          await expect.poll(() => ui(c), { timeout: 45000 }).toBe("CONFIRM");
        },
      });
      expect(plan.verifiedInGame).toBe(true);
      const hostBefore = host.presses.length, guestBefore = guest.presses.length;
      // Keep game inputs flowing until both foreground samples finish.
      // A time-only stop could silently end the game loop before the second
      // player's FPS sample, producing a plausible but invalid "gameplay" FPS.
      let stopGameplay = false;
      const play = Promise.all([
        playUntil(host, "30 seconds of real co-op gameplay",
          state => (state.phase?.name === "SelectModifierPhase"
            && state.ui === "MODIFIER_SELECT") || stopGameplay, 100000),
        playUntil(guest, "30 seconds of real co-op gameplay",
          state => (state.phase?.name === "SelectModifierPhase"
            && state.ui === "MODIFIER_SELECT") || stopGameplay, 100000),
      ]);
      // Install a rejection handler immediately while foreground sampling
      // runs, then propagate any gameplay error when the sample ends.
      void play.catch(() => {});
      // Don't certify title, starter or pre-input introduction FPS as combat.
      const actualInputDeadline = Date.now() + 35000;
      while ((host.presses.length === hostBefore || guest.presses.length === guestBefore)
        && Date.now() < actualInputDeadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(host.presses.length).toBeGreaterThan(hostBefore);
      expect(guest.presses.length).toBeGreaterThan(guestBefore);

      await host.page.bringToFront();
      const hostRaw = await sampleVisibleGame(host.page, 12000);
      await guest.page.bringToFront();
      const guestRaw = await sampleVisibleGame(guest.page, 12000);
      stopGameplay = true;
      await play;
      const [hostCps, guestCps, hostDesync, guestDesync] = await Promise.all([
        checkpointsOf(host), checkpointsOf(guest), desyncOf(host), desyncOf(guest),
      ]);
      const commonCheckpoints = hostCps.filter(h =>
        guestCps.some(g => h.index === g.index && h.kind === g.kind && h.hash === g.hash));
      const hostMetrics = assessMacGameplayFrames({
        ...hostRaw, submittedInputs: host.presses.length - hostBefore,
      });
      const guestMetrics = assessMacGameplayFrames({
        ...guestRaw, submittedInputs: guest.presses.length - guestBefore,
      });
      const accepted = plan.verifiedInGame && commonCheckpoints.length > 0
        && hostDesync === null && guestDesync === null
        && hostMetrics.meetsFrameTarget && guestMetrics.meetsFrameTarget;
      const report = {
        schema: "sam.pokerogue.mac_visible_two_player_acceptance.v1",
        machine: "macos-local-browser",
        localHttpGameOnly: true,
        rendererProcessesFrameLocally: true,
        source: "isolated-playwright-contexts",
        sam: hostMetrics,
        jevbot: guestMetrics,
        commonGameCheckpoints: commonCheckpoints.length,
        hostDesync, guestDesync,
        macTwoPlayerFpsAccepted: accepted,
        macHardwareAccelerationVerified: false,
        personalSavesModified: false,
        trainingWeightsModified: false,
      };
      await mkdir("test-results/acceptance", { recursive: true });
      await writeFile("test-results/acceptance/mac-coop-fps.json",
        JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
      console.log("SAM_MAC_VISIBLE_COOP_FPS " + JSON.stringify(report));
      await info.attach("mac-visible-two-player-fps.json", {
        body: JSON.stringify(report, null, 2), contentType: "application/json",
      });
      expect(commonCheckpoints.length).toBeGreaterThan(0);
      expect(hostDesync).toBeNull();
      expect(guestDesync).toBeNull();
      expect(hostMetrics.validGameplaySample).toBe(true);
      expect(guestMetrics.validGameplaySample).toBe(true);
      expect(hostMetrics.meetsFrameTarget).toBe(true);
      expect(guestMetrics.meetsFrameTarget).toBe(true);
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
