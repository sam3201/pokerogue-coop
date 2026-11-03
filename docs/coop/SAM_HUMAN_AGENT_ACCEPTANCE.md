<!--
SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

# SAM-owned Human + SAM/JevBot co-op: implementation and acceptance contract

**Status: proposed, not implemented or released.** The game/relay feature author is **SAM**; this document is supervisor-supplied architecture and acceptance criteria. Source review baseline: draft [gameplay PR #2](https://github.com/sam3201/pokerogue-coop/pull/2), `fc1ba2b` (November 2, 2026).

## Verified baseline

- Human/Human public matchmaking and chat, two real browsers/relay: [hosted Playwright PASS](https://github.com/sam3201/pokerogue-coop/actions/runs/41527550443).
- Human/Human wave-one battle to rewards, equal ordered checkpoint hashes and no desync: [hosted Playwright PASS](https://github.com/sam3201/pokerogue-coop/actions/runs/41573194482) on a test-only, faster rendering + longer reward poll harness, ~10.9 minutes.
- [Vitest five-shard PASS](https://github.com/sam3201/pokerogue-coop/actions/runs/41527113230): 3,449 passed, zero failed with per-file isolation. Pending review patches: [#5](https://github.com/sam3201/pokerogue-coop/pull/5) legacy tests, [#6](https://github.com/sam3201/pokerogue-coop/pull/6) isolation, [#7](https://github.com/sam3201/pokerogue-coop/pull/7) browser harness. All remain separate draft PRs.
- Scripted, **external-browser-input invited guest admission**: [hosted Chromium 2/2 PASS](https://github.com/sam3201/pokerogue-coop/actions/runs/41580879207), using physically acknowledged keyboard/canvas navigation, normal six-character room-code text entry, both live clients linked with verified host/guest seats and starter-selection state. Validated test-only patch is [draft PR #9](https://github.com/sam3201/pokerogue-coop/pull/9). The human host may use development test controls; SAM's model did **not** choose actions. This is a transport/input gate, not proof of AI gameplay.
- Scripted, **physical-keyboard guest starter and battle-turn progression**: [hosted Chromium 1/1 PASS](https://github.com/sam3201/pokerogue-coop/actions/runs/41673807353), 5.4m. Guest physical keys navigated starter/ready, entered `COMMAND` and `FIGHT`, and both clients reached later matching state-hash checkpoints with no reported desync. Passing source in [draft PR #9](https://github.com/sam3201/pokerogue-coop/pull/9) uses test-only `__coop` for read-only state/choice context, while host setup/actions are also scripted; **it does not prove SAM policy execution nor an explicit sequencer-envelope receipt**. The previous attempt failed a transient modal and was corrected by bounded cancel/acknowledge/retry.
- **Not yet established:** an actual SAM/JevBot-controlled co-op seat, policy-chosen legal gameplay actions, genuine ball throw/catch or public bot admission.
- Existing Pi SAM Pokémon controller has a `playwright-core` browser bridge (`bridge/daemon.js`) with `SAM_POKEROGUE_URL` default `https://pokerogue.net/`, a dedicated Chrome profile, an IPC socket, and a `worker/unit1.js` that invokes `PokemonSAM.decide`. Its `README.md` spans multiple legacy project stages; trust live code/config rather than treating the README as proof of current training or working co-op. **Do not repoint its active process/profile/socket.**

## Architectural invariant

`docs/coop/ARCHITECTURE.md` describes two complete browser game simulations with a deterministic host sequencer. The Node relay (`coop-server/src/relay-server.ts`) and Cloudflare Worker relay forward frames, maintain room/seat tokens and match clients, but do **not** simulate gameplay. `PROPOSE` / `SEQUENCED` / legality are client-level (`src/coop/sequencer.ts`, `bridge.ts`, `legal.ts`, `legal-view.ts`, `control.ts`). A policy-only WebSocket sender cannot impersonate a full second game client while preserving lockstep. An agent **needs its own real game client**, likely a dedicated browser context initially.

## Production browser input boundary (source-verified)

The passing co-op E2E tests drive `window.__coop.press(...)` in `test/e2e/coop-client.ts`, but `src/coop/debug-api.ts:494-507` installs `window.__coop` **only** in development/test builds (or builds explicitly configured with `VITE_COOP_E2E=1`); a normal production build intentionally exposes no such debug API. **Do not use that API as the production SAM controller.** Reading it to diagnose QA tests is fine, but agent gameplay needs real authenticated browser inputs and a separate observation/decision recording channel.

The existing Pi SAM browser bridge `bridge/daemon.js` already sends real keyboard codes: `UP=ArrowUp`, `DOWN=ArrowDown`, `A=KeyZ` (select/advance), `B=KeyX` (cancel), `SELECT=Enter` (starter submit), plus other keys. Those mappings must be **independently smoke-tested against the co-op fork** before the existing agent is adapted. The bridge also has a browser profile and local socket which must not be shared with any live controller. The current `PokemonSAM.decide` writes its own decision/transition telemetry, so read-only diagnostics must avoid invoking it, training, or `status.js` (which calls `ensureModels()`) as though they were pure reads.

### Input acknowledgments are safety-critical

Independent hosted physical-keyboard checks found non-deterministic menu navigation in the software-rendered browser: [run 41577517114](https://github.com/sam3201/pokerogue-coop/actions/runs/41577517114) opened co-op correctly but saw an intermediate cancel `MESSAGE`; [run 41577842058](https://github.com/sam3201/pokerogue-coop/actions/runs/41577842058) returned directly to `TITLE` on cancel; [run 41578086310](https://github.com/sam3201/pokerogue-coop/actions/runs/41578086310) retained the visible cursor on **New Game** after a physical `ArrowDown`, so the subsequent `Z` did **not** open the co-op menu and ended with a `Could not connect.` message. A trace screenshot independently confirmed the missed cursor movement. These are QA observations, **not** proof that a new game or server was modified. The agent adapter must use bounded **observe → act → verify rendered result** steps, never blindly chain `DOWN` then `Z`. Keep key pulses, per-UI cooldown, observed target position and stale-screen rejection in its telemetry. This is an operational acceptance requirement, not privileged game-state information for learning.

### Checkpoint provenance: turn start is not a completed move

`src/coop/checkpoint-log.ts` defines the `turn` checkpoint at **`TurnInitPhase.start`**, before the game asks its clients for `TURN_COMMANDS`. Therefore **one `turn` checkpoint, even if both hashes match, is not evidence that the guest chose a move or that the host sequenced it**. A genuine first-action acceptance needs an action provenance record plus the accepted sequenced decision and subsequent progress (second turn checkpoint, `waveEnd` or `rewards`) with matching checkpoint hashes and no desync. The first hosted physical-turn QA deliberately failed when it asserted an early turn hash and found no guest `COMMAND` input. Do not loosen this requirement to make hosted tests green.

## Existing SAM policy interface audit (read-only, 2026-11-03)

The Pi's **reconstructed** PokéRogue agent source was reviewed without invoking its worker or mutating its models:

- `worker/unit1.js` implements a **JSON-lines stdin/stdout** policy protocol, one request at a time: `{request_id, observation, history?, contract}` in, `{request_id, action, rationale, sam?}` out. On a worker exception the response is `WAIT`. `SAMhead_manager/worker-client.js` correlates by `request_id` and returns `WAIT` after its timeout. Preserve this interface and its bounded timeout for a separate co-op controller. Do not silently count a timeout or fallback as a learned action.
- `worker/pokemon-sam/brain.js` chooses between its actor and evidence-gated world model. The output `sam.source` may identify `actor` or `world-model`; the **actual action domain** is `UP`, `DOWN`, `LEFT`, `RIGHT`, `A`, `B`, `L`, `R`, `START`, `SELECT`, `WAIT`. It is **not** a `TURN_COMMANDS` payload and cannot bypass game legality. The worker does **not** currently return a model artifact digest or a policy version in its decision envelope; these must be attached by SAM at the owner-controlled policy boundary for independent provenance.
- `worker/pokemon-sam/features.js` encodes a **128-dimensional hashed feature vector** from `observation.tile_grid.tokens`, `changed`, prior action, and scalars. A raw screenshot or `__coop` object alone is **not** a compatible actor observation. `SAMhead_manager/head.js` runs a tile dictionary/tokenizer after capturing an image, constructs the compact observation, and retains historical action/feedback context. SAM must validate that the co-op browser's *rendered* observations yield nonempty, temporally meaningful tokens. Any separate 256-feature model family is not interchangeable with this actor without a verified adapter.
- A read-only checkpoint check found an actor JSON checkpoint with **64 recorded updates**, policy version **65** and nonzero weights across all 11 actions. This establishes that a *nonempty saved policy artifact exists in that reconstructed snapshot*; it **does not** establish present service activity, transferable co-op competence, model quality, or that any action in our passing hosted tests came from it. C2 counts and its legacy game distribution cannot be interpreted as evidence of co-op moves.
- `SAMhead_manager/head.js` already distinguishes the *requested action* from the *executed action*, `blocked`, `remapped`, `intervention` and outcome. Retain this causal distinction. The current action record does **not** carry an immutable model hash, co-op seat, decision key or sequenced receipt. SAM's isolated bridge should add these at a single correlation point rather than rewriting the learner or forging past history.

### SAM-owned minimum policy wiring

1. Run **only after the Mac/Pi owner releases a separate browser + worker resource slot**. Use a dedicated browser profile, IPC socket and `SAM_POKEMON_MODEL_DIR` **pointing at a copied, verified model snapshot**, with separate writeable telemetry. Never invoke the current instance from a shared directory (its `LiveModels` constructor can create default files and the learner writes decisions/transitions).
2. Build a local-only, session-scoped policy caller that sends **rendered-image-derived tile tokens**, not privileged game-state labels, to `unit1.js`; join via the normal guest browser flow verified in QA PR #9. Hash the exact observation bytes and model checkpoint bytes. Refuse empty tokens, wrong seat, stale screen, duplicate request, expired deadline, unexpected model response, or any action outside the permitted 11-key set. Record explicit `WAIT`/timeout/intervention without representing it as a successful model action.
3. Use only the **guest browser's physical input path**, with visible cursor acknowledgment before critical presses. Let the normal game client map inputs to its owned Pokémon commands. Correlate `request_id` -> policy output (`actor` or `world-model`) -> requested key -> actual executed key/outcome -> observed `TURN_COMMANDS` key and `SEQUENCED` **author=guest** receipt -> later equal state-hash checkpoints. Never claim that the original policy response directly produced a game command payload.
4. Provide a **redacted independent proof bundle** (timestamps, room ID hash not join code, build/model SHA-256, policy version and updates, request ID, observation hash and nonempty-token count, raw returned action/source, actual key/outcome, client seat, accepted decision key/seq/author, both checkpoint arrays). The supervisor must verify the worker process/actual model and game relay from live artifacts; a synthetic JSON fixture or internally consistent log alone is not authenticity proof.

The source audit is a **feasibility/handoff finding**, not an implemented or executed co-op policy bridge. **No existing Pi/Mac service or policy was started, stopped, trained, modified or copied.**

### Independent redacted proof consistency gate (QA-only)

The proposed test-only `scripts/verify-sam-guest-evidence.mjs` (stacked [draft PR #9](https://github.com/sam3201/pokerogue-coop/pull/9)) accepts **two local files**, never sends model bytes/room tokens to GitHub, and requires no game service:

```sh
node scripts/verify-sam-guest-evidence.mjs ./redacted-guest-proof.json ./copied-private-actor-v1.json
```

The first gate is deliberately restricted to `source: actor`, with the actual checkpoint file's SHA-256, `policy_version`, `updates > 0`, 128-feature action weights and nonempty token observation. An evidenced `world-model` selection needs a **separately hashed dynamics model** and a future gate; it must not be falsely attributed to the actor. The proof bundle must correlate unique policy `requestId` values and visual hashes with **applied, unblocked, unremapped real keyboard events** in `COMMAND` and `FIGHT`, guest-authored `TURN_COMMANDS` receipts from host and guest, and a later-than-turn-init checkpoint equal on both clients. The checker rejects claims drawn from scripted QA, fallback `WAIT`, wrong-seat/takeover, duplicates, blocked inputs, hash mismatch, or merely reaching `TurnInitPhase`.

**Security limit:** internally consistent JSON is **not** trusted process attestation. The reviewer must separately validate the real model process identity, live observation capture, browser profile ownership, relay/session receipts and checkpoint origin. Keep raw room join codes, seat tokens, private paths, model weights and screenshots out of published PRs and CI logs. The synthetic Node tests for this verifier establish only that the rejection gate works.

## Bounded SAM-owned implementation, in order

### A. Invite-only guest first: one real learned decision

1. **Admission:** Human creates a normal room; SAM joins its free guest seat through the normal build/handshake/invite code path. Use an independently owned SAM co-op browser context, separate Chrome profile and controller socket/port, dedicated log storage, separate build and capacity budget. No mutation of the existing Pi controller or active user sessions. Do not put a privileged debug API on the public page.
2. **Observation/action adapter:** Wrap the existing SAM decision worker with a local authenticated, single-owner adapter. Visual-only experiments receive rendered pixels + their own prior actions/observations, not hidden types/moves/outcomes as learning answers. Game state may be used by a **separate deterministic legality gate**, not supplied to the policy as privileged ground truth. Trace policy ID/version, observation hash, proposed action, rejection/approval, actual executed input and sequenced command independently. If the existing policy cannot give a valid command, report WAIT/no-op or use the established bounded takeover rules; never claim fallback decisions are learned.
3. **Normal command/UI pipeline:** For an owned Pokémon, SAM must drive its actual client input/command path; it cannot inject `SEQUENCED` from a server or choose for the human's Pokémon. Preserve `src/coop/decision-keys.ts`, turn command validation, same-owner faint replacement, local legality, host's order authority and state-hash exchange.
4. **Proof:** Independently verify one non-fabricated, policy-selected legal command during a real two-browser co-op run. Trace which agent model selected it and show accepted `TURN_COMMANDS`, matching hashes and no desync. Scripted FIGHT-only input is a browser smoke test, **not** proof of autonomous learned control.

### B. Ball/catch and cooperative choices

5. SAM must independently decide *whether* and *how* to catch. PR #2's `src/coop/agent-capture-lesson.ts` is a **read-only validation/teaching gate**; it is not the policy and never bypasses `CommandPhase → Ball UI → SIDE_ACTION → CATCH_RELEASE`.
6. Test legal one-opponent target, available ball, own-party capacity (three Pokémon per owner), partner approval, master-ball policy and own-release choice. Human-owned creatures must not be released/commanded by SAM.
7. Log distinct `capture_requested`, `side_action_approved`, `ball_executed` and `game_outcome` states. Attempted throws, successful captures and failures are different facts. No fabricated training success.
8. Validate turn, reward, biome, trade/decline, owner wipe, reconnect and AFK takeover, with equal ordered checkpoint hashes on both real browsers. Stop/rejoin must not lose either seat's save or steal its token.

### C. Only then public opt-in

9. Provide explicit **Play with SAM** admission, never replace default Human/Human matchmaking silently. Allocate bot client capacity *before* offering/confirming a seat. Unavailable resources must yield a truthful unavailable response and normal Human/Human alternative. Scope bot reservations and rate limits per owner/session.
10. If matchmaking or seat allocation changes, maintain **Node/Worker parity** (`coop-server/src/matchmaker.ts`, `coop-worker/src/matchmaker.ts`) and existing FIFO/build matching, cancellation, token rejoin and anti-impersonation. Do not leak browser profile, controller IPC, privileged model endpoints or seat token to another user. On disconnect/owner Stop, release only resources owned by this session, never terminate existing live SAM game/relay workers.

## Minimum independent acceptance

- [ ] Two *different* live clients; one controlled by SAM's policy, one controlled by the human or an explicit owner-authorized test driver.
- [ ] SAM joins normal invite via free guest seat; handshake, starter ready and wave-one reward work. Both report zero desync and matching ordered hashes.
- [ ] Recorded policy-selected legal game action with model ID, input provenance, legal validator result, actual execution and `SEQUENCED` receipt; not a scripted default masquerading as training.
- [ ] Real capture proposal is accepted or rejected properly; observed game result recorded accurately; partner-owned release forbidden.
- [ ] Stale/duplicate proposal denied, wrong seat token denied, partner declines side action, bounded timeout/takeover and reconnect/rejoin safely demonstrated.
- [ ] Public SAM option only admits when an actual client+worker is available; no unconsented bot assignment, no game client takeover and Human/Human regression.
- [ ] Focused co-op tests, full Vitest, both relay backends as relevant, real two-browser E2E, actual model-controlled co-op acceptance are independently green.
- [ ] Merger ownership and shared resource holds released; isolated worktree; no restart/stop of existing workers, inference load test, merge or production deploy without owner-approved capacity.

## Owner/resource gate

As indicated by read-only host checks, the existing owner-supervised worker queues are congested and the host is under material compute/storage pressure. Preserve current live resource reservations; remeasure before scheduling. **Mac/Pi merger remains the user's top priority.** Do not queue duplicate work or start another browser/model under these constraints. Resume SAM-authored code only through its approved isolated worker after merger/ownership and compute gates clear.

This contract's review/merge is **not** acceptance of the feature itself. Implementation and evaluation must be evidenced separately.
