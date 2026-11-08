/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Full first-wave acceptance against the actual game, not a simulated reward.
 * Use an isolated Chrome browser + co-op relay and two temporary collections.
 * Slow hosted software WebGL can take minutes; this test reports diagnostics
 * rather than bypassing any Phaser phase, battle calculation or player input.
 */
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  useRelay, newClientContext, openClient, waitForTitle,
  linkClients, press, pressUntil, untilWaveOne, ui,
  playUntil, checkpointsOf, desyncOf, describeClients,
} from "./coop-client.ts";
import { startAutonomousCoopRun } from "./pokerogue-starter-browser.mjs";

async function snapshot(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const coop = (window as any).__coop;
    return {
      ui: coop?.ui ?? null,
      phase: coop?.phase?.name ?? null,
      wave: coop?.phase?.wave ?? null,
      turn: coop?.phase?.turn ?? null,
      desync: coop?.desync ?? null,
      rewards: coop?.reward?.screen ?? null,
      pacePosition: coop?.pace?.position ?? null,
      paceLeader: coop?.pace?.leader ?? null,
      promptOpen: coop?.pace?.open ?? null,
    };
  });
}

test.describe("SAM co-op: full first-wave completion", () => {
  useRelay();

  test("both player clients reach game-generated wave-one reward with matching checkpoints", async ({ browser }, info) => {
    test.skip(process.env["COOP_FULL_WAVE_E2E"] !== "1",
      "Explicit, expensive full-wave test; ordinary CI uses the bounded browser smoke");
    test.setTimeout(780_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    let host: Awaited<ReturnType<typeof openClient>> | undefined;
    let guest: Awaited<ReturnType<typeof openClient>> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const events: unknown[] = [];
    const started = Date.now();
    try {
      [host, guest] = await Promise.all([
        openClient(hostContext, "full-wave-host"),
        openClient(guestContext, "full-wave-guest"),
      ]);
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      const plan = await startAutonomousCoopRun(host, guest, {
        linkClients, press, pressUntil, untilWaveOne,
        expectConfirm: async c => {
          await expect.poll(() => ui(c), { timeout: 45_000 }).toBe("CONFIRM");
        },
      });
      expect(plan.verifiedInGame).toBe(true);
      const hostBefore = host.presses.length, guestBefore = guest.presses.length;
      // Status only: never copy player saves, game state, or pixels into logs.
      heartbeat = setInterval(() => {
        if (!host || !guest) return;
        Promise.all([snapshot(host.page), snapshot(guest.page)])
          .then(([hostState, guestState]) => {
            const observation = {
              elapsedSeconds: Math.round((Date.now() - started) / 1000),
              host: hostState, guest: guestState,
            };
            if (events.length < 50) events.push(observation);
            console.log("SAM_COOP_WAVE_PROGRESS " + JSON.stringify(observation));
          })
          .catch(() => {});
      }, 20_000);
      const done = (s: {phase: { name: string } | null; ui: string; wave: number}) =>
        s.phase?.name === "SelectModifierPhase" && s.ui === "MODIFIER_SELECT" && s.wave === 1;

      await Promise.all([
        playUntil(host, "wave-one game reward", done, 620_000),
        playUntil(guest, "wave-one game reward", done, 620_000),
      ]);

      const [hostState, guestState, hostCps, guestCps, hostDesync, guestDesync] =
        await Promise.all([
          snapshot(host.page), snapshot(guest.page),
          checkpointsOf(host), checkpointsOf(guest),
          desyncOf(host), desyncOf(guest),
        ]);
      const verified = {
        schema: "sam.pokerogue.full_wave_reward_acceptance.v1",
        verifiedGameRewards: hostState.phase === "SelectModifierPhase"
          && guestState.phase === "SelectModifierPhase"
          && hostState.ui === "MODIFIER_SELECT"
          && guestState.ui === "MODIFIER_SELECT",
        hostAcceptedButtonSubmissions: host.presses.length - hostBefore,
        guestAcceptedButtonSubmissions: guest.presses.length - guestBefore,
        checkpointCount: hostCps.length,
        checkpointEquality: JSON.stringify(hostCps) === JSON.stringify(guestCps),
        hostDesync, guestDesync,
        durationSeconds: Math.round((Date.now() - started) / 1000),
        hostedBrowserOnly: true,
        macGameplayFpsVerified: false,
      };
      console.log("SAM_COOP_FULL_WAVE_ACCEPTANCE " + JSON.stringify(verified));
      await info.attach("full-wave-acceptance.json", {
        body: JSON.stringify(verified, null, 2), contentType: "application/json",
      });
      expect(verified.verifiedGameRewards).toBe(true);
      expect(verified.checkpointEquality).toBe(true);
      expect(verified.checkpointCount).toBeGreaterThanOrEqual(3);
      expect(hostDesync).toBeNull();
      expect(guestDesync).toBeNull();
      expect(verified.hostAcceptedButtonSubmissions).toBeGreaterThan(0);
      expect(verified.guestAcceptedButtonSubmissions).toBeGreaterThan(0);
      // Publish only a compact verified acceptance result. No screenshots,
      // game save material, identity tokens or policy-training labels.
      const report = {
        ...verified,
        sourceCommit: process.env["GITHUB_SHA"] ?? null,
        workflowRunId: process.env["GITHUB_RUN_ID"] ?? null,
        source: "github-ci-isolated-clean-checkout",
        userSavesAccessed: false,
        gamePolicyTrainingPerformed: false,
        acceptance: "passed",
      };
      await mkdir("test-results/acceptance", { recursive: true });
      await writeFile(
        "test-results/acceptance/full-wave-ci.json",
        JSON.stringify(report, null, 2) + "\\n",
        { encoding: "utf8", flag: "w", mode: 0o600 },
      );
    } catch (error) {
      const [finalState, detail] = await Promise.all([
        host && guest ? Promise.all([snapshot(host.page), snapshot(guest.page)])
          .catch(() => null) : Promise.resolve(null),
        host && guest ? describeClients(host, guest).catch(() => null)
          : Promise.resolve(null),
      ]);
      const diagnosis = {
        schema: "sam.pokerogue.full_wave_failure_v1",
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        finalState, detail, recentProgress: events.slice(-12),
        error: String(error).slice(0, 700),
        fullWaveVerified: false,
      };
      console.log("SAM_COOP_FULL_WAVE_FAILURE " + JSON.stringify(diagnosis));
      await info.attach("full-wave-failure.json", {
        body: JSON.stringify(diagnosis, null, 2), contentType: "application/json",
      });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
