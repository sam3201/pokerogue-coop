/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Explicit, opt-in URL shortcut to the co-op menu. It must never join a room without confirmation. */
export function directCoopEntryRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  const values = params.getAll("coop");
  return values.length === 1 && values[0] === "1";
}
