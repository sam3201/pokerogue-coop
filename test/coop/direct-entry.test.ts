/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { directCoopEntryRequested } from "#coop/direct-entry";
import { describe, expect, it } from "vitest";

const github = { hostname: "sam3201.github.io", pathname: "/pokerogue-coop/" };

describe("co-op website entry", () => {
  it("opens the co-op menu from the existing SAM homepage link", () => {
    expect(directCoopEntryRequested("", github)).toBe(true);
    expect(directCoopEntryRequested("?utm_source=home", github)).toBe(true);
    expect(directCoopEntryRequested("", { ...github, pathname: "/pokerogue-coop/index.html" })).toBe(true);
  });
  it("permits explicit co-op deep links on other origins", () => {
    expect(directCoopEntryRequested("?coop=1")).toBe(true);
    expect(directCoopEntryRequested("?utm_source=home&coop=1")).toBe(true);
  });
  it("preserves deliberate solo access and refuses conflicting values", () => {
    for (const query of ["?solo=1", "?coop=0", "?coop=1&coop=0", "?solo=1&coop=1"]) {
      expect(directCoopEntryRequested(query, github)).toBe(false);
    }
  });
  it("never redirects unrelated websites or joins rooms implicitly", () => {
    expect(directCoopEntryRequested("")).toBe(false);
    expect(directCoopEntryRequested("", { hostname: "example.com", pathname: "/pokerogue-coop/" })).toBe(false);
    expect(directCoopEntryRequested("", { ...github, pathname: "/pokerogue-coop/private/" })).toBe(false);
    expect(directCoopEntryRequested("?room=ABC123")).toBe(false);
  });
});
