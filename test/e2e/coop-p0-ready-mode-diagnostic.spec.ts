/* SPDX-License-Identifier: AGPL-3.0-only */
/**
 * QA-only physical-keyboard starter/Ready mode diagnostics.
 * The two clients use temporary local E2E profiles and the existing
 * local co-op relay. Only non-secret UI handler/mode metadata is recorded.
 * This does not modify the application or simulate a learned SAM policy.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  linkClients, newClientContext, openClient, pickAndReady,
  ui, useRelay, waitForTitle,
} from "./coop-client.ts";

useRelay();
test.use({ trace: "off", screenshot: "off", video: "off" });

type Snapshot = {
  step: string;
  sinceStartMs: number;
  uiMode: string | null;
  topHandler: string | null;
  starterCursor: number | null;
  transitionPending: boolean;
  modeChainLength: number;
  foreground: { visible: boolean; focused: boolean; actualFps: number | null };
  text: { length: number | null; timerRepeats: number | null; timerPaused: boolean | null; timerElapsedMs: number | null; pendingPrompt: boolean; awaitingActionInput: boolean };
  handlers: Array<{
    index: number;
    name: string;
    active: boolean;
    optionVisible: boolean | null;
    starterVisible: boolean | null;
    partyCount: number | null;
    inputBlocked: boolean;
    optionDepth: number | null;
  }>;
};

async function observe(page: Page, step: string, started: number): Promise<Snapshot> {
  return page.evaluate(async ({ step, sinceStartMs }) => {
    // Vite browser module URL, not a Node/TypeScript static file import.
    const runtimeUrl: string = "/src/globals/global-scene.ts";
    const { globalScene } = await import(/* @vite-ignore */ runtimeUrl);
    const gameUi = globalScene?.ui as any;
    const current = gameUi?.getHandler?.();
    const msg = gameUi?.getMessageHandler?.();
    const timer = msg?.textTimer;
    const handlers = ((gameUi?.handlers ?? []) as any[])
      .map((h, index) => ({
        index,
        name: h?.constructor?.name ?? "unknown",
        active: h?.active === true,
        optionVisible: typeof h?.optionSelectContainer?.visible === "boolean"
          ? h.optionSelectContainer.visible : null,
        starterVisible: typeof h?.starterSelectContainer?.visible === "boolean"
          ? h.starterSelectContainer.visible : null,
        partyCount: Array.isArray(h?.partyStarterIds) ? h.partyStarterIds.length : null,
        inputBlocked: h?.blockInput === true,
        optionDepth: Number.isFinite(h?.optionSelectContainer?.depth)
          ? h.optionSelectContainer.depth : null,
      }))
      .filter(h => h.active || h.optionVisible || h.starterVisible || h.partyCount !== null);
    return {
      step, sinceStartMs,
      uiMode: (window as any).__coop?.ui ?? null,
      topHandler: current?.constructor?.name ?? null,
      starterCursor: Number.isInteger(current?.cursor) ? current.cursor : null,
      transitionPending: gameUi?.coopTransition !== null,
      modeChainLength: Array.isArray(gameUi?._modeChain) ? gameUi._modeChain.length : 0,
      foreground: {
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        actualFps: Number.isFinite(globalScene?.game?.loop?.actualFps)
          ? Math.round(globalScene.game.loop.actualFps * 10) / 10 : null,
      },
      text: {
        length: typeof msg?.message?.text === "string" ? msg.message.text.length : null,
        timerRepeats: Number.isFinite(timer?.repeatCount) ? timer.repeatCount : null,
        timerPaused: typeof timer?.paused === "boolean" ? timer.paused : null,
        timerElapsedMs: Number.isFinite(timer?.elapsed) ? Math.round(timer.elapsed) : null,
        pendingPrompt: msg?.pendingPrompt === true,
        awaitingActionInput: msg?.awaitingActionInput === true,
      },
      handlers,
    };
  }, { step, sinceStartMs: Date.now() - started });
}

/** Record only control flow (not saved content, session identifiers or payloads).
 * This is a source-identical QA interception; original functions run unchanged.
 */
async function installInputTrace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const runtimeUrl: string = "/src/globals/global-scene.ts";
    const { globalScene } = await import(/* @vite-ignore */ runtimeUrl);
    const gameUi = globalScene.ui as any;
    const starter = (gameUi.handlers as any[]).find(h => h?.constructor?.name === "StarterSelectUiHandler");
    const events: Array<Record<string, unknown>> = [];
    const snapshot = () => ({
      mode: (window as any).__coop?.ui ?? null,
      handler: gameUi.getHandler?.()?.constructor?.name ?? null,
      party: starter?.partyStarterIds?.length ?? null,
      inputBlocked: starter?.blockInput === true,
      optionVisible: gameUi.handlers?.some((h: any) =>
        h?.constructor?.name === "OptionSelectUiHandler" && h?.optionSelectContainer?.visible === true) === true,
    });
    const addEvent = (what: string, details: Record<string, unknown> = {}) => {
      if (events.length >= 250) return;
      events.push({ ms: Math.round(performance.now()), what, ...snapshot(), ...details });
    };
    (window as any).__qaPhysicalReadyEvents = events;
    // Capture physical and mapped events without dispatching any.
    // This runner uses only temporary synthetic test users; capture each key
    // identity and code, never text field values, for event-order causality.
    const rawKey = (event: KeyboardEvent) => ({
      key: event.key, code: event.code, keyCode: event.keyCode,
      eventTimestamp: Math.round(event.timeStamp * 100) / 100,
      repeat: event.repeat, trusted: event.isTrusted,
    });
    window.addEventListener("keydown", event => addEvent("dom-keydown", rawKey(event)), { capture: true });
    window.addEventListener("keyup", event => addEvent("dom-keyup", rawKey(event)), { capture: true });
    globalScene.input?.keyboard?.on("keydown", (event: KeyboardEvent) =>
      addEvent("phaser-keydown", rawKey(event)));
    globalScene.input?.keyboard?.on("keyup", (event: KeyboardEvent) =>
      addEvent("phaser-keyup", rawKey(event)));
    globalScene.game?.events?.on("input_up", (event: any) => {
      addEvent("mapped-keyup", { button: event?.button ?? null, source: event?.controller_type ?? null });
    });
    globalScene.game?.events?.on("input_down", (event: any) => {
      addEvent("mapped-input", { button: event?.button ?? null, source: event?.controller_type ?? null });
    });
    const intercept = (owner: any, key: string) => {
      if (typeof owner?.[key] !== "function") return;
      const original = owner[key];
      owner[key] = function (...args: any[]) {
        addEvent(key + ":before", key === "processInput" ? { button: args[0] } : {});
        const result = original.apply(this, args);
        addEvent(key + ":after", key === "processInput" ? { returned: result } : {});
        return result;
      };
    };
    intercept(gameUi, "processInput");
    intercept(gameUi, "setModeInternal");
    for (const method of ["openPokemonMenu", "addToParty", "popPartyStarter", "tryStart", "processInput"]) {
      intercept(starter, method);
    }
    const option = (gameUi.handlers as any[]).find(h => h?.constructor?.name === "OptionSelectUiHandler");
    intercept(option, "processInput");
    addEvent("trace-start");
  });
}
async function readInputTrace(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (window as any).__qaPhysicalReadyEvents ?? []);
}

test("P0: physical guest Ready must not activate a stale Pokémon options menu", async ({ browser }) => {
  test.setTimeout(300_000);
  const hostContext = await newClientContext(browser, true);
  const guestContext = await newClientContext(browser, true);
  const samples: Snapshot[] = [];
  const started = Date.now();
  let pass = false;
  let problem: string | null = null;
  let inputTrace: Record<string, unknown>[] = [];
  let host: Awaited<ReturnType<typeof openClient>> | undefined;
  let guest: Awaited<ReturnType<typeof openClient>> | undefined;
  const record = async (step: string) => {
    if (guest && samples.length < 130) samples.push(await observe(guest.page, step, started));
  };
  try {
    [host, guest] = await Promise.all([
      openClient(hostContext, "qa-host"),
      openClient(guestContext, "qa-physical-guest"),
    ]);
    await Promise.all([waitForTitle(host), waitForTitle(guest)]);
    await linkClients(host, guest);
    await expect.poll(() => ui(guest!), { timeout: 60_000 }).toBe("STARTER_SELECT");
    await installInputTrace(guest.page);
    const readyHost = pickAndReady(host, 0);
    const readyGuest = (async () => {
      await record("initial-starter");
      // Match the repository's existing valid co-op setup: host takes its
      // first starter, guest physically navigates to the NEXT starter.
      // Verify actual cursor movement; never trust a blind arrow press.
      const guestCursor = async () => guest!.page.evaluate(async () => {
        const runtimeUrl: string = "/src/globals/global-scene.ts";
        const { globalScene } = await import(/* @vite-ignore */ runtimeUrl);
        const cursor = (globalScene?.ui?.getHandler?.() as any)?.cursor;
        return Number.isInteger(cursor) ? cursor as number : null;
      });
      const initialCursor = await guestCursor();
      expect(initialCursor, "guest starter grid cursor unavailable").not.toBeNull();
      await guest!.page.keyboard.press("ArrowRight", { delay: 65 });
      await expect.poll(() => guestCursor(), { timeout: 15_000, intervals: [200] })
        .toBe((initialCursor as number) + 1);
      await record("distinct-starter-cursor-confirmed");
      await guest!.page.keyboard.press("z", { delay: 65 });
      await expect.poll(() => ui(guest!), { timeout: 25_000 }).toBe("OPTION_SELECT");
      await record("pokemon-options-open");
      await guest!.page.keyboard.press("z", { delay: 65 });
      await expect.poll(() => ui(guest!), { timeout: 25_000 }).toBe("STARTER_SELECT");
      await record("options-selected");
      // Observe asynchronous callbacks without sending extra input.
      for (let i = 0; i < 6; i++) {
        await guest!.page.waitForTimeout(200);
        await record("settle-" + i);
      }
      await guest!.page.keyboard.press("Enter", { delay: 65 });
      await record("post-enter-immediate");
      for (let i = 0; i < 105; i++) {
        // After the original eight-second observation, compare the same
        // running game with the guest page explicitly brought to the front.
        if (i === 40) {
          await record("pre-foreground-intervention");
          await guest!.page.bringToFront();
          await record("post-foreground-intervention");
        }
        await guest!.page.waitForTimeout(200);
        await record("post-enter-" + i);
        if (await ui(guest!) === "CONFIRM") { pass = true; break; }
      }
      expect(pass, "real Enter must reach the correct Ready confirmation").toBe(true);
    })();
    await Promise.all([readyHost, readyGuest]);
  } catch (e) {
    problem = String(e).slice(0, 500);
    throw e;
  } finally {
    try { if (guest) inputTrace = await readInputTrace(guest.page); } catch { /* crashed browser */ }
    // Always export only structural handler metadata, no codes/cookies/pixels.
    await mkdir("test-results/acceptance", { recursive: true });
    await writeFile("test-results/acceptance/p0-ready-mode-diagnostic.json",
      JSON.stringify({
        schema: "sam.coop.qa.physical_ready_mode_observation.v1",
        sourceSha: process.env.GITHUB_SHA ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        pass, problem, samples, inputTrace,
      }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await Promise.allSettled([hostContext.close(), guestContext.close()]);
  }
});
