/**
 * Read-only PokéRogue E2E browser bridge for autonomous starter decisions.
 * Uses local browser rendering and the game's own collection + button APIs.
 * Dev-only: game must be served with COOP_E2E=1. Not a production API.
 */
import {planCoopStarters} from "./pokerogue-starter-policy.mjs";

export async function readStarterScreen(client, seat) {
  return client.page.evaluate(async requestedSeat => {
    if (window.__coop?.ui !== "STARTER_SELECT") throw new Error("not on starter screen");
    const {globalScene} = await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    const h = globalScene.ui.getHandler();
    if (!Array.isArray(h?.filteredStarterIds) || typeof h.getValueLimit !== "function")
      throw new Error("unsupported starter handler");
    const gameData = globalScene.gameData;
    if (!gameData?.dexData || !gameData?.starterData) throw new Error("game save not loaded");
    return {
      seat: requestedSeat, ui: "STARTER_SELECT", source: "loaded-game-dex",
      budget: Number(h.getValueLimit()),
      sharedLimit: Number(h.coopUi?.sharedLimit ?? h.getValueLimit()),
      partyLimit: 6,
      candidates: h.filteredStarterIds.map((speciesId, gridIndex) => {
        const dex = gameData.dexData[speciesId];
        const attr = dex?.caughtAttr ?? 0n;
        return {
          speciesId: Number(speciesId), gridIndex,
          cost: Number(gameData.getSpeciesStarterValue(speciesId)),
          caughtAttr: String(attr), caughtCount: Number(dex?.caughtCount ?? 0),
          // The UI has already removed globally invalid challenge starters.
          selectable: attr > 0n,
        };
      }),
    };
  }, seat);
}

export async function readGridSelection(client) {
  return client.page.evaluate(async () => {
    const {globalScene} = await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    const handler = globalScene.ui.getHandler();
    return {
      gridIndex: Number(handler.cursor) + 9 * Number(handler.scrollCursor),
      partyStarterIds: [...(handler.partyStarterIds ?? [])].map(Number),
    };
  });
}

/** Only real player button commands may navigate; never set private handler state. */
export async function moveStarterCursor(client, target, press) {
  if (!Number.isInteger(target) || target < 0 || target > 2047) throw new Error("invalid starter index");
  const first = await readGridSelection(client);
  if (first.gridIndex !== 0) throw new Error("starter cursor must start at first grid position");
  for (let i = 0; i < Math.floor(target / 9); i++) {
    await press(client, "DOWN");
    await client.page.waitForTimeout(100);
  }
  for (let i = 0; i < target % 9; i++) {
    await press(client, "RIGHT");
    await client.page.waitForTimeout(100);
  }
  const last = await readGridSelection(client);
  if (last.gridIndex !== target) throw new Error("starter navigation did not reach selected grid index");
}

async function chooseAndReady(client, seat, selection, api) {
  await moveStarterCursor(client, selection.gridIndex, api.press);
  const fresh = await readStarterScreen(client, seat);
  const candidate = fresh.candidates.find(c => c.gridIndex === selection.gridIndex);
  if (!candidate || candidate.speciesId !== selection.speciesId
    || candidate.caughtAttr === "0") throw new Error("saved starter ownership or order changed");
  await api.pressUntil(client, "ACTION", "OPTION_SELECT");
  await api.pressUntil(client, "ACTION", "STARTER_SELECT");
  const confirmed = await readGridSelection(client);
  if (!confirmed.partyStarterIds.includes(selection.speciesId))
    throw new Error("game rejected selected starter");
  await client.page.waitForTimeout(500);
  let submitted = false;
  for (let attempt = 0; attempt < 12 && !submitted; attempt++) {
    submitted = await client.page.evaluate(() => window.__coop.ui === "STARTER_SELECT" && window.__coop.press("SUBMIT"));
    if (!submitted) await client.page.waitForTimeout(500);
  }
  if (!submitted) throw new Error("game rejected ready/submit");
  await api.expectConfirm(client);
  // The second player becoming ready may start wave one immediately. Requiring
  // the transient STARTER_SELECT screen would reject a legitimate co-op start.
  await api.press(client, "ACTION");
  let accepted = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await client.page.evaluate(() => ({
      ui: window.__coop?.ui ?? "",
      wave: Number(window.__coop?.phase?.wave ?? 0),
    }));
    if (state.ui === "STARTER_SELECT" || state.wave >= 1) {
      accepted = true;
      break;
    }
    if (state.ui === "CONFIRM" && attempt > 0 && attempt % 12 === 0)
      await api.press(client, "ACTION");
    await client.page.waitForTimeout(250);
  }
  if (!accepted) throw new Error("starter confirmation neither returned nor started the run");
  return {speciesId: selection.speciesId, gamePartyAcknowledged: true};
}

/**
 * Call after both player clients show the title screen. Scores must be supplied
 * by each model; otherwise an explicit deterministic rules fallback is used.
 */
export async function startAutonomousCoopRun(host, guest, api, scores = {}) {
  await api.linkClients(host, guest);
  // Co-op linked is not the same as starter UI ready. The existing scripted
  // runner polls STARTER_SELECT before sending any starter input.
  await Promise.all([host, guest].map(async client => {
    for (let attempt = 0; attempt < 240; attempt++) {
      if (await client.page.evaluate(() => window.__coop?.ui === "STARTER_SELECT")) return;
      await client.page.waitForTimeout(250);
    }
    throw new Error("co-op linked but starter select never became ready");
  }));
  const [h, g] = await Promise.all([
    readStarterScreen(host, "host"), readStarterScreen(guest, "guest")
  ]);
  const plan = planCoopStarters(h, g, {
    hostScores: scores.host ?? {}, guestScores: scores.guest ?? {},
    sharedBudget: Math.min(h.sharedLimit, g.sharedLimit),
  });
  const gameConfirmations = await Promise.all([
    chooseAndReady(host, "host", plan.host, api),
    chooseAndReady(guest, "guest", plan.guest, api),
  ]);
  await api.untilWaveOne(host, guest);
  return {...plan, gameConfirmations, verifiedInGame: true};
}
