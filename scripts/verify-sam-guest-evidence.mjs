/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Supervisor QA only: structural consistency of a SAM-originated guest proof.
 * NOT an attestation that the worker ran, the browser was honest, or a human
 * played; independent process/relay artifacts must still be reviewed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "L", "R", "START", "SELECT", "WAIT"];
const SHA256 = /^[a-f0-9]{64}$/i;
const GITSHA = /^[a-f0-9]{40}$/i;

function check(condition, reason) {
  if (!condition) throw new Error(reason);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function natural(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validKey(key) {
  return object(key) && key.kind === "TURN_COMMANDS"
    && natural(key.wave, 1) && natural(key.turn, 1)
    && (nonempty(key.ref) || natural(key.ref, 0));
}

/**
 * Verify a redacted, externally supplied *claim* against real actor model bytes.
 * This guards against accidentally treating scripted/unsequenced QA as learned
 * co-op play, not against deliberately fabricated logs.
 *
 * Restrict this first acceptance to the actor source: a world-model decision
 * requires an independently hashed dynamics artifact and its own gate.
 */
export function verifySamGuestEvidence(evidence, actorFileBytes) {
  check(object(evidence) && evidence.schema === "sam.coop_guest_proof.v1", "unsupported proof schema");
  check(evidence.mode === "actual-policy", "scripted/fallback modes are not learned policy evidence");

  const run = evidence.run;
  check(object(run) && run.seat === "guest" && run.browserIsolation === true, "guest seat or isolated browser missing");
  check(run.inputChannel === "physical-keyboard", "guest did not use the actual keyboard input path");
  check(GITSHA.test(run.buildSha || ""), "unidentified game build");

  let actor;
  const bytes = Buffer.isBuffer(actorFileBytes) ? actorFileBytes : Buffer.from(actorFileBytes ?? "");
  try { actor = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("invalid actor checkpoint bytes"); }
  const model = evidence.model;
  check(object(model) && SHA256.test(model.sha256 || ""), "missing model artifact fingerprint");
  check(createHash("sha256").update(bytes).digest("hex") === model.sha256.toLowerCase(), "actor artifact hash mismatch");
  check(natural(actor.policy_version, 1) && natural(actor.updates, 1), "actor is untrained or unidentified");
  check(actor.policy_version === model.policyVersion && actor.updates === model.updates, "policy metadata mismatch");
  check(actor.feature_dim === 128 && model.featureDim === 128, "actor feature dimensionality mismatch");
  check(Array.isArray(actor.actions) && JSON.stringify(actor.actions) === JSON.stringify(ACTIONS),
    "actor action vocabulary mismatch");
  check(object(actor.weights), "actor has no weights");
  let nonzero = 0;
  for (const name of ACTIONS) {
    const w = actor.weights[name];
    check(Array.isArray(w) && w.length === 128 && w.every(Number.isFinite),
      `invalid actor weights for ${name}`);
    nonzero += w.filter(x => Math.abs(x) > 1e-10).length;
  }
  check(nonzero > 0, "actor weights are all zero");

  const events = evidence.events;
  check(Array.isArray(events) && events.length >= 2, "insufficient guest policy decisions");
  const ids = new Set();
  for (const event of events) {
    check(object(event) && nonempty(event.requestId) && !ids.has(event.requestId), "duplicate/missing policy request ID");
    ids.add(event.requestId);
    check(SHA256.test(event.observationSha256 || "") && natural(event.tileCount, 1),
      "missing visual observation fingerprint or tile tokens");
    check(event.source === "actor" && event.fallback === false, "response is not proven actor-source output");
    check(ACTIONS.includes(event.action) && ["COMMAND", "FIGHT", "TARGET_SELECT", "MESSAGE", "CONFIRM"].includes(event.ui),
      "invalid policy action or observed UI state");
    const ack = event.ack;
    check(object(ack) && ack.requestId === event.requestId && ack.seat === "guest",
      "action outcome not correlated to the guest policy request");
    check(ack.channel === "physical-keyboard" && ack.requestedAction === event.action
      && ack.executedAction === event.action && ack.outcome === "APPLIED"
      && ack.ok === true && ack.blocked === false && ack.remapped === false && ack.intervention === false,
      "policy input was blocked, remapped, rejected or not confirmed executed");
  }

  const command = events.find(e => e.ui === "COMMAND" && e.action === "A");
  const fight = events.find(e => e.ui === "FIGHT" && e.action === "A");
  check(command && fight && command.requestId !== fight.requestId, "missing independent actor-selected command and fight input");

  const decision = evidence.decision;
  check(object(decision) && validKey(decision.key) && natural(decision.seq, 1),
    "missing real TURN_COMMANDS decision key and sequencer number");
  check(decision.author === "guest" && decision.takeover === false, "wrong seat or takeover decision");
  check(Array.isArray(decision.linkedRequestIds)
    && decision.linkedRequestIds.includes(command.requestId)
    && decision.linkedRequestIds.includes(fight.requestId)
    && decision.linkedRequestIds.every(x => ids.has(x)),
    "sequenced decision not causally linked to actor inputs");
  // The host assigns its own seq; it SENDS the decision to the guest.
  // A report claiming the host RECEIVED its own SEQUENCED frame is not valid
  // wire evidence. Require all four distinct, directionally accurate steps.
  const requiredWire = [
    { seat: "guest", direction: "sent", kind: "PROPOSE", seq: null },
    { seat: "host", direction: "received", kind: "PROPOSE", seq: null },
    { seat: "host", direction: "sent", kind: "SEQUENCED", seq: decision.seq },
    { seat: "guest", direction: "received", kind: "SEQUENCED", seq: decision.seq },
  ];
  check(Array.isArray(decision.receipts) && decision.receipts.length === requiredWire.length
    && requiredWire.every(expected => decision.receipts.some(r =>
      object(r) && r.seat === expected.seat && r.direction === expected.direction
      && r.kind === expected.kind && (r.seq ?? null) === expected.seq
      && r.author === "guest" && r.takeover === false
      && JSON.stringify(r.key) === JSON.stringify(decision.key))),
    "complete directional guest PROPOSE/SEQUENCED wire receipts missing");

  const cps = evidence.checkpoints;
  check(object(cps) && Array.isArray(cps.host) && Array.isArray(cps.guest)
    && cps.host.length >= 3 && JSON.stringify(cps.host) === JSON.stringify(cps.guest),
    "checkpoint arrays diverged or are incomplete");
  for (let i = 0; i < cps.host.length; i++) {
    const c = cps.host[i];
    check(object(c) && c.index === i && nonempty(c.hash) && natural(c.wave, 1)
      && natural(c.turn) && ["waveStart", "turn", "waveEnd", "rewards"].includes(c.kind),
      `invalid checkpoint at index ${i}`);
  }
  const before = decision.checkpointBeforeIndex;
  const after = decision.checkpointAfterIndex;
  check(natural(before) && natural(after) && after > before
    && after < cps.host.length && cps.host[before]?.kind === "turn",
    "sequenced action lacks before/after checkpoint correlation");
  const start = cps.host[before], end = cps.host[after];
  check((end.kind === "turn" && (end.wave > start.wave || end.turn > start.turn))
    || ["waveEnd", "rewards"].includes(end.kind) && end.wave >= start.wave,
    "turn-start checkpoint is not proof of completed battle action");

  return {
    consistent: true,
    actionRequests: events.length,
    decisionSeq: decision.seq,
    checkpoints: cps.host.length,
    actorUpdates: actor.updates,
    warning: "Consistency only: independently verify actual process invocation and relay receipts",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , evidencePath, actorPath] = process.argv;
  if (!evidencePath || !actorPath) {
    console.error("Usage: node scripts/verify-sam-guest-evidence.mjs <redacted-proof.json> <actor-v1.json>");
    process.exitCode = 2;
  } else {
    try {
      const proof = JSON.parse(readFileSync(evidencePath, "utf8"));
      const result = verifySamGuestEvidence(proof, readFileSync(actorPath));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`SAM guest evidence FAILED: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
