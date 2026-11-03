/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, type Page, test } from "@playwright/test";
import { newClientContext, openClient, ui, waitForTitle } from "./coop-client.ts";

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
