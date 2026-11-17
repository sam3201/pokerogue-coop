/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page, test } from "@playwright/test";
import { newClientContext, openClient, openCoopMenu, press, ui, useRelay, waitForTitle } from "./coop-client.ts";

useRelay();

/**
 * Independent QA of a production-compatible browser-input seam for SAM.
 * All actions are real keyboard events; the only game-state hook is a read-only
 * assertion on UI mode. Title-menu targeting is verified from rendered pixels.
 * No policy, learned behavior, or public agent-seat functionality is claimed.
 *
 * The screenshot geometry is for the existing 800x450 game canvas/title layout.
 * This intentionally tests one known desktop layout, not universal visual OCR.
 */
async function renderedTitleCursor(page: Page): Promise<"new" | "coop" | "unknown"> {
  return page.evaluate(() => new Promise<"new" | "coop" | "unknown">(resolve => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#app canvas");
      if (!canvas) { resolve("unknown"); return; }
      const probe = document.createElement("canvas");
      probe.width = 800;
      probe.height = 450;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) { resolve("unknown"); return; }
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
      const whiteArrowPixels = (yStart: number, yEnd: number): number => {
        let total = 0;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 608; x < 628; x++) {
            const i = (y * 800 + x) * 4;
            if (pixels[i]! > 175 && pixels[i + 1]! > 175 && pixels[i + 2]! > 175) total++;
          }
        }
        return total;
      };
      const first = whiteArrowPixels(237, 267);
      const second = whiteArrowPixels(277, 308);
      if (first > 70 && second < 40) resolve("new");
      else if (second > 70 && first < 40) resolve("coop");
      else resolve("unknown");
    });
  }));
}

/**
 * Visual acceptance of the three top co-op menu choices on the fixed desktop
 * 800x450 canvas. Sample only the white cursor arrow, not the option labels.
 * Observed Y bands from the hosted browser's actual screenshot trace.
 */
async function renderedCoopMenuCursor(page: Page): Promise<"host" | "join" | "find" | "unknown"> {
  return page.evaluate(() => new Promise<"host" | "join" | "find" | "unknown">(resolve => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#app canvas");
      if (!canvas) { resolve("unknown"); return; }
      const probe = document.createElement("canvas");
      probe.width = 800;
      probe.height = 450;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) { resolve("unknown"); return; }
      ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
      const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
      const countArrow = (startY: number, endY: number): number => {
        let count = 0;
        for (let y = startY; y < endY; y++) for (let x = 508; x < 528; x++) {
          const i = (y * 800 + x) * 4;
          if (pixels[i]! > 175 && pixels[i + 1]! > 175 && pixels[i + 2]! > 175) count++;
        }
        return count;
      };
      const counts = [countArrow(120, 145), countArrow(153, 179), countArrow(186, 212)];
      const selected = counts.findIndex((n, i) => n > 75 && counts.every((other, j) => j === i || other < 40));
      resolve((["host", "join", "find"] as const)[selected] ?? "unknown");
    });
  }));
}

/** Never send a select key unless the rendered pointer is at the intended item. */
test("SAM-compatible physical keys navigate visibly to Co-op before selecting", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newClientContext(browser, true);
  const client = await openClient(context, "external-keyboard");
  try {
    await waitForTitle(client);
    expect(await ui(client)).toBe("TITLE");
    await expect.poll(() => renderedTitleCursor(client.page), {
      timeout: 30_000, intervals: [500], message: "visual New Game selection was not ready",
    }).toBe("new");

    let coopSelected = false;
    for (let attempt = 0; attempt < 3 && !coopSelected; attempt++) {
      const before = await renderedTitleCursor(client.page);
      if (before === "coop") { coopSelected = true; break; }
      if (before !== "new") {
        await client.page.waitForTimeout(500);
        continue;
      }
      // Same physical ArrowDown/KeyZ family as the Pi browser bridge. Its
      // 65ms button duration can be missed under software rendering; verify!
      await client.page.keyboard.press("ArrowDown", { delay: 65 });
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const after = await renderedTitleCursor(client.page);
        if (after === "coop") { coopSelected = true; break; }
        await client.page.waitForTimeout(200);
      }
    }
    expect(coopSelected, "physical ArrowDown never moved the visible menu cursor to Co-op").toBe(true);
    // A missed navigation must never be followed by Z: that would start New Game.
    await client.page.keyboard.press("z", { delay: 65 });
    await expect.poll(() => ui(client), { timeout: 30_000, intervals: [250] }).toBe("OPTION_SELECT");

    await client.page.keyboard.press("x", { delay: 65 });
    // Cancel can transition via a brief MESSAGE or directly back to TITLE.
    await expect.poll(() => ui(client), { timeout: 30_000, intervals: [250] }).toMatch(/^(TITLE|MESSAGE)$/);
    expect(client.errors, "unexpected game console errors").toEqual([]);
  } finally {
    await context.close();
  }
});

/**
 * First invite-only guest admission acceptance: host is a separate game client.
 * Guest is driven exclusively by browser keypresses and a visible HTML join-code
 * field, not by __coop.press / __coop.submitJoinCode. Read-only __coop is used
 * to assert protocol state and role on this test build.
 */
test("external guest joins a private co-op room using real browser input", async ({ browser }) => {
  test.setTimeout(420_000);
  const hostContext = await newClientContext(browser, true);
  const guestContext = await newClientContext(browser, true);
  const host = await openClient(hostContext, "human-host");
  const guest = await openClient(guestContext, "external-guest");

  try {
    await Promise.all([waitForTitle(host), waitForTitle(guest)]);

    // Host may use existing trusted E2E controls: this test isolates the guest
    // input interface. The host still runs the actual game and relay.
    await openCoopMenu(host);
    await press(host, "ACTION");
    await expect.poll(() => host.page.evaluate(() => (window as any).__coop.joinCode as string | null),
      { timeout: 45_000, message: "host did not create a join code" }).not.toBeNull();
    const code = await host.page.evaluate(() => (window as any).__coop.joinCode as string);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    await expect.poll(() => renderedTitleCursor(guest.page),
      { timeout: 30_000, message: "guest title selection not rendered" }).toBe("new");
    let coopSelected = false;
    for (let attempt = 0; attempt < 3 && !coopSelected; attempt++) {
      await guest.page.keyboard.press("ArrowDown", { delay: 65 });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (await renderedTitleCursor(guest.page) === "coop") {
          coopSelected = true;
          break;
        }
        await guest.page.waitForTimeout(200);
      }
    }
    expect(coopSelected, "guest must visibly target Co-op before selection").toBe(true);
    await guest.page.keyboard.press("z", { delay: 65 });
    await expect.poll(() => ui(guest), { timeout: 30_000 }).toBe("OPTION_SELECT");

    // A 65ms Down occasionally skipped past Join and selected Find a partner.
    // Inspect rendered menu position; correct overshoot and stop after a
    // bounded number of moves. Never select by a blind key sequence.
    let joinSelected = false;
    for (let attempt = 0; attempt < 8 && !joinSelected; attempt++) {
      const before = await renderedCoopMenuCursor(guest.page);
      if (before === "join") { joinSelected = true; break; }
      if (before === "unknown") {
        await guest.page.waitForTimeout(300);
        continue;
      }
      await guest.page.keyboard.press(before === "host" ? "ArrowDown" : "ArrowUp", { delay: 35 });
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const after = await renderedCoopMenuCursor(guest.page);
        if (after === "join") { joinSelected = true; break; }
        if (after !== "unknown" && after !== before) break;
        await guest.page.waitForTimeout(200);
      }
    }
    expect(joinSelected, "rendered cursor did not select Join a game").toBe(true);
    await guest.page.keyboard.press("z", { delay: 65 });
    await expect.poll(() => ui(guest), { timeout: 30_000 }).toBe("COOP_JOIN_FORM");

    // Phaser's rex InputText displays a real HTML input and accepts physical
    // keyboard text events; do not call the debug-only submitJoinCode helper.
    const codeInput = guest.page.locator('input[type="text"]:visible').first();
    await expect(codeInput).toBeVisible({ timeout: 30_000 });
    await codeInput.click();
    await guest.page.keyboard.type(code, { delay: 30 });
    await expect(codeInput).toHaveValue(code);
    await guest.page.keyboard.press("Enter", { delay: 65 });

    await Promise.all([host, guest].map(async client => {
      await expect.poll(() => client.page.evaluate(() => (window as any).__coop.linked),
        { timeout: 60_000, message: `${client.label} not linked` }).toBe(true);
      await expect.poll(() => ui(client), { timeout: 60_000 }).toBe("STARTER_SELECT");
    }));
    expect(await host.page.evaluate(() => (window as any).__coop.seat)).toBe("host");
    expect(await guest.page.evaluate(() => (window as any).__coop.seat)).toBe("guest");
    expect(host.errors.concat(guest.errors), "browser runtime errors").toEqual([]);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
