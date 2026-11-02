/* SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Bounded, read-only legality gate for a SAM/JevBot capture proposal.
 * Not a trained capture model, and NOT a shortcut around the actual
 * CommandPhase -> Ball UI -> co-op SIDE_ACTION -> CATCH_RELEASE flow.
 * The learned actor must supply the proposed ball and own-party choice.
 */
import type { Seat } from "#coop/protocol";

export interface CaptureOpponent {
  battlerIndex: number;
  speciesId: number;
  hp: number;
  maxHp: number;
  statused: boolean;
}

export interface CaptureBall {
  /** PokeballType.POKEBALL .. PokeballType.MASTER_BALL: indices 0..4. */
  type: number;
  count: number;
  /** Must come from the gameLegalityView canCatch + ballWorks check. */
  legal: boolean;
}

export interface CaptureOwnPokemon {
  id: number;
  owner: Seat;
  hp: number;
  protected: boolean;
}

export interface CaptureObservation {
  phase: string;
  seat: Seat;
  canCatch: boolean;
  opponents: readonly CaptureOpponent[];
  balls: readonly CaptureBall[];
  ownParty: readonly CaptureOwnPokemon[];
  /** Explicit model-side permission to use a scarce Master Ball. */
  masterBallApproved: boolean;
}

export type CaptureProposal =
  | { action: "fight"; source: string }
  | {
      action: "catch";
      source: string;
      ballType: number;
      targetIndex: number;
      /**
       * The trained agent's decision about which of its own Pokémon to
       * release *if the catch succeeds* and its three slots are occupied.
       */
      releaseOwnId: number | null;
    };

export type CaptureValidation =
  | { allowed: false; reason: string; feedback: "teach" | "no-op" }
  | {
      allowed: true;
      command: { command: "BALL"; cursor: number; targets: readonly [number] };
      needsPartnerConsent: true;
      releaseOwnId: number | null;
      /** Guidance only. It is not the game's probabilistic catch formula. */
      tacticalHint: string;
      proposalSource: string;
    };

function reject(reason: string, feedback: "teach" | "no-op" = "teach"): CaptureValidation {
  return { allowed: false, reason, feedback };
}

export function validateCaptureProposal(view: CaptureObservation, proposal: CaptureProposal): CaptureValidation {
  if (proposal.action === "fight") {
    return reject("model-selected-fight", "no-op");
  }
  if (!proposal.source || proposal.source.length > 160) {
    return reject("unattributed-capture-proposal");
  }
  if (view.phase !== "COMMAND") {
    return reject("capture-requires-command-phase");
  }
  if (!view.canCatch) {
    return reject("encounter-disallows-capture");
  }
  if (view.opponents.length !== 1) {
    return reject("capture-requires-exactly-one-live-opponent");
  }
  const target = view.opponents[0];
  if (
    !Number.isInteger(target.battlerIndex)
    || !Number.isInteger(target.speciesId)
    || !Number.isFinite(target.hp)
    || !Number.isFinite(target.maxHp)
    || target.hp <= 0
    || target.maxHp <= 0
    || target.hp > target.maxHp
    || target.battlerIndex !== proposal.targetIndex
  ) {
    return reject("missing-or-invalid-live-capture-target");
  }
  if (!Number.isInteger(proposal.ballType) || proposal.ballType < 0 || proposal.ballType > 4) {
    return reject("invalid-ball-type");
  }
  const ball = view.balls.find(candidate => candidate.type === proposal.ballType);
  if (ball === undefined || !ball.legal || !Number.isInteger(ball.count) || ball.count <= 0) {
    return reject("ball-unavailable-or-illegal");
  }
  if (proposal.ballType === 4 && !view.masterBallApproved) {
    return reject("master-ball-requires-explicit-model-approval");
  }
  if (view.ownParty.some(pokemon => pokemon.owner !== view.seat)) {
    return reject("capture-owner-pool-contains-partner-pokemon");
  }
  if (view.ownParty.length > 3) {
    return reject("owner-party-exceeds-three");
  }
  if (view.ownParty.length === 3) {
    if (!Number.isInteger(proposal.releaseOwnId)) {
      return reject("model-must-choose-own-release-before-full-party-catch");
    }
    const release = view.ownParty.find(pokemon => pokemon.id === proposal.releaseOwnId);
    if (release === undefined || release.protected) {
      return reject("cannot-release-partner-unowned-or-protected-pokemon");
    }
  } else if (proposal.releaseOwnId !== null) {
    return reject("release-not-needed-with-open-owner-slot");
  }
  // Model/tutor can learn to weaken and apply status; the gate does NOT
  // invent catch probabilities or claim a particular ball guarantees a catch.
  const healthRatio = target.hp / target.maxHp;
  const tacticalHint =
    proposal.ballType === 4
      ? "Master Ball is scarce; validate encounter value with the model."
      : healthRatio > 0.5 && !target.statused
        ? "Consider weakening the opponent or applying a status before throwing."
        : "One opponent, legal Ball and valid co-op target. Catch may still fail.";
  return {
    allowed: true,
    command: { command: "BALL", cursor: proposal.ballType, targets: [proposal.targetIndex] },
    needsPartnerConsent: true,
    releaseOwnId: proposal.releaseOwnId,
    tacticalHint,
    proposalSource: proposal.source,
  };
}

/** Supervised labels for an actual agent-training feedback log; no model
 * weights are modified by this helper.
 */
export function captureFeedback(
  validation: CaptureValidation,
  outcome: "caught" | "escaped" | "rejected" | "pending",
): { reward: number; label: string; trainable: boolean } {
  if (!validation.allowed) {
    return {
      reward: validation.feedback === "no-op" ? 0 : -1,
      label: validation.reason,
      trainable: validation.feedback === "teach",
    };
  }
  switch (outcome) {
    case "caught":
      return { reward: 1, label: "legal-capture-success", trainable: true };
    case "escaped":
      return { reward: -0.2, label: "legal-capture-attempt-escaped", trainable: true };
    case "rejected":
      return { reward: -1, label: "side-action-or-release-not-approved", trainable: true };
    case "pending":
      return { reward: 0, label: "awaiting-confirmed-outcome", trainable: false };
  }
}
