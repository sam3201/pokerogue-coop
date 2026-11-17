import { chooseRewardPicker, eliminatedOwnedSeat, isRewardPriority } from "#coop/owner-rules";
import { describe, expect, it } from "vitest";

const owners = { 1: "host", 2: "guest", 3: "host", 4: "guest", 5: "host", 6: "guest" } as const;
const ownerOf = (id: number) => owners[id as keyof typeof owners];

describe("Co-op host-default reward priority, synchronized before each screen", () => {
  it("defaults to host for every reward screen, not speed or last hit", () => {
    expect([0, 1, 2, 3, 4, 5].map(index => chooseRewardPicker(index))).toEqual([
      "host",
      "host",
      "host",
      "host",
      "host",
      "host",
    ]);
  });
  it("supports guest choice or explicitly alternating reward priority", () => {
    expect([0, 1, 2, 3].map(i => chooseRewardPicker(i, "guest"))).toEqual(["guest", "guest", "guest", "guest"]);
    expect([0, 1, 2, 3].map(i => chooseRewardPicker(i, "alternate"))).toEqual(["host", "guest", "host", "guest"]);
  });
  it("validates allowed values, rejects malformed screen indexes", () => {
    expect(["host", "guest", "alternate"].every(isRewardPriority)).toBe(true);
    expect(isRewardPriority("last-hit")).toBe(false);
    expect(isRewardPriority("speed")).toBe(false);
    expect(isRewardPriority(null)).toBe(false);
    expect(() => chooseRewardPicker(-1)).toThrow();
    expect(() => chooseRewardPicker(0.2)).toThrow();
  });
});

describe("Co-op owner-specific three-Pokémon wipe", () => {
  const party = (h: number[], g: number[]) =>
    [1, 2, 3, 4, 5, 6].map((id, i) => ({
      id,
      hp: id % 2 === 1 ? h[Math.floor(i / 2)] : g[Math.floor(i / 2)],
    }));
  it("ends if all host-owned Pokémon faint while guest still has three", () => {
    expect(eliminatedOwnedSeat(party([0, 0, 0], [12, 8, 9]), ownerOf)).toBe("host");
  });
  it("ends if all guest-owned Pokémon faint while host still has three", () => {
    expect(eliminatedOwnedSeat(party([12, 8, 9], [0, 0, 0]), ownerOf)).toBe("guest");
  });
  it("continues while each owner still has at least one living Pokémon", () => {
    expect(eliminatedOwnedSeat(party([0, 0, 1], [0, 3, 0]), ownerOf)).toBeNull();
  });
  it("does not mistake one active faint for an entire owned-team defeat", () => {
    expect(eliminatedOwnedSeat(party([0, 12, 9], [18, 0, 5]), ownerOf)).toBeNull();
  });
  it("an incomplete lobby or missing ownership record cannot cause an invented wipe", () => {
    expect(eliminatedOwnedSeat([{ id: 1, hp: 0 }], ownerOf)).toBeNull();
    expect(
      eliminatedOwnedSeat(
        [
          { id: 99, hp: 0 },
          { id: 100, hp: 4 },
        ],
        () => undefined,
      ),
    ).toBeNull();
  });
  it("owner map, not party order or field side, determines whose run ended", () => {
    const switched = (id: number) => (id % 2 === 1 ? ("guest" as const) : ("host" as const));
    expect(eliminatedOwnedSeat(party([0, 0, 0], [1, 5, 8]), switched)).toBe("guest");
  });
  it("two-party wipe deterministically declares host and cannot continue", () => {
    expect(eliminatedOwnedSeat(party([0, 0, 0], [0, 0, 0]), ownerOf)).toBe("host");
  });
});
