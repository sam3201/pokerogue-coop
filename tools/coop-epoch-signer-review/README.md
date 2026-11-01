# SAM co-op capture-owner trust boundary — review-only

This is a non-production, isolated code-and-test snapshot of the SAM/JevBot
scene-epoch signer, relay credential gateway and owner-enrollment protocol.
No private keys, room tokens, browser state, game artwork or captured PNGs
are stored here. Do not start an elevated signer or relay from this checkout.

## What this review branch verifies

- A one-run Ed25519 signer checks `SO_PEERCRED`, pinned public-key digest,
  scope, expiry and single use. A distinct-UID CI fixture validates real
  Linux Unix-socket permissions and denial of other IPC-group members.
- A Linux relay gateway checks the capture peer's UID before forwarding to
  a private Node broker socket. A disposable distinct-UID CI fixture proves
  both that an IPC-group outsider is rejected and that capture cannot open
  the backend directly.
- Owner enrollment rejects malformed/stale challenges, wrong run/seat
  bindings and repeat submissions in Node tests.
- Deployment preflight checks eleven **static** prerequisites, including
  distinct signer, relay and capture UIDs, protected filesystem parents,
  service metadata, IPC group permissions and root-managed code/config.
  It *never* authorizes scene reconstruction or asserts authenticated
  capture, even if every static check becomes green.
- The source-hash manifest validates three proposed trusted-install signer
  files. The staged relay owner-hook patch passes `git apply --check` without
  changing the running relay.

The GitHub Actions workflow runs the focused security tests, Node adapter
tests, disposable Node/Python gateway fixture, both root-only separate-UID
integration tests, hash verification and the unapplied patch check.

## Guarded account/code staging — not automatically applied to the Pi

`stage_owner_isolation_v1.sh` is an opt-in bootstrap for a reviewed
Linux machine. The default mode (`--plan`) only validates pinned sources
and describes intended writes. On a disposable Linux CI runner,
`--apply` and `--verify` prove creation of separate non-login signer,
capture, relay and game identities; the isolated IPC group; a root-owned
digest-verified signer code tree; and an **empty** private state directory.
A second `--apply` must succeed idempotently.

The script deliberately does NOT install signing keys, create a pin,
enable a service, open IPC, alter the live relay/game, or make scenes
production-eligible. Its 11-check preflight must still be fail-closed.

The remote management interface rejected the proposed privileged Pi
execution, so **the script was NOT applied to that device**. No account,
key or service provisioning should be claimed for the Pi from passing CI.
A trusted administrator should review the exact commit and coordinate
with the owner of the Mac/Pi migration before running it on the Pi.

## Replay-hardening correction

A closed relay room must revoke its active observer registration without
releasing the single-use `runId` for reauthorization to another room.
The review broker retains spent run IDs for its process lifetime and has
a dedicated negative regression test. This code is NOT applied to the
currently active relay.

## Full cross-UID enrollment test (disposable Linux)

`test_three_principal_room_enrollment_v1.py` runs **four distinct numeric
UIDs** in a temporary CI filesystem: relay (real Node broker and Python
SO_PEERCRED gateway), capture coordinator (Node enrollment client), signer
(real one-use Python Ed25519 entrypoint) and an unauthorized outsider.
The gateway and signer IPC use separate group-reachable sockets; the relay's
Node broker socket remains mode 0600 behind a 0700 private directory.

This test verifies trusted code-copy checksums, root-managed executable
copies, Unix socket ownership/permissions, outsider denial despite shared
IPC-group access, capture access denial to the private backend, rejection of
a wrong host token, successful one-time signed room authorization, a
diagnostic two-seat checkpoint match, signer exit and signer-socket cleanup.

Passing this test is **not** production key custody, a running live game
relay, capture-worker provenance, a same-postrender scene/PNG pair, or
browser-renderer production readiness. The synthetic fixtures and all
temporary keys are deleted after the CI run. Production accounts and
service files remain unprovisioned on the Pi.

## Independent two-seat Chromium postrender check

Hosted CI now launches two real headless Chromium tabs displaying **generated
canvas imagery**, using a self-contained synthetic Phaser-like loop and the
isolated `owner_postrender_bridge_v1.mjs` capture adapter.

- Both tabs acquire a unique browser-side postrender lease, freeze their own
  render loops, capture a bounded sprite scene and PNG, and independently
  verify the lease token and exact render tick **after screenshot completion**.
- The synthetic two-seat private epoch diagnostic contains hashes for both
  PNGs and scenes and a stable mock logical checkpoint before and after
  capture. It is explicitly not a relay-issued signed checkpoint.
- Both tabs always resume, including after one tab's forced screenshot
  exception; the coordinator awaits both seat cleanup paths.
- If a separate script advances a frozen tick after screenshot but before
  lease verification, the corresponding seat rejects with a lease error,
  the pair fails closed and both loops are resumed.

The CI fixture measures correct synthetic capture behavior, **not** real
gameplay fidelity, synchronized browser frame numbers, authenticated relay
provenance, 30 FPS production performance, or permission to distribute game
textures. Different tabs can have different render ticks while holding the
same logical checkpoint; that is intentional and does not prove a common
physical render instant. The reviewed helper still sets
`sceneEpochAttested:false` and `productionSceneEligible:false`.

The expanded in-memory scene/transport suite contains **182/182 passing**
Node tests. The dedicated Chromium smoke test additionally verifies the
real browser lifecycle and explicit frame-tick tamper rejection.

## Atomic paired-frame browser presenter — manual Next, not delayed async paint

`VerifiedPairCursor` accepts only verified, consecutive same-run pairs, and
stages **detached copies** of scene objects and texture bytes. Future caller
mutation cannot retroactively corrupt an admitted pair. An admission counter
is monotonic across resets so a stale prepared pane cannot be replayed even
when the same run/frame identity is restaged.

`PairedFramePresenter` builds both seat panes detached from the visible DOM.
The manual Next press synchronously swaps one complete parent containing
both seats in a **single** `replaceChildren` operation, then accepts the
matching cursor admission. If no fully built pair is ready, pressing Next
does not advance or blank the view. Failure during preparation leaves the
prior visible pair unchanged; a failed cursor acceptance restores the
prior pane. These are private demonstration primitives, not a deployment.

Two independent real-Chromium tests run in hosted CI:

- `run_atomic_paired_manual_step_v1.mjs`: synthetic cached pairs step
  **0 -> 1 -> 2**, proving no half-pair display, no change on an extra
  press, rejection of failed seat rendering, and replay denial after a
  reset with identical run/frame IDs.
- `run_verified_atomic_browser_pipeline_v1.mjs`: generates a disposable
  Ed25519 signing key and CC0 fixture PNG, binds and signs two synthetic
  scene pairs, verifies signatures using **browser WebCrypto**, fetches
  only approved SHA-256 PNG bytes, pre-renders both seat canvases, and
  atomically commits the two signed frame identities on manual presses.
  Forged signatures or crossed/mismatched seat sequences fail **before**
  the fetch/display state advances.

Hosted CI at this checkpoint passed **183/183** synthetic Node scene/transport
tests, both Chromium manual-frame tests, independent synthetic postrender
freeze/unfreeze tests, V4–V6 disposable relay fixtures, combined cross-UID
signing and relay gateway tests, and guarded provisioning checks.

No production claims follow from these test fixtures: the independent
signing key is *not* a production relay key, visual textures are generated
sample bytes, no real game/Phaser frame accuracy or steady 30 FPS throughput
has been benchmarked, and the public viewer was not modified.

## Verified texture-to-canvas drawing and synthetic timing diagnostic

`verified_canvas_pair_renderer_v1.mjs` bridges a browser-verified, detached
scene/texture pair to the existing `PhaserSpriteCanvas` compositor. It
decodes **only previously verified approved PNG byte arrays** into in-memory
bitmaps, creates independent detached 320x180 or 640x360 canvases for SAM
and JevBot, and refuses absent textures, unsupported draw protocols and
stale admission identities. Browser presentation remains synchronous and
atomic on the manual Next press; renderer preparation never replaces the
visible DOM. It does not assert a real game capture's completeness.

`run_verified_atomic_browser_pipeline_v1.mjs` now tests **actual decoded
fixture pixels** rather than placeholder canvas colors. The generated
1x1 RGBA test texture produces an exact expected [22,48,91,255] pixel
on both 320x180 canvases after signature verification and approved PNG
fetching. Both seats are prepared before the parent pane is swapped.

`run_synthetic_verified_frame_benchmark_v1.mjs` is a reproducible
hosted-CI-only throughput diagnostic for 48 consecutive, signed synthetic
scene pairs, 48 sprite draws **per seat per frame**, one SHA-256-approved
generated PNG fetch per pair, verification, decoding, compositing, atomic
presentation and an animation-frame callback after each commit. Its
measured medians and p95 are included in the CI log, but **not enforced
as a production performance threshold** because hosted runner CPU/GPU,
headless Chromium, mock network and original-game capture load differ
substantially from the Pi and real browser clients.

The callback measured by `requestAnimationFrame` occurs **before** the
browser paint; therefore the timing is labeled `totalToRaf`, not
physical display latency. Real frame presentation frequency, framebuffer
pixel parity, dynamic effects and sustained 30 FPS on the live game remain
independent unpassed acceptance gates.

## Agnostic XOR diagnostics — optional, byte-complete, commit-bound

`agnostic_xor_frame_diagnostics_v1.mjs` adds an optional, bounded
**post-verification diagnostic**, independent of frame admission. It
scans the complete visible pixel bytes with XOR, counts changed pixels,
changed channel bytes, flipped bits and dirty 8/16/32/64-pixel tiles, and
records first-changed coordinates. Buffer, Uint8Array/ClampedArray,
DataView, other ordinary typed-array views, or ArrayBuffer are accepted
without assuming an input object type. One- through four-channel
images and padded rows use a generic bytewise fallback. Properly
aligned, tightly packed 4-channel RGBA instead uses a Uint32Array
word-per-pixel fast path. A dedicated regression proves identical
results between the two paths, including dirty-tile maps.

The implementation explicitly rejects SharedArrayBuffer, mismatched
dimensions/stride, excessive sizes, untrusted runs and repeated or
out-of-order admission IDs. A two-phase `PrivateAgnosticXorPairTracker`
only advances its baseline after a **successful atomic paired-frame
viewer commit**, not when a candidate frame is staged, rejected or
discarded. It snapshots bytes to prevent mutation after staging and
retains an admission high-watermark across reset. Seat changes may
legitimately differ: asymmetry is an **observation**, not automatic
evidence of desynchronization.

A folded XOR checksum is unsafe as a security fingerprint: two separate
byte changes can cancel to zero. Our full-byte scan explicitly tests this
counterexample. XOR diagnostics **never replace** a verified Ed25519
signature, SHA-256 asset validation, trusted relay provenance, real
scene attestation or producer-side replay protection. No XOR mask
or raw pixels are published, sent through the relay or written to
disk; the feature is disabled by default.

GitHub Actions runs the synthetic 48-frame / 48-sprite-per-seat
Chromium pipeline twice, once with no XOR and once with
`SAM_XOR_DIAGNOSTIC=1`, and reports separate pixel readback and XOR
scan times. In green hosted CI run #133:

| Metric (hosted CI only) | XOR off | XOR on |
| --- | ---: | ---: |
| Total median to next requestAnimationFrame | 5.5 ms | 6.3 ms |
| Total 95th percentile to next requestAnimationFrame | 21.6 ms | 21.4 ms |
| XOR readback median / p95 | — | 0.3 / 0.5 ms |
| Optimized XOR scan median / p95 | — | 0.5 / 0.8 ms |

The enabled run completed 47 temporal comparisons, detected 47
changed frame pairs and 61,619 changed seat-pixels in total. All
48 synthetic transactions in each run were below 33.3 ms to rAF.
Sample size and runner scheduling make the differences descriptive
rather than a robust performance guarantee. The rAF callback happens
before actual paint. Real gameplay remains unverified.

## Release blocks remain

1. Mac/Pi consolidation and concurrent gameplay ownership: do not touch the
   running writer's untracked source or seize its lock.
2. Real separate-UID service provisioning, root-controlled immutable install,
   owner-only signing key, authenticated peer sockets, key rotation and
   rollback. CI's numeric identities and keys are disposable fixtures.
3. Owner-controlled relay integration and genuine room-to-run enrollment.
4. Trusted *same-postrender* two-seat scene+PNG receipts, multiple actual
   gameplay frame fidelity tests, performance/cancellation and rejection tests.
5. Distribution approval for any real game textures. Do not export the
   repository's non-reusable/fair-use-only Pokémon artwork.
6. Rerun the *full* private relay acceptance after the latest changes; focused
   CI and patch applicability are not equivalent to the complete live test.

Use only the existing verified public paired-PNG/SSE viewer in production.
This branch is deliberately a draft PR, not a deployment authorization.
