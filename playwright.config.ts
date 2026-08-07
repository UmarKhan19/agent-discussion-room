import { defineConfig } from "@playwright/test";

/**
 * Deterministic browser suite for the Agent Discussion Room.
 *
 * The suite runs the app in `DISCUSSION_GENERATION_MODE=deterministic`: a
 * development/test-only, credential-free scripted generation adapter that
 * never contacts a provider. Each test scripts the adapter's behavior (fast
 * success, delayed Turns, transient failures, policy-violating output,
 * abort-ignoring providers) through the test-harness endpoint before
 * exercising the real server-owned HTTP surface and UI.
 *
 * Determinism choices:
 * - One shared dev server carries a process-wide scripted scenario, so the
 *   suite runs with a single worker and serial tests: any other arrangement
 *   could let one test's script leak into another test's generation.
 * - The in-memory store is forced (`DISCUSSION_STORE_URL` empty) so the
 *   suite leaves no durable data behind; no provider credential is set or
 *   required, so there are no live model calls.
 * - A 4-Turn limit bounds every journey, and scripted delays are capped at
 *   a few seconds, keeping the whole suite stable and bounded in duration.
 */
export default defineConfig({
  testDir: "./e2e",
  // One worker, serial tests: the scripted scenario is process-wide.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Deterministic, credential-free generation (rejected in production).
      DISCUSSION_GENERATION_MODE: "deterministic",
      // Bounded journeys: four Turns complete fast while still showing
      // alternating Speakers and progress.
      DISCUSSION_TURN_LIMIT: "4",
      // Force the explicit in-memory store even if the shell exports a
      // durable URL; the suite must leave no durable data behind.
      DISCUSSION_STORE_URL: "",
      // One serial suite shares a network address; keep the guardroom wide
      // so the deterministic tests never trip rate limits.
      DISCUSSION_NETWORK_RATE_LIMIT: "5000",
      DISCUSSION_NETWORK_RATE_WINDOW_MS: "60000",
    },
  },
});
