/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { retryKey } from "#coop/decision-keys";
import { keyId } from "#coop/protocol";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { advanceTo } from "#test/helpers/coop-harness";
import {
  attackCommand,
  type LinkedRun,
  type LinkedScenario,
  openLinkedRun,
  playToRunEnd,
} from "#test/helpers/coop-linked";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * In strict two-owner co-op, three Pokémon per player are an independent
 * survival pool. If either owner runs out of living Pokémon, the entire
 * run ends. The old shared-party wipe prompt is deliberately bypassed.
 *
 * These real Phaser-linked tests replace the obsolete ability to borrow a
 * partner's remaining Pokémon and choose Retry after an owner wipe.
 */
const SIX = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];
const OWNERS = ["host", "guest", "host", "guest", "host", "guest"] as const;

describe("Co-op: either owner losing all three ends the shared run", () => {
  let phaserGame: Phaser.Game;
  let run: LinkedRun | null = null;
  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });
  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  async function start(overrides: Partial<LinkedScenario> = {}): Promise<LinkedRun> {
    run = await openLinkedRun(phaserGame, {
      seat: "host",
      species: SIX,
      starterOwners: [...OWNERS],
      configure: game => game.override.startingLevel(40),
      faints: [1, 2, 3].map(turn => ({ wave: 1, turn, slots: [0, 1] as (0 | 1)[] })),
      names: { mine: "SAM", theirs: "JevBot" },
      retry: "menu", // existing retry surface must be bypassed on owner wipe
      ...overrides,
      policy: {
        auto: ["TURN_COMMANDS", "FAINT_SWITCH", "LEARN_MOVE", "EVOLUTION_CANCEL"],
        commands: (_pokemon, slot) => attackCommand(run!.ctx.game, slot, MoveId.MEMENTO),
        ...overrides.policy,
      },
    });
    return run;
  }

  for (const seat of ["host", "guest"] as const) {
    it(
      seat + " cannot retry or continue with the partner's living team after owned-team wipe",
      async () => {
        const r = await start({
          seat,
          names: seat === "host" ? { mine: "SAM", theirs: "JevBot" } : { mine: "JevBot", theirs: "SAM" },
        });
        const { game } = r.ctx;
        await advanceTo(r.ctx, ["CommandPhase"]);
        expect(r.session.waveSave).not.toBeNull();
        expect(await playToRunEnd(r)).toBe(false);
        expect(r.session.eliminatedSeat).not.toBeNull();
        expect(await advanceTo(r.ctx, ["PostGameOverPhase", "CommandPhase"])).toBe("PostGameOverPhase");
        expect(r.partner.answeredKeys).not.toContain(keyId(retryKey(1)));
        expect(r.partner.resyncs).toHaveLength(0);
        expect(r.link.epoch).toBe(0);
        expect(game.scene.gameData.gameStats.coopRunsWon).toBe(0);
        expect(r.session.desyncMessage).toBeNull();
      },
      5 * 60_000,
    );
  }

  it(
    "does not require a wave-start save for strict owner elimination",
    async () => {
      const r = await start();
      await advanceTo(r.ctx, ["CommandPhase"]);
      r.session.waveSave = null;
      expect(await playToRunEnd(r)).toBe(false);
      expect(r.session.eliminatedSeat).not.toBeNull();
      expect(await advanceTo(r.ctx, ["PostGameOverPhase", "CommandPhase"])).toBe("PostGameOverPhase");
      expect(r.session.openWindow).toEqual([]);
      expect(r.partner.resyncs).toHaveLength(0);
    },
    5 * 60_000,
  );
});
