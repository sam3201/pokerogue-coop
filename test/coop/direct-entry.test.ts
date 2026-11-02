/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { directCoopEntryRequested } from "#coop/direct-entry";
import { describe, expect, it } from "vitest";

describe("direct co-op lobby link", () => {
  it("opens the co-op menu for an explicit website link", () => {
    expect(directCoopEntryRequested("?coop=1")).toBe(true);
    expect(directCoopEntryRequested("?utm_source=home&coop=1")).toBe(true);
  });
  it("never hijacks ordinary or disabled game entry", () => {
    for (const query of ["", "?coop=0", "?coop=true", "?cooperative=1", "?coop=1&coop=0"]) {
      expect(directCoopEntryRequested(query)).toBe(false);
    }
  });
  it("does not accept arbitrary room codes as automatic joins", () => {
    expect(directCoopEntryRequested("?room=ABC123")).toBe(false);
  });
});
