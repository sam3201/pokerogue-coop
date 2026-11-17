/* Co-op owner-specific lives and reward priority. No game imports. */
import type { Seat } from "#coop/protocol";

/** Host/guest after-battle reward chooser; never determined by the last hit or battle speed. */
export type RewardPriority = "host" | "guest" | "alternate";

export function isRewardPriority(value: unknown): value is RewardPriority {
  return value === "host" || value === "guest" || value === "alternate";
}

export function chooseRewardPicker(screenIndex: number, mode: RewardPriority = "host"): Seat {
  if (!Number.isInteger(screenIndex) || screenIndex < 0) {
    throw new Error("Invalid co-op reward screen index");
  }
  if (mode === "host" || mode === "guest") {
    return mode;
  }
  return screenIndex % 2 === 0 ? "host" : "guest";
}

/**
 * Either owner losing their *entire* party ends this co-op attempt.
 * A partner's living Pokémon cannot substitute for a defeated owner.
 * Wait until both owners have registered Pokémon; otherwise an incomplete
 * lobby/restore would look like a defeat.
 *
 * Do not confuse ownership with field slot: the ownership map follows
 * a Pokémon across switches, trades, catches and resequencing.
 */
export function eliminatedOwnedSeat<T extends { id: number; hp: number }>(
  party: readonly T[],
  ownerOf: (pokemonId: number) => Seat | undefined,
): Seat | null {
  const owned: Record<Seat, number> = { host: 0, guest: 0 };
  const living: Record<Seat, number> = { host: 0, guest: 0 };
  for (const pokemon of party) {
    const owner = ownerOf(pokemon.id);
    if (owner !== "host" && owner !== "guest") {
      continue;
    }
    owned[owner]++;
    if (pokemon.hp > 0) {
      living[owner]++;
    }
  }
  if (owned.host === 0 || owned.guest === 0) {
    return null;
  }
  if (living.host === 0) {
    return "host";
  }
  if (living.guest === 0) {
    return "guest";
  }
  return null;
}
