/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * The co-op-only GitHub Pages fork enters its co-op menu by default.
 * A ?coop=1 link enters it on any host. ?solo=1 and explicit coop=0 leave the normal title intact.
 * No URL can silently join a room or claim a seat in an existing match.
 */
export function directCoopEntryRequested(search: string, location?: { hostname: string; pathname: string }): boolean {
  const params = new URLSearchParams(search);
  if (params.getAll("solo").includes("1")) {
    return false;
  }
  const values = params.getAll("coop");
  if (values.length > 0) {
    return values.length === 1 && values[0] === "1";
  }
  return (
    location?.hostname === "sam3201.github.io"
    && (location.pathname === "/pokerogue-coop/" || location.pathname === "/pokerogue-coop/index.html")
  );
}
