/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Isolated clean-checkout E2E: real two-player wave-one battle with browser
 * frame-timing evidence. Browser rendering is local to each Playwright client;
 * this is a CI smoke, NOT an end-user Mac FPS benchmark or trained-move proof.
 * No imported user saves and no changes to the live worker.
 */
import {expect, test} from "@playwright/test";
import {
  useRelay, newClientContext, openClient, waitForTitle,
  linkClients, press, pressUntil, untilWaveOne, ui,
  playToRewardScreen, checkpointsOf, desyncOf,
} from "./coop-client.ts";
import {startAutonomousCoopRun} from "./pokerogue-starter-browser.mjs";

type FrameEvidence = {
  elapsedMs: number;
  frameCount: number;
  rafFps: number;
  medianIntervalMs: number | null;
  p95IntervalMs: number | null;
  maxIntervalMs: number | null;
  intervalsOver50Ms: number;
  phaserReportedFps: number | null;
  visibility: string;
  renderBackend: number | null;
  canvasCount: number;
  phaseAtStart: string | null;
  waveAtStart: number | null;
};

/** Sample only the current browser tab, never streaming frames to the relay. */
async function sampleBrowserFrames(page: import("@playwright/test").Page, ms: number): Promise<FrameEvidence> {
  return page.evaluate(async sampleMs => {
    const {globalScene} = await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    const game = globalScene?.game;
    const phaseAtStart: string | null = (window as any).__coop?.phase?.name ?? null;
    const waveAtStart: number | null = (window as any).__coop?.phase?.wave ?? null;
    const gaps: number[] = [];
    let frameCount = 0;
    let last: number | null = null;
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      // Terminate even if the browser temporarily throttles requestAnimationFrame.
      const watchdog = window.setTimeout(
        () => reject(new Error("in-game frame sampler timed out")),
        sampleMs + 20_000,
      );
      const frame = (t: number) => {
        if (last !== null) gaps.push(t - last);
        last = t;
        frameCount++;
        if (t - start >= sampleMs) {
          window.clearTimeout(watchdog);
          resolve();
        } else {
          window.requestAnimationFrame(frame);
        }
      };
      window.requestAnimationFrame(frame);
    });
    const elapsedMs = performance.now() - start;
    const sorted = gaps.sort((a, b) => a - b);
    const percentile = (q: number): number | null =>
      sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
    const rounded = (n: number | null): number | null =>
      n === null ? null : Math.round(n * 100) / 100;
    return {
      elapsedMs: rounded(elapsedMs)!,
      frameCount,
      rafFps: rounded(1000 * frameCount / elapsedMs)!,
      medianIntervalMs: rounded(percentile(0.50)),
      p95IntervalMs: rounded(percentile(0.95)),
      maxIntervalMs: rounded(percentile(1.00)),
      intervalsOver50Ms: gaps.filter(n => n > 50).length,
      phaserReportedFps: game?.loop?.actualFps ?? null,
      visibility: document.visibilityState,
      renderBackend: game?.renderer?.type ?? null,
      canvasCount: document.querySelectorAll("canvas").length,
      phaseAtStart, waveAtStart,
    };
  }, ms);
}

test.describe("SAM co-op: actual battle frame pacing and synchronization", () => {
  useRelay();

  test("two independently selected starters play wave one through equal reward checkpoints", async ({browser}, info) => {
    test.setTimeout(420_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    try {
      const [host, guest] = await Promise.all([
        openClient(hostContext, "frame-host"),
        openClient(guestContext, "frame-guest"),
      ]);
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);

      const starterPlan = await startAutonomousCoopRun(host, guest, {
        linkClients, press, pressUntil, untilWaveOne,
        expectConfirm: async client => {
          await expect.poll(() => ui(client), {timeout: 45_000}).toBe("CONFIRM");
        },
      });
      expect(starterPlan.verifiedInGame).toBe(true);
      expect(starterPlan.gameConfirmations).toHaveLength(2);

      // Keep the measured client foreground: background tabs can have throttled
      // rAF unrelated to actual game-frame assembly performance.
      await host.page.bringToFront();
      const sampling = sampleBrowserFrames(host.page, 8000);
      const waveOne = Promise.all([
        playToRewardScreen(host),
        playToRewardScreen(guest),
      ]);
      const [frames] = await Promise.all([sampling, waveOne]);

      const [hostCheckpoints, guestCheckpoints] = await Promise.all([
        checkpointsOf(host), checkpointsOf(guest),
      ]);
      expect(hostCheckpoints.length).toBeGreaterThanOrEqual(3);
      expect(guestCheckpoints).toEqual(hostCheckpoints);
      expect(hostCheckpoints.at(-1)?.kind).toBe("rewards");
      expect(hostCheckpoints.map(x => x.kind)).toContain("turn");
      expect(await desyncOf(host)).toBeNull();
      expect(await desyncOf(guest)).toBeNull();
      expect(host.presses.length).toBeGreaterThan(0);
      expect(guest.presses.length).toBeGreaterThan(0);

      // Browser CI is headless and hardware-dependent. Record, but DO NOT
      // impose a fabricated 30 FPS Mac acceptance threshold on GitHub's runner.
      expect(frames.frameCount).toBeGreaterThanOrEqual(2);
      expect(frames.canvasCount).toBeGreaterThan(0);
      expect(frames.waveAtStart).toBe(1);
      const evidence = {
        schema: "sam.pokerogue.clean_checkout_coop_frame_evidence.v1",
        environment: "hosted-headless-chromium-not-user-mac",
        frames,
        starterPlanVerified: starterPlan.verifiedInGame,
        hostInputs: host.presses.length,
        guestInputs: guest.presses.length,
        equalGameCheckpoints: hostCheckpoints.length,
        zeroDesync: true,
        userMacGameplayFpsVerified: false,
      };
      await info.attach("two-player-frame-metrics.json", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      console.log("SAM_COOP_FRAME_EVIDENCE " + JSON.stringify(evidence));
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
