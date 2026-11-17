/*
 * SPDX-FileCopyrightText: 2026 SAM_AGI integration contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Private acceptance: reload *real* game-created saves from the previous
 * capture run and ask the game to select that species as a starter.
 * No test unlocks, fixture dex mutations, or copied credentials.
 */
import {join} from "node:path";
import {expect, test} from "@playwright/test";
import {
  useRelay, newClientContext, openClient, waitForTitle,
  linkClients, press, pressUntil, untilWaveOne, ui,
} from "./coop-client.ts";
import {startAutonomousCoopRun} from "./pokerogue-starter-browser.mjs";
import {restoreSeatState} from "./pokerogue-seat-state.mjs";

const expectedSpecies = Number(process.env["COOP_CAPTURE_EXPECT_SPECIES"]);
const expectedSeat = process.env["COOP_CAPTURE_EXPECT_SEAT"] ?? "guest";
const saveDir = "/srv/sam/projects/pokerogue-coop/test-results/agent-coop/private-seat-saves";

test.describe("persisted, legitimate co-op capture unlock", () => {
  useRelay();
  test.skip(
    process.env["COOP_CAPTURE_RESTART_TEST"] !== "1"
    || !Number.isSafeInteger(expectedSpecies) || expectedSpecies < 1
    || !["host","guest"].includes(expectedSeat),
    "Requires explicit local game-created save and the captured species ID"
  );
  test("captured species is selectable and admitted to its owner's new run", async ({browser}) => {
    test.setTimeout(300_000);
    const hc = await newClientContext(browser,true);
    const gc = await newClientContext(browser,true);
    try {
      const origin = new URL(String(test.info().project.use.baseURL
        ?? process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:8000")).origin;
      const [hostRestore, guestRestore] = await Promise.all([
        restoreSeatState(hc, "sam", saveDir, origin),
        restoreSeatState(gc, "jevbot", saveDir, origin),
      ]);
      expect(hostRestore.restored).toBe(true);
      expect(guestRestore.restored).toBe(true);
      const [host,guest] = await Promise.all([
        openClient(hc,"capture-restart-host"),openClient(gc,"capture-restart-guest")
      ]);
      await Promise.all([waitForTitle(host),waitForTitle(guest)]);
      const scores = expectedSeat === "host"
        ? {host:{[expectedSpecies]:100}}
        : {guest:{[expectedSpecies]:100}};
      const plan = await startAutonomousCoopRun(host,guest,{
        linkClients,press,pressUntil,untilWaveOne,
        expectConfirm: async client => {
          await expect.poll(() => ui(client), {timeout:45_000}).toBe("CONFIRM");
        },
      },scores);
      expect(plan.verifiedInGame).toBe(true);
      const selected = expectedSeat === "host" ? plan.host : plan.guest;
      expect(selected.speciesId).toBe(expectedSpecies);
      expect(plan.gameConfirmations.some(c => c.speciesId === expectedSpecies
        && c.gamePartyAcknowledged)).toBe(true);
      console.log("CAPTURE_RESTART_SELECT_PASS", JSON.stringify({
        seat:expectedSeat,speciesId:expectedSpecies,
        actualPlayerSelection:selected,saveRestored:true,partyConfirmed:true,
      }));
    } finally {
      await Promise.all([hc.close(),gc.close()]);
    }
  });
});
