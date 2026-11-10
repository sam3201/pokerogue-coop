/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineConfig, devices } from "@playwright/test";

/** The dev server port (`VITE_PORT` in `.env.development`). */
const PORT = 8000;

/** A game that is already running, such as the container of a deploy (DECISIONS D22): no dev server is started for it */
const EXTERNAL = process.env["E2E_BASE_URL"] || undefined;

// Opt-in macOS acceptance uses real visible Chrome without CI SwiftShader flags.
// No changes to the normal local or hosted Linux test renderer.
const MAC_VISIBLE_FPS = process.platform === "darwin" && process.env["COOP_MAC_FPS"] === "1";
// Avoid launching a new dev server or accidentally touching the ordinary
// working checkout when Mac gameplay acceptance was requested.
if (MAC_VISIBLE_FPS) {
  if (!EXTERNAL) throw new Error("Mac FPS acceptance requires E2E_BASE_URL to an existing local game");
  const url = new URL(EXTERNAL);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Mac FPS acceptance requires a loopback HTTP game");
  }
}

// biome-ignore lint/style/noDefaultExport: required for Playwright
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/e2e",
  // Two full game instances per test: run one test at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: {
    baseURL: EXTERNAL ?? `http://localhost:${PORT}`,
    // Normal CI retains failure diagnostics. The opt-in Mac run must not
    // capture screenshots or browser traces from private game sessions.
    trace: MAC_VISIBLE_FPS ? "off" : "retain-on-failure",
    screenshot: MAC_VISIBLE_FPS ? "off" : "only-on-failure",
    video: "off",
  },
  // A game that is already running needs no dev server
  ...(EXTERNAL === undefined
    ? {
        webServer: {
          // `start:dev` loads `.env.development` (`VITE_BYPASS_LOGIN=1`): offline play, no rogueserver needed.
          command: "pnpm start:dev",
          url: `http://localhost:${PORT}`,
          reuseExistingServer: true,
          timeout: 240_000,
          stdout: "ignore" as const,
          stderr: "pipe" as const,
        },
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(MAC_VISIBLE_FPS ? { channel: "chrome", headless: false } : {}),
        // Hosted headless Linux requires SwiftShader, but it would turn a
        // Mac performance check into a software-rasterization benchmark.
        launchOptions: {
          args: MAC_VISIBLE_FPS ? [] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        },
      },
    },
  ],
});
