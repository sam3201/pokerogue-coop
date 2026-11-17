/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { requireCoopSession } from "#coop/session";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";
import {
  accountWith,
  advanceTo,
  type ClientConfig,
  type CoopRun,
  Decider,
  openCoopRun,
  playWave,
  queueTurnCommands,
  type Scenario,
  type SharedRun,
} from "#test/helpers/coop-harness";
import { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Who replaces a Pokémon that faints (DECISIONS D7), and the wave-start arrange step after faints.
 * Starters are named by owner: H1 is the host's first, G1 the guest's first.
 */

const ACCOUNT = accountWith({ trainerId: 111, secretId: 222 });

const SHARED: SharedRun = {
  runSeed: "co-op-m3-faints",
  snapshot: { host: ACCOUNT, guest: ACCOUNT },
  hostPlayerGender: PlayerGender.MALE,
};

const HOST: ClientConfig = {
  seat: "host",
  liveAccount: ACCOUNT,
  localSettings: {},
  applyOverlay: true,
  bypassSnapshot: false,
  stallMs: 20_000,
};

const SPECIES = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.MACHOP,
  SpeciesId.GEODUDE,
];

function scenario(overrides: Partial<Scenario>): Scenario {
  return {
    species: SPECIES,
    waves: 0,
    // Bite is Dark: nothing is immune to it
    moveset: [MoveId.BITE, MoveId.MEMENTO, MoveId.GROWL, MoveId.TAIL_WHIP],
    faints: [],
    faintMove: MoveId.MEMENTO,
    starterOwners: ["host", "guest", "host", "guest", "host", "guest"],
    ...overrides,
  };
}

const MINUTES = 60_000;

describe("Co-op: faint rules and the wave-start arrange step (D7)", () => {
  let phaserGame: Phaser.Game;
  let run: CoopRun | null = null;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    run?.close();
    run = null;
    vi.restoreAllMocks();
  });

  /** The Pokémon under the cursor each time the party screen of a faint switch opened */
  function watchFaintSwitchCursor(): number[] {
    const opened: number[] = [];
    const show = PartyUiHandler.prototype.show;
    vi.spyOn(PartyUiHandler.prototype, "show").mockImplementation(function (this: PartyUiHandler, args: any[]) {
      const shown = show.call(this, args);
      if (shown && args[0] === PartyUiMode.FAINT_SWITCH) {
        opened.push(globalScene.getPlayerParty()[this.getCursor()].id);
      }
      return shown;
    });
    return opened;
  }

  async function start(overrides: Partial<Scenario>): Promise<CoopRun> {
    run = await openCoopRun(phaserGame, SHARED, HOST, Decider.recording(), scenario(overrides));
    return run;
  }

  /** Play waves `1..waves` and return the ids of the starters in party order, by name (H1, G1, H2, ...) */
  async function playWaves(r: CoopRun, waves: number) {
    const { ctx } = r;
    const counts = { host: 0, guest: 0 };
    const names = new Map(
      ctx.game.scene.getPlayerParty().map(p => {
        const seat = requireCoopSession().ownership.require(p.id);
        return [p.id, `${seat === "host" ? "H" : "G"}${++counts[seat]}`] as const;
      }),
    );
    for (let wave = 1; wave <= waves; wave++) {
      await advanceTo(ctx, ["CommandPhase"]);
      await playWave(ctx);
    }
    return (ids: readonly number[]) => ids.map(id => names.get(id));
  }

  it(
    "(a) the owner's bench refills the slot",
    async () => {
      const r = await start({ faints: [{ wave: 1, turn: 1, slots: [1] }] });
      const initialOwners = requireCoopSession().ownership.toJSON();
      const opened = watchFaintSwitchCursor();
      const nameOf = await playWaves(r, 2);
      const { report } = r.ctx;

      expect(report.stalledIn).toBeNull();
      expect(report.replacementLog).toHaveLength(1);
      const [swap] = report.replacementLog;
      // the guest's Pokémon in slot 1 fainted, the guest picked, from the guest's bench
      expect(nameOf([swap.fainted, swap.chosen])).toEqual(["G1", "G2"]);
      // the party screen opened on the first that may go in, not on the field
      expect(nameOf(opened)).toEqual(["G2"]);
      expect(swap.by).toBe("guest");
      expect(requireCoopSession().ownership.toJSON()).toEqual(initialOwners);
      // the decision is the guest's, keyed by the fainted Pokémon; the replacement is asked after the turn's end phase
      // advanced the turn, on every client alike
      const decision = r.ctx.decider.decisions.find(d => d.key.kind === "FAINT_SWITCH")!;
      expect(decision).toMatchObject({ by: "guest", key: { wave: 1, turn: 2, ref: swap.fainted } });
      // the next wave: each seat has a Pokémon in its slot again
      expect(report.waves[1].controllers).toEqual(["host", "guest"]);
    },
    5 * MINUTES,
  );

  it(
    "(b) a guest owner with no living bench ends co-op, even though the host has healthy reserves",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "host", "host"],
        faints: [{ wave: 1, turn: 1, slots: [1] }],
      });
      const owners = requireCoopSession().ownership.toJSON();
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);
      const reached = await advanceTo(ctx, ["GameOverPhase", "TurnInitPhase", "SelectModifierPhase"]);

      expect(reached).toBe("GameOverPhase");
      expect(requireCoopSession().eliminatedSeat).toBe("guest");
      expect(ctx.game.scene.getPokemonAllowedInBattle().length).toBeGreaterThan(0);
      expect(ctx.report.replacementLog).toEqual([]);
      expect(ctx.decider.decisions.filter(d => d.key.kind === "FAINT_SWITCH")).toEqual([]);
      expect(requireCoopSession().ownership.toJSON()).toEqual(owners);
    },
    5 * MINUTES,
  );

  it(
    "(c) a host owner with no living Pokémon ends co-op, rather than letting the guest control both slots",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "guest", "guest"],
        faints: [{ wave: 1, turn: 1, slots: [0] }],
      });
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);
      const reached = await advanceTo(ctx, ["GameOverPhase", "TurnInitPhase", "SelectModifierPhase"]);

      expect(reached).toBe("GameOverPhase");
      expect(requireCoopSession().eliminatedSeat).toBe("host");
      expect(ctx.game.scene.getPokemonAllowedInBattle().length).toBeGreaterThan(0);
      expect(ctx.report.replacementLog).toEqual([]);
    },
    5 * MINUTES,
  );

  it(
    "(d) a full wipe is a game over: nobody is asked for a replacement",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 2),
        starterOwners: ["host", "guest"],
        faints: [{ wave: 1, turn: 1, slots: [0, 1] }],
      });
      const { ctx } = r;
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);

      const reached = await advanceTo(ctx, ["GameOverPhase", "TurnInitPhase", "SelectModifierPhase"]);

      expect(reached).toBe("GameOverPhase");
      // End at the first owner's final faint, before the other queued
      // faint phase necessarily finishes its animation. No further turn.
      expect(requireCoopSession().eliminatedSeat).not.toBeNull();
      expect(ctx.report.replacementLog).toEqual([]);
      expect(ctx.decider.decisions.filter(d => d.key.kind === "FAINT_SWITCH")).toEqual([]);
    },
    5 * MINUTES,
  );

  it(
    "normal owned replacements work until an owner's final Pokémon falls, then the run ends",
    async () => {
      const r = await start({
        faints: [
          { wave: 2, turn: 1, slots: [1] }, // G1 -> G2
          { wave: 3, turn: 1, slots: [0] }, // H1 -> H2
          { wave: 4, turn: 1, slots: [1] }, // G2 -> G3
          { wave: 5, turn: 1, slots: [1] }, // G3 -> co-op loss, no H3 loan
        ],
      });
      const originalOwners = requireCoopSession().ownership.toJSON();
      const nameOf = await playWaves(r, 4);
      const { ctx } = r;

      expect(ctx.report.replacementLog.map(s => nameOf([s.fainted, s.chosen]))).toEqual([
        ["G1", "G2"],
        ["H1", "H2"],
        ["G2", "G3"],
      ]);
      expect(ctx.report.replacementLog.map(s => s.by)).toEqual(["guest", "host", "guest"]);
      expect(ctx.report.waves.every(w => w.controllers[0] === "host" && w.controllers[1] === "guest")).toBe(true);
      await advanceTo(ctx, ["CommandPhase"]);
      queueTurnCommands(ctx);
      const reached = await advanceTo(ctx, ["GameOverPhase", "TurnInitPhase", "SelectModifierPhase"]);
      expect(reached).toBe("GameOverPhase");
      expect(requireCoopSession().eliminatedSeat).toBe("guest");
      expect(ctx.report.replacementLog).toHaveLength(3);
      expect(requireCoopSession().ownership.toJSON()).toEqual(originalOwners);
    },
    10 * MINUTES,
  );

  it(
    "a revived owned Pokémon can return after a legal same-owner bench replacement",
    async () => {
      const r = await start({
        species: SPECIES.slice(0, 4),
        starterOwners: ["host", "guest", "guest", "host"],
        faints: [{ wave: 1, turn: 1, slots: [1] }],
        afterWave: ({ game }, wave) => {
          if (wave !== 1) {
            return;
          }
          const fainted = game.scene.getPlayerParty().find(p => p.isFainted())!;
          fainted.resetStatus(true, false, false, false);
          fainted.hp = fainted.getMaxHp();
        },
      });
      const originalOwners = requireCoopSession().ownership.toJSON();
      const nameOf = await playWaves(r, 2);
      const { report } = r.ctx;
      expect(report.stalledIn).toBeNull();
      expect(report.replacementLog).toHaveLength(1);
      const [swap] = report.replacementLog;
      expect(nameOf([swap.fainted, swap.chosen])).toEqual(["G1", "G2"]);
      expect(swap.by).toBe("guest");
      expect(report.waves[1].controllers).toEqual(["host", "guest"]);
      expect(requireCoopSession().eliminatedSeat).toBeNull();
      expect(requireCoopSession().ownership.toJSON()).toEqual(originalOwners);
    },
    5 * MINUTES,
  );
});
