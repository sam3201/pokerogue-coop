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
