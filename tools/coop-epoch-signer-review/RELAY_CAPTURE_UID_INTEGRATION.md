# SAM co-op relay / capture / signer isolation — owner integration contract

**2026-10-31. STAGED ONLY. No production accounts or service changed.**

This document defines the minimum viable production trust boundaries for the
private scene-pair transport. The public PNG/SSE viewer remains authoritative.

## Separate OS principals (do not collapse these)

- `sam-coop-relay`: a dedicated non-root Linux UID for the real Node relay
  and the Python credential-checking gateway. Must not share a UID with
  `sam3201`, browser processes, capture owner or signer.
- `sam-coop-capture`: dedicated trusted capture coordinator, allowed to
  request a one-time room binding through an AF_UNIX peer-authenticated gateway.
  Must be distinct from the signer and relay and must not run untrusted
  Chromium/browser or model code under this same UID.
- `sam-coop-signer`: separate private-key custodian that only signs a
  configured run's one-time grant after SO_PEERCRED UID authentication.
- `sam-coop-game` (recommended): a distinct restricted untrusted browser/game
  UID without membership in the signing/owner IPC group. This is crucial:
  SO_PEERCRED authenticates a UID, not a trusted executable, so spawning
  Chromium under the capture-owner UID defeats per-process trust.
- `sam3201`: current general SAM account; no permission to invoke privileged
  production grant IPC directly or read signing keys.

## Relay filesystem topology (not yet provisioned)

```text
/run/sam-coop-relay/                    sam-coop-relay:sam-coop-ipc 0750
  capture/                              sam-coop-relay:sam-coop-ipc 0750
    capture-owner-gateway.sock          sam-coop-relay:sam-coop-ipc 0660
  private/                              sam-coop-relay:sam-coop-ipc 0700
    owner-grants.sock                   sam-coop-relay:sam-coop-ipc 0600
```

The Python gateway verifies `SO_PEERCRED` against the configured capture
coordinator UID before opening the private Node-owned backend. The Node
broker still performs Ed25519 signature verification, room/challenge/digest
matching, expiry and replay prevention.

Production gateway source **must** be root-owned, non-user-writable and run
via isolated Python `-I`; the current
`private_relay_peer_gateway_v1.py` and
`run_relay_gateway_lab_fixture_v1.py` are **lab code**, not trusted
install artifacts. Never install the lab-only same-UID fixture.

Signer path (also not provisioned):

```text
/var/lib/sam-coop-signer/               sam-coop-signer 0700
  owner-ed25519.pk8                     sam-coop-signer 0600
/run/sam-coop-signer/                   sam-coop-signer:sam-coop-ipc 0750
  room-grant-signer.sock                sam-coop-signer:sam-coop-ipc 0660
```

The capture coordinator needs IPC-group access but never key-file access.

## What passes in isolation

- `test_private_relay_peer_gateway_v1.py`: 10 tests; reject unauthorized
  SO_PEERCRED UID, bad socket permissions, extra response fields, malformed
  requests and path substitution.
- `run_real_disposable_peer_gateway_v1.mjs`: genuine Node broker + Python
  AF_UNIX gateway with an accepted owner-enrollment grant and paired
  checkpoint. The fixture uses one test UID: **not** a distinct-UID proof.
- `capture_owner_room_enrollment_v1.mjs`: single-use, fail-closed private
  owner enrollment, 12/12 tests.
- `preflight_owner_isolation_v1.py`: 11 static metadata/identity checks,
  read-only, expected to exit 2 until provisioned. Even all-green static
  checks do **not** prove the capture epoch or permit renderer promotion.

## Required owner-controlled deployment sequence

1. **Finish Mac/Pi consolidation coordination** and acquire the capture
   writer's ownership/lock. Do not replace untracked active
   `test/e2e/coop-agents.spec.ts` or restart the public relay.
2. Privileged administrator reviews all code, creates distinct UIDs/groups,
   ensures Chrome and general SAM workers do not run under capture UID,
   installs trusted root-owned code and pinned config, then separately
   provisions the signer key and its lifecycle. No test bypass in production.
3. Move/launch a disposable authenticated relay under the dedicated relay
   UID, with root-managed permissions and both Unix sockets. Validate the
   actual distinct-UID positive/negative gateway and signer cases: only
   `sam-coop-capture` connects, `sam3201`/browser/replay fails, backend
   remains private, and no group can modify parent/socket paths.
4. Under the relay worker's lock, integrate its existing V3 owner hook
   patch, and the capture-owner grant path. Observe host/guest concordant
   checkpoints without trusting browser-supplied run IDs.
5. Under the gameplay capture worker's lock, freeze each real Phaser scene
   at its own `postrender`, capture PNG+scene within each freeze, bind to one
   relay-owned logical checkpoint unchanged before/after, and issue trusted
   evidence. Always unfreeze in `finally`.
6. Prove authentic two-seat multi-frame pixel parity, bounded performance,
   rights-cleared content-addressed game textures, tamper rejection and
   browser fallback before enabling any client-side scene renderer.

If any gate fails, preserve the existing PNG frame-pair/SSE public viewer.
No production signing claims or release eligibility may be inferred from
lab signatures or static preflight metadata alone.
