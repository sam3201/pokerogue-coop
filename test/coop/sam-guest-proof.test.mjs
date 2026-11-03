/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifySamGuestEvidence } from "../../scripts/verify-sam-guest-evidence.mjs";

const ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "L", "R", "START", "SELECT", "WAIT"];
const sha = x => createHash("sha256").update(x).digest("hex");

function actorBytes({ updates = 64, nonzero = true } = {}) {
  const weights = Object.fromEntries(ACTIONS.map(action => [action, Array(128).fill(0)]));
  if (nonzero) weights.A[0] = 0.125;
  return Buffer.from(JSON.stringify({
    schema_version: 1, policy_version: 65, updates, feature_dim: 128, actions: ACTIONS, weights,
  }));
}

function proof(bytes) {
  const key = { wave: 1, turn: 1, kind: "TURN_COMMANDS", ref: 25 };
  const event = (id, ui) => ({
    requestId: id, observationSha256: sha("frame:" + id), tileCount: 144,
    source: "actor", fallback: false, action: "A", ui,
    ack: {
      requestId: id, seat: "guest", channel: "physical-keyboard",
      requestedAction: "A", executedAction: "A",
      outcome: "APPLIED", ok: true, blocked: false, remapped: false, intervention: false,
    },
  });
  const checkpoints = [
    { index: 0, kind: "waveStart", wave: 1, turn: 0, hash: "wave-start-state" },
    { index: 1, kind: "turn", wave: 1, turn: 1, hash: "turn-one-init" },
    { index: 2, kind: "turn", wave: 1, turn: 2, hash: "turn-two-init" },
  ];
  return {
    schema: "sam.coop_guest_proof.v1",
    mode: "actual-policy",
    run: { seat: "guest", browserIsolation: true, inputChannel: "physical-keyboard", buildSha: "a".repeat(40) },
    model: { sha256: sha(bytes), policyVersion: 65, updates: 64, featureDim: 128 },
    events: [event("rq-command", "COMMAND"), event("rq-fight", "FIGHT")],
    decision: {
      key, seq: 11, author: "guest", takeover: false,
      linkedRequestIds: ["rq-command", "rq-fight"],
      receipts: ["host", "guest"].map(seat => ({
        seat, kind: "SEQUENCED", seq: 11, author: "guest", key: { ...key },
      })),
      checkpointBeforeIndex: 1, checkpointAfterIndex: 2,
    },
    checkpoints: { host: checkpoints, guest: structuredClone(checkpoints) },
  };
}

const validate = (alter, options) => {
  const bytes = actorBytes(options);
  const record = proof(bytes);
  alter(record);
  return verifySamGuestEvidence(record, bytes);
};

describe("SAM co-op guest policy evidence (QA consistency only)", () => {
  it("accepts a well-formed synthetic example only as internally consistent", () => {
    const value = validate(() => {});
    assert.equal(value.consistent, true);
    assert.equal(value.decisionSeq, 11);
    assert.match(value.warning, /independently verify/);
  });

  it("rejects scripted, fallback and wrong-owner claims", () => {
    assert.throws(() => validate(x => x.mode = "scripted"), /scripted\/fallback/);
    assert.throws(() => validate(x => x.events[0].fallback = true), /not proven actor/);
    assert.throws(() => validate(x => x.run.seat = "host"), /guest seat/);
  });

  it("binds claimed policy version, updates and SHA-256 to actual actor bytes", () => {
    assert.throws(() => validate(x => x.model.sha256 = "f".repeat(64)), /artifact hash mismatch/);
    assert.throws(() => validate(x => x.model.policyVersion = 999), /policy metadata mismatch/);
    assert.throws(() => validate(() => {}, { updates: 0 }), /untrained or unidentified/);
    assert.throws(() => validate(() => {}, { nonzero: false }), /all zero/);
  });

  it("rejects empty visual observations and replayed or duplicate requests", () => {
    assert.throws(() => validate(x => x.events[0].tileCount = 0), /visual observation/);
    assert.throws(() => validate(x => x.events[1].requestId = "rq-command"), /duplicate/);
    assert.throws(() => validate(x => x.events[0].ack.requestId = "stale"), /not correlated/);
  });

  it("rejects blocked, remapped and failed execution reports", () => {
    assert.throws(() => validate(x => x.events[0].ack.blocked = true), /blocked, remapped/);
    assert.throws(() => validate(x => x.events[1].ack.executedAction = "B"), /blocked, remapped/);
    assert.throws(() => validate(x => x.events[0].ack.ok = false), /blocked, remapped/);
  });

  it("requires genuine actor-source command and fight inputs", () => {
    assert.throws(() => validate(x => x.events[0].ui = "MESSAGE"), /independent actor-selected/);
    assert.throws(() => validate(x => x.events[1].source = "world-model"), /not proven actor/);
    assert.throws(() => validate(x => {
      // Keep the acknowledgment consistent so this specifically tests a
      // policy that never selected a fight move, not an ack mismatch.
      x.events[1].action = "WAIT";
      x.events[1].ack.requestedAction = "WAIT";
      x.events[1].ack.executedAction = "WAIT";
    }), /independent actor-selected/);
  });

  it("rejects sequencer omission, spoofing, takeover and broken request correlation", () => {
    assert.throws(() => validate(x => x.decision.seq = 0), /sequencer number/);
    assert.throws(() => validate(x => x.decision.author = "host"), /wrong seat/);
    assert.throws(() => validate(x => x.decision.takeover = true), /wrong seat or takeover/);
    assert.throws(() => validate(x => x.decision.receipts.pop()), /receipts missing/);
    assert.throws(() => validate(x => x.decision.receipts[0].seq = 12), /receipts missing/);
    assert.throws(() => validate(x => x.decision.linkedRequestIds = ["rq-command"]), /not causally linked/);
  });

  it("rejects divergent state hashes and incomplete checkpoint arrays", () => {
    assert.throws(() => validate(x => x.checkpoints.guest[2].hash = "different"), /diverged or are incomplete/);
    assert.throws(() => validate(x => x.checkpoints.host.pop()), /diverged or are incomplete/);
  });

  it("rejects the TurnInitPhase checkpoint being mistaken for a completed move", () => {
    assert.throws(() => validate(x => x.decision.checkpointAfterIndex = 1), /before\/after/);
    assert.throws(() => validate(x => {
      x.checkpoints.host[2] = { ...x.checkpoints.host[2], turn: 1 };
      x.checkpoints.guest = structuredClone(x.checkpoints.host);
    }), /turn-start checkpoint/);
  });

  it("executes the portable CLI and rejects an inconsistent proof", () => {
    const dir = mkdtempSync(join(tmpdir(), "sam-coop-proof-"));
    const modelPath = join(dir, "actor-v1.json");
    const tracePath = join(dir, "proof.json");
    const cli = fileURLToPath(new URL("../../scripts/verify-sam-guest-evidence.mjs", import.meta.url));
    try {
      const model = actorBytes();
      writeFileSync(modelPath, model);
      const input = proof(model);
      writeFileSync(tracePath, JSON.stringify(input));
      const good = spawnSync(process.execPath, [cli, tracePath, modelPath], { encoding: "utf8" });
      assert.equal(good.status, 0, good.stderr);
      assert.equal(JSON.parse(good.stdout).consistent, true);
      input.events[1].ack.blocked = true;
      writeFileSync(tracePath, JSON.stringify(input));
      const bad = spawnSync(process.execPath, [cli, tracePath, modelPath], { encoding: "utf8" });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /SAM guest evidence FAILED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects raw response without verified browser scope", () => {
    assert.throws(() => validate(x => x.run.browserIsolation = false), /isolated browser/);
    assert.throws(() => validate(x => x.run.inputChannel = "debug-api"), /actual keyboard/);
  });
});
