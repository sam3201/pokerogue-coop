# SAM/JevBot capture curriculum — co-op gameplay v1

**Status:** training syllabus and read-only validation gate. The agents' learned
checkpoint weights have **not** been updated by this document. This patch is
review-only and must not be presented as live catching without a complete game
trace. Capture decisions remain agent-authored; the validator is only a safety
boundary.

## Goal

During a co-op battle, correctly recognize when catching is possible, choose
whether to weaken or throw, select a legal Poké Ball, obtain the side-action
decision from the other seat, and, if the catcher already has three Pokémon,
select a replacement from their **own** team. Both players must preserve one
another's three-Pokémon ownership and co-op run authority.

## Observation-to-action lesson

1. **Recognize the encounter.** Use the game-provided `canCatch` and
   `ballWorks` legality, not sprite color or model speculation. Trainer battles,
   blocked mystery encounters, forbidden boss states and noncatchable encounters
   must not receive a Ball proposal.
2. **Wait for a single active opponent.** Co-op legality requires exactly one
   enemy battler index. In multi-enemy encounters, safely remove one opposing
   Pokémon while preserving the desired target if possible.
3. **Reduce HP without causing a knockout.** Lower HP or apply a nonlethal
   condition when practicable. Don't assert a guaranteed capture probability.
   Avoid damaging the target after a catch is queued.
4. **Choose a legal stocked Ball.** The game uses indices: 0 Poké Ball,
   1 Great Ball, 2 Ultra Ball, 3 Rogue Ball, 4 Master Ball. Check nonzero
   inventory and boss restrictions. Require an explicit model-approved reason
   before spending a Master Ball.
5. **Send the proper co-op command.** In the COMMAND menu select BALL and then
   the actual Ball row; the sequenced co-op command is
   `{command:"BALL", cursor:ballType, targets:[enemyBattlerIndex]}`.
   Respect the peer SIDE_ACTION accept/decline; never bypass their choice.
6. **Respect ownership and three slots.** A catcher with fewer than three owned
   Pokémon receives the catch. At three, the owner must select one of their
   own Pokémon to release after a successful catch; do not silently release a
   partner's Pokémon, nor swap teams after one owner's complete wipe.
7. **Learn from confirmed outcomes.** Record the game epoch, target and owned
   party, legal Ball choice, model-proposed intent, sequenced peer decision,
   capture result and owner-specific replacement. Feed back `caught`,
   `escaped`, `rejected`, or `pending`. Never label a queued throw as success
   or a scripted UI movement as an independently learned action.

## Independent acceptance requirements

- Trainer battle, blocked encounter and two-enemy throws refused;
- Invalid target, unstocked Ball, illegal shield and unauthorized Master Ball
  refused;
- Legal weak wild target yields correct Ball command and partner consent;
- Full owner team requires valid model-selected own-Pokémon release;
- Both host- and guest-authored catches, declines and final party ownership
  match under game-state checkpoint verification;
- No new reward-picker desync, no reused previous-run decision, and no switch
  into another owner's party;
- At least one actual catch-and-release game trace and one failed-catch trace
  before a live automation rollout;
- Distinguish **policy learning** from mechanical adapter and safety gate.

Code and fixtures: `src/coop/agent-capture-lesson.ts` and
`test/coop/agent-capture-lesson.test.ts`.

The existing game tests at `test/tests/coop/linked-run.test.ts` and
`test/tests/coop/linked-battle.test.ts` contain legal capture, partner
side-action approval, and own-party release integration scenarios. Those tests
must pass on the exact release branch and build.
