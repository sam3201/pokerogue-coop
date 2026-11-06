/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Install this test AND both pokerogue-starter-*.mjs modules together into
 * the game's test/e2e/ folder; they are isolated from the live battle worker.
 */
import {expect, test} from "@playwright/test";
import {
  useRelay, newClientContext, openClient, waitForTitle,
  linkClients, press, pressUntil, untilWaveOne, ui,
} from "./coop-client.ts";
import {startAutonomousCoopRun} from "./pokerogue-starter-browser.mjs";

test.describe("local saved-Pokédex autonomous starter selection", () => {
  useRelay();
  test("both players independently select actual unlocked Pokémon", async ({browser}) => {
    test.setTimeout(300_000);
    const hostContext = await newClientContext(browser, true);
    const guestContext = await newClientContext(browser, true);
    try {
      const [host, guest] = await Promise.all([
        openClient(hostContext, "autostarter-host"),
        openClient(guestContext, "autostarter-guest"),
      ]);
      await Promise.all([waitForTitle(host), waitForTitle(guest)]);
      const plan = await startAutonomousCoopRun(host, guest, {
        linkClients, press, pressUntil, untilWaveOne,
        expectConfirm: async client => {
          await expect.poll(() => ui(client), {timeout:45_000}).toBe("CONFIRM");
        },
      });
      expect(plan.verifiedInGame).toBe(true);
      expect(plan.gameConfirmations).toHaveLength(2);
      expect(plan.host.cost + plan.guest.cost).toBeLessThanOrEqual(plan.sharedBudget);
      expect(plan.source).toBe("independent-loaded-game-dexes");
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
