/* SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Vitest co-op suite registration for the standalone, Node-only evidence
 * contract tests. This ensures pnpm test:coop:node actually checks them.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testFile = fileURLToPath(new URL("./sam-guest-proof.test.mjs", import.meta.url));

describe("SAM guest proof checker in standard co-op CI", () => {
  it("passes all standalone checker tests, including CLI and tamper cases", () => {
    const result = spawnSync(process.execPath, ["--test", testFile], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.error, `Node runner failed: ${result.error?.message}`).toBeUndefined();
    expect(result.status, `Node runner failed: ${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# tests 11\b/);
    expect(result.stdout).toMatch(/# pass 11\b/);
    expect(result.stdout).toMatch(/# fail 0\b/);
  });
});
