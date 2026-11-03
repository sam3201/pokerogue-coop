/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from "@playwright/test";
import { newClientContext, openClient, ui, waitForTitle } from "./coop-client.ts";

/**
 * QA-only production-compatible input boundary for a future SAM browser guest.
 * Real keyboard events drive the game; window.__coop is READ ONLY for independent
 * observation of the UI state. A public build intentionally exposes no __coop.
 * This does not run an AI policy or prove autonomous gameplay.
 */
test("SAM-compatible ArrowDown/Z/X keys open co-op and begin exit confirmation", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newClientContext(browser, true);
  const client = await openClient(context, "external-keyboard");
  try {
    await waitForTitle(client);
    expect(await ui(client)).toBe("TITLE");
    // Use the very same physical key codes that the Pi browser bridge emits.
    // Never use the dev-only __coop.press shortcut here.
    await client.page.keyboard.press("ArrowDown", { delay: 75 });
    await client.page.waitForTimeout(300);
    await client.page.keyboard.press("z", { delay: 75 });
    await expect.poll(() => ui(client), { timeout: 30_000, intervals: [250] }).toBe("OPTION_SELECT");
    await client.page.keyboard.press("x", { delay: 75 });
    // Cancel can transition via a brief MESSAGE screen or return directly to TITLE.
    // Both represent actual navigation away from the co-op menu; no debug input is used.
    await expect.poll(() => ui(client), { timeout: 30_000, intervals: [250] }).toMatch(/^(TITLE|MESSAGE)$/);
    expect(client.errors, "unexpected game console errors").toEqual([]);
  } finally {
    await context.close();
  }
});
