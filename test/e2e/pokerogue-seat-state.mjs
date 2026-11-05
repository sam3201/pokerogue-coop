/**
 * Local, seat-separated PokéRogue saved-Pokédex persistence for automated tests.
 * Reads/writes only game-generated localStorage data_* values; never cookies,
 * bearer tokens, account passwords, or fabricated caught attributes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA = "sam.pokerogue.private.local_game_save.v1";
const MAX_SAVE_BYTES = 16 * 1024 * 1024;
const SEATS = new Set(["sam", "jevbot"]);
const KEY_PATTERN = /^data_[A-Za-z0-9_.-]{1,80}$/;

function assertSeat(seat) {
  if (!SEATS.has(seat)) throw new Error("unknown seat");
}
function requireLoopback(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("seat save requires the local test origin");
  return url.origin;
}
function seatPath(dir, seat) {
  assertSeat(seat);
  return path.join(dir, seat + ".json");
}
function valuesFromStorage(data) {
  if (!Array.isArray(data)) throw new Error("invalid storage payload");
  const result = [];
  const keys = new Set();
  for (const item of data) {
    if (typeof item?.name !== "string" || !KEY_PATTERN.test(item.name)
      || typeof item.value !== "string" || item.value.length > MAX_SAVE_BYTES
      || keys.has(item.name)) throw new Error("unsafe game save key or value");
    keys.add(item.name);
    result.push({name:item.name, value:item.value});
  }
  if (!result.length || JSON.stringify(result).length > MAX_SAVE_BYTES)
    throw new Error("no valid game saves");
  return result;
}
export function validateSeatSnapshot(raw, seat, origin) {
  assertSeat(seat);
  const expectedOrigin = requireLoopback(origin);
  if (!raw || raw.schema !== SCHEMA || raw.seat !== seat
    || raw.origin !== expectedOrigin || !Array.isArray(raw.localStorage))
    throw new Error("wrong seat, origin, or snapshot schema");
  const localStorage = valuesFromStorage(raw.localStorage);
  const sha256 = crypto.createHash("sha256")
    .update(JSON.stringify(localStorage)).digest("hex");
  if (raw.sha256 !== sha256) throw new Error("saved collection checksum mismatch");
  return {localStorage, origin:expectedOrigin, seat};
}
export async function restoreSeatState(context, seat, dir, origin) {
  const expectedOrigin = requireLoopback(origin);
  const filename = seatPath(dir, seat);
  if (!fs.existsSync(filename)) return {seat, restored:false, reason:"no saved collection"};
  if (!fs.lstatSync(filename).isFile()) throw new Error("save path must be a regular file");
  const snapshot = validateSeatSnapshot(JSON.parse(fs.readFileSync(filename, "utf8")),
    seat, expectedOrigin);
  await context.addInitScript(({origin, localStorage: values}) => {
    if (window.location.origin !== origin) return;
    for (const entry of values) {
      // Never overwrite progress already created in this particular browser context.
      if (window.localStorage.getItem(entry.name) === null)
        window.localStorage.setItem(entry.name, entry.value);
    }
  }, snapshot);
  return {seat, restored:true, entryCount:snapshot.localStorage.length};
}
export async function checkpointSeatState(client, seat, dir, {flushGameSave=true}={}) {
  assertSeat(seat);
  const origin = requireLoopback(client.page.url());
  if (flushGameSave) {
    await client.page.evaluate(async () => {
      if (window.__coop?.ui !== "MODIFIER_SELECT")
        throw new Error("game save checkpoint requires co-op reward screen");
      const {globalScene} = await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
      if (!globalScene?.gameData || await globalScene.gameData.saveSystem() !== true)
        throw new Error("game did not confirm saveSystem");
    });
  }
  const browserState = await client.page.context().storageState();
  const originState = browserState.origins.find(x => x.origin === origin);
  const localStorage = valuesFromStorage(
    (originState?.localStorage ?? []).filter(x => KEY_PATTERN.test(x.name))
  );
  const json = {
    schema:SCHEMA, seat, origin,
    savedAt:new Date().toISOString(),
    localStorage,
    sha256:crypto.createHash("sha256").update(JSON.stringify(localStorage)).digest("hex"),
    provenance:flushGameSave ? "game-saveSystem-confirmed-at-reward" : "browser-storage-only",
  };
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("save dir symlink refused");
  const filename = seatPath(dir, seat);
  const tmp = filename + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, JSON.stringify(json) + "\n", {flag:"wx",mode:0o600});
    fs.renameSync(tmp,filename);
  } finally {
    try {fs.unlinkSync(tmp);} catch {}
  }
  return {seat, saved:true, keys:localStorage.map(x=>x.name),
    checksum:json.sha256, verifiedGameSave:flushGameSave};
}
