/* SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  type CaptureObservation,
  type CaptureProposal,
  captureFeedback,
  validateCaptureProposal,
} from "#coop/agent-capture-lesson";
import { describe, expect, it } from "vitest";

const observation = (): CaptureObservation => ({
  phase: "COMMAND",
  seat: "guest",
  canCatch: true,
  opponents: [{ battlerIndex: 3, speciesId: 25, hp: 8, maxHp: 40, statused: true }],
  balls: [
    { type: 0, count: 2, legal: true },
    { type: 1, count: 1, legal: true },
    { type: 2, count: 0, legal: true },
    { type: 3, count: 0, legal: false },
    { type: 4, count: 1, legal: true },
  ],
  ownParty: [
    { id: 21, owner: "guest", hp: 25, protected: false },
    { id: 22, owner: "guest", hp: 0, protected: false },
  ],
  masterBallApproved: false,
});

const catchIntent = (replace: number | null = null): CaptureProposal => ({
  action: "catch",
  source: "JevBot-v9-capture-lesson",
  targetIndex: 3,
  ballType: 0,
  releaseOwnId: replace,
});

describe("SAM/JevBot supervised capture lesson (legality gate, not learned weights)", () => {
  it("constructs legal co-op Poké Ball intent from one catchable wild opponent", () => {
    expect(validateCaptureProposal(observation(), catchIntent())).toMatchObject({
      allowed: true,
      command: { command: "BALL", cursor: 0, targets: [3] },
      needsPartnerConsent: true,
      releaseOwnId: null,
    });
  });

  it("requires the actual game's catch legality and exactly one live opponent", () => {
    expect(validateCaptureProposal({ ...observation(), canCatch: false }, catchIntent())).toMatchObject({
      allowed: false,
      reason: "encounter-disallows-capture",
    });
    expect(
      validateCaptureProposal(
        {
          ...observation(),
          opponents: [...observation().opponents, ...observation().opponents],
        },
        catchIntent(),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "capture-requires-exactly-one-live-opponent",
    });
  });

  it("never invents an available Ball or attacks through the wrong UI", () => {
    expect(validateCaptureProposal(observation(), { ...catchIntent(), ballType: 2 })).toMatchObject({
      allowed: false,
      reason: "ball-unavailable-or-illegal",
    });
    expect(validateCaptureProposal(observation(), { ...catchIntent(), ballType: 9 })).toMatchObject({
      allowed: false,
      reason: "invalid-ball-type",
    });
    expect(validateCaptureProposal({ ...observation(), phase: "FIGHT" }, catchIntent())).toMatchObject({
      allowed: false,
      reason: "capture-requires-command-phase",
    });
  });

  it("requires same-owner release choice when all three are occupied", () => {
    const full = {
      ...observation(),
      ownParty: [...observation().ownParty, { id: 23, owner: "guest" as const, hp: 20, protected: false }],
    };
    expect(validateCaptureProposal(full, catchIntent())).toMatchObject({
      allowed: false,
      reason: "model-must-choose-own-release-before-full-party-catch",
    });
    expect(validateCaptureProposal(full, catchIntent(22))).toMatchObject({ allowed: true, releaseOwnId: 22 });
  });

  it("never releases a partner Pokémon or a protected team member", () => {
    const full = {
      ...observation(),
      ownParty: [...observation().ownParty, { id: 23, owner: "guest" as const, hp: 20, protected: true }],
    };
    expect(validateCaptureProposal(full, catchIntent(23))).toMatchObject({
      allowed: false,
      reason: "cannot-release-partner-unowned-or-protected-pokemon",
    });
    expect(validateCaptureProposal(full, catchIntent(999))).toMatchObject({ allowed: false });
    expect(
      validateCaptureProposal(
        {
          ...full,
          ownParty: [...full.ownParty, { id: 24, owner: "host", hp: 4, protected: false }],
        },
        catchIntent(22),
      ),
    ).toMatchObject({
      allowed: false,
      reason: "capture-owner-pool-contains-partner-pokemon",
    });
  });

  it("does not consume Master Ball without explicit model permission", () => {
    const master: CaptureProposal = { ...catchIntent(), ballType: 4 };
    expect(validateCaptureProposal(observation(), master)).toMatchObject({
      allowed: false,
      reason: "master-ball-requires-explicit-model-approval",
    });
    expect(validateCaptureProposal({ ...observation(), masterBallApproved: true }, master)).toMatchObject({
      allowed: true,
      command: { cursor: 4 },
    });
  });

  it("gives a caution for high HP rather than inventing probabilities", () => {
    const view = {
      ...observation(),
      opponents: [{ battlerIndex: 3, speciesId: 25, hp: 90, maxHp: 100, statused: false }],
    };
    const result = validateCaptureProposal(view, catchIntent());
    expect(result).toMatchObject({ allowed: true });
    if (!result.allowed) {
      throw new Error("Unexpected capture rejection");
    }
    expect(result.tacticalHint).toContain("weakening");
  });

  it("rejects invalid targets, zero HP and mismatched selected target", () => {
    expect(validateCaptureProposal(observation(), { ...catchIntent(), targetIndex: 9 })).toMatchObject({
      allowed: false,
      reason: "missing-or-invalid-live-capture-target",
    });
    expect(
      validateCaptureProposal(
        {
          ...observation(),
          opponents: [{ battlerIndex: 3, speciesId: 25, hp: 0, maxHp: 40, statused: true }],
        },
        catchIntent(),
      ),
    ).toMatchObject({ allowed: false });
  });

  it("labels real outcomes for SAM training without claiming to train weights", () => {
    const valid = validateCaptureProposal(observation(), catchIntent());
    expect(captureFeedback(valid, "caught")).toEqual({
      reward: 1,
      label: "legal-capture-success",
      trainable: true,
    });
    expect(captureFeedback(valid, "escaped").reward).toBeLessThan(0);
    expect(captureFeedback(valid, "pending").trainable).toBe(false);
    const invalid = validateCaptureProposal({ ...observation(), canCatch: false }, catchIntent());
    expect(captureFeedback(invalid, "rejected").trainable).toBe(true);
  });

  it("model can choose to fight with no capture side effect", () => {
    const valid = validateCaptureProposal(observation(), { action: "fight", source: "SAM" });
    expect(valid).toEqual({ allowed: false, reason: "model-selected-fight", feedback: "no-op" });
    expect(captureFeedback(valid, "pending").reward).toBe(0);
  });
});
