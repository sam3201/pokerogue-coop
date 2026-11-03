/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { expect, test } from "@playwright/test";
import {
  checkpointsOf, desyncOf, linkClients, newClientContext,
  openClient, pickAndReady, playUntil, ui, untilWaveOne, useRelay, waitForTitle,
  type Client,
} from "./coop-client.ts";

useRelay();

/**
 * QA-only scripted real-keyboard driver; not a SAM policy or learned action.
 * No guest-side __coop.press calls are made after the normal (dev-harness)
 * room handshake, nor are commands injected into the relay/sequencer.
 * Read-only __coop is exclusively for observing acceptance state.
 */
async function physicalReady(guest: Client): Promise<string[]> {
  const log: string[] = [];
  await expect.poll(() => ui(guest), { timeout: 60_000 }).toBe("STARTER_SELECT");
  await guest.page.waitForTimeout(900);
  const pressToMode = async (from: string, to: string, key: string) => {
    await expect.poll(() => ui(guest), { timeout: 60_000 }).toBe(from);
    let reached = false;
    for (let attempt = 0; attempt < 4 && !reached; attempt++) {
      if (await ui(guest) !== from) break;
      log.push(`${from} -> ${to}: ${key} attempt ${attempt + 1}`);
      await guest.page.keyboard.press(key, { delay: 65 });
      try {
        await expect.poll(() => ui(guest), { timeout: 6_000, intervals: [250] }).toBe(to);
        reached = true;
      } catch {
        const actual = await ui(guest);
        if (actual !== from) {
          throw new Error(`physical guest starter input reached unexpected mode ${actual}, expected ${to}`);
        }
      }
    }
    expect(reached, `keyboard ${key} did not move ${from} into ${to}`).toBe(true);
  };
  await pressToMode("STARTER_SELECT", "OPTION_SELECT", "z");
  await pressToMode("OPTION_SELECT", "STARTER_SELECT", "z");
  await guest.page.waitForTimeout(400);
  await pressToMode("STARTER_SELECT", "CONFIRM", "Enter");
  await pressToMode("CONFIRM", "STARTER_SELECT", "z");
  return log;
}

async function firstGuestTurnPhysical(guest: Client, log: string[]): Promise<void> {
  const seen = new Set<string>();
  let lastMessage = 0;
  await expect.poll(async () => {
    const state = await guest.page.evaluate(() => {
      const c = (window as any).__coop;
      return {
        ui: c.ui as string,
        phase: c.phase as { name: string; wave: number; turn: number } | null,
        desync: c.desync as string | null,
        own: (c.pace?.private ?? true) as boolean,
        checkpoint: (c.checkpoints as Array<{ kind: string }>).filter(x => x.kind === "turn").length >= 2\n          || (c.checkpoints as Array<{ kind: string }>).some(x => x.kind === "waveEnd" || x.kind === "rewards"),
      };
    });
    if (state.desync !== null) throw new Error(`guest desync ${state.desync}`);
    // The first "turn" checkpoint is at TurnInitPhase (BEFORE any command).\n    // A second turn or wave-end checkpoint proves the previous turn advanced.\n    if (state.checkpoint && seen.has("COMMAND") && seen.has("FIGHT")) return true;
    if (state.phase?.name === "GameOverPhase") throw new Error("game over before first turn");
    // A single move's input should go through CommandPhase -> Fight -> target;
    // the active browser UI, not a privileged API, handles all legality.
    if (["COMMAND", "FIGHT", "TARGET_SELECT", "CONFIRM"].includes(state.ui)) {
      seen.add(state.ui);
      log.push(`${state.phase?.name}/${state.ui}: z`);
      await guest.page.keyboard.press("z", { delay: 65 });
    } else if (state.ui === "MESSAGE" && state.own && Date.now() - lastMessage >= 1500) {
      log.push(`${state.phase?.name}/MESSAGE: z`);
      lastMessage = Date.now();
      await guest.page.keyboard.press("z", { delay: 65 });
    }
    return false;
  }, { timeout: 540_000, intervals: [400], message: "physical guest did not complete a sequenced battle turn" }).toBe(true);
  expect(seen.has("COMMAND"), "guest never selected a command through physical keyboard input").toBe(true);
  expect(seen.has("FIGHT"), "guest never selected an actual battle move through physical keyboard input").toBe(true);
}

test("guest's real keyboard selects starter and completes one sequenced battle turn", async ({ browser }, testInfo) => {
  test.setTimeout(840_000);
  const hostContext = await newClientContext(browser, true);
  const guestContext = await newClientContext(browser, true);
  const [host, guest] = await Promise.all([
    openClient(hostContext, "host-scripted"),
    openClient(guestContext, "guest-physical-keyboard"),
  ]);
  const physicalActions: string[] = [];
  try {
    await Promise.all([waitForTitle(host), waitForTitle(guest)]);
    // The separate PR #9 test already proves real guest invitation by physical
    // menu/form inputs. Here the dev harness only sets up the SAME real pair.
    await linkClients(host, guest);
    const [, starterLog] = await Promise.all([pickAndReady(host, 0), physicalReady(guest)]);
    physicalActions.push(...starterLog);
    await untilWaveOne(host, guest);
    await Promise.all([
      playUntil(host, "host accepted first battle turn", async () =>
        (await checkpointsOf(host)).filter(c => c.kind === "turn").length >= 2\n          || (await checkpointsOf(host)).some(c => c.kind === "waveEnd" || c.kind === "rewards"), 540_000),
      firstGuestTurnPhysical(guest, physicalActions),
    ]);
    const [a, b] = await Promise.all([checkpointsOf(host), checkpointsOf(guest)]);
    expect(a.map(c => c.kind)).toContain("waveStart");
    expect(a.map(c => c.kind)).toContain("turn");
    expect(b).toEqual(a);
    expect(await desyncOf(host)).toBeNull();
    expect(await desyncOf(guest)).toBeNull();
    await testInfo.attach("guest-physical-actions.json", {
      body: JSON.stringify(physicalActions, null, 2),
      contentType: "application/json",
    });
    expect([...host.errors, ...guest.errors], "console errors").toEqual([]);
  } finally {
    await Promise.allSettled([hostContext.close(), guestContext.close()]);
  }
});
