/** PokéRogue autonomous starters — game-authoritative and per-player. */
function validNumber(x, min, max) {
  return typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
}
export function caught(attr) {
  if (typeof attr === "bigint") return attr > 0n;
  if (typeof attr === "number") return Number.isSafeInteger(attr) && attr > 0;
  return typeof attr === "string" && /^[0-9]{1,80}$/.test(attr) && BigInt(attr) > 0n;
}
export function validateStarterSnapshot(snapshot) {
  if (!snapshot || !["host", "guest", "solo"].includes(snapshot.seat)
    || snapshot.source !== "loaded-game-dex" || snapshot.ui !== "STARTER_SELECT"
    || !Array.isArray(snapshot.candidates)
    || snapshot.candidates.length < 1 || snapshot.candidates.length > 2048
    || !validNumber(snapshot.budget, 0.5, 100)
    || !Number.isInteger(snapshot.partyLimit)
    || snapshot.partyLimit < 1 || snapshot.partyLimit > 6) {
    throw new Error("invalid or unverified game starter snapshot");
  }
  const ids = new Set(), grid = new Set();
  const candidates = snapshot.candidates.map(c => {
    if (!c || !Number.isInteger(c.speciesId) || c.speciesId <= 0
      || !Number.isInteger(c.gridIndex) || c.gridIndex < 0 || c.gridIndex >= 2048
      || !validNumber(c.cost, 0.5, 100) || typeof c.selectable !== "boolean"
      || !["string", "number", "bigint"].includes(typeof c.caughtAttr)
      || ids.has(c.speciesId) || grid.has(c.gridIndex)) {
      throw new Error("invalid/duplicate game starter entry");
    }
    ids.add(c.speciesId); grid.add(c.gridIndex);
    return Object.freeze({
      speciesId: c.speciesId, gridIndex: c.gridIndex, cost: c.cost,
      owned: caught(c.caughtAttr), selectable: c.selectable,
      caughtCount: Number.isSafeInteger(c.caughtCount) && c.caughtCount >= 0 ? c.caughtCount : 0,
    });
  });
  return Object.freeze({seat: snapshot.seat, budget: snapshot.budget, candidates});
}
export function rankEligibleStarters(snapshot, scores = {}) {
  const x = validateStarterSnapshot(snapshot);
  const legal = x.candidates.filter(c => c.owned && c.selectable && c.cost <= x.budget);
  if (!legal.length) throw new Error("no verified owned and affordable starter");
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) throw new Error("bad scores");
  const anyScore = legal.some(c => Object.hasOwn(scores, String(c.speciesId)));
  const ranked = legal.map(c => {
    const value = scores[String(c.speciesId)];
    if (value !== undefined && !validNumber(value, -1000, 1000)) throw new Error("invalid model score");
    const noveltyProxy = c.caughtCount > 0 ? 0.25 / Math.sqrt(c.caughtCount) : 0;
    const utility = (value ?? 0) * 10 + noveltyProxy + (x.budget - c.cost) * 0.005;
    return {...c, utility};
  }).sort((a,b) => b.utility-a.utility || a.cost-b.cost || a.gridIndex-b.gridIndex);
  return {seat: x.seat, ranked, decisionSource: anyScore ? "model-score-with-game-eligibility" : "rules-fallback", anyScore};
}
export function planCoopStarters(host, guest, opts = {}) {
  const h = rankEligibleStarters(host, opts.hostScores ?? {});
  const g = rankEligibleStarters(guest, opts.guestScores ?? {});
  if (h.seat !== "host" || g.seat !== "guest") throw new Error("mismatched seat/save");
  const shared = opts.sharedBudget ?? Math.min(host.budget, guest.budget);
  if (!validNumber(shared, 0.5, 100)) throw new Error("invalid shared limit");
  let best = null;
  for (const hc of h.ranked) for (const gc of g.ranked) {
    if ((opts.requireDifferentSpecies ?? true) && hc.speciesId === gc.speciesId) continue;
    if (hc.cost + gc.cost > shared + 1e-8) continue;
    const score = hc.utility + gc.utility;
    if (!best || score > best.score + 1e-10
      || (Math.abs(score - best.score) <= 1e-10 && hc.gridIndex < best.host.gridIndex))
      best = {host: hc, guest: gc, score};
  }
  if (!best) throw new Error("no legal co-op starter pair in shared budget");
  return Object.freeze({
    host: {speciesId: best.host.speciesId, gridIndex: best.host.gridIndex, cost: best.host.cost},
    guest: {speciesId: best.guest.speciesId, gridIndex: best.guest.gridIndex, cost: best.guest.cost},
    sharedBudget: shared, source: "independent-loaded-game-dexes",
    decisionSource: h.anyScore && g.anyScore ? "model-scored" : "rules-or-partial-model-fallback",
    verifiedInGame: false,
  });
}
export function assessCapture(before, after, options = {}) {
  const speciesId = options.speciesId;
  if (!Number.isInteger(speciesId) || speciesId <= 0 || !before || !after)
    throw new Error("invalid capture evidence");
  const oldCount = Number(before.caughtCount ?? 0), newCount = Number(after.caughtCount ?? 0);
  const observed = options.inputAccepted === true && caught(after.caughtAttr)
    && Number.isInteger(oldCount) && oldCount >= 0
    && Number.isInteger(newCount) && newCount > oldCount;
  return Object.freeze({
    speciesId, catchObserved: observed,
    newlyUnlocked: observed && !caught(before.caughtAttr),
    availableInRun: observed,
    availableAfterRestart: observed && options.saveConfirmed === true,
    provenance: "game-dex-transition",
  });
}
