/** Pinned game-side source integrity for the shared SAM co-op modules.
 * The exact same Git blob IDs are checked by NN_C's parity verifier.
 * Deliberate upgrades require a coordinated version bump in both repos.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";

const pinned = Object.freeze({
  "pokerogue-starter-policy.mjs": "064862f7dcb3f123dc619e4cbfdec6503acd4f34",
  "pokerogue-starter-browser.mjs": "d5a2736e5abbb6375b70c52919b773a8cb6cfcd3",
  "pokerogue-seat-state.mjs": "9107bcac32cedcafff7874bb0375dbe0fd48e417",
  "pokerogue-capture-policy.mjs": "f7642183eb0ad262f9ac813282a18ec045ca967f",
});
function gitBlobSha(bytes) {
  const h=createHash("sha1");
  h.update(Buffer.from(`blob ${bytes.length}\0`));
  h.update(bytes);
  return h.digest("hex");
}
test("Four PokéRogue modules match the pinned NN_C integration release",()=>{
  for (const [file,sha] of Object.entries(pinned)) {
    const contents=readFileSync(new URL("./"+file,import.meta.url));
    assert.equal(gitBlobSha(contents),sha,`unexpected drift in ${file}`);
  }
});
