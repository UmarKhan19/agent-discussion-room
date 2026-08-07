import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCRIPTED_SCENARIO,
  currentScriptedScenario,
  resetScriptedScenario,
} from "@/discussion/scripted-discussion";
import { GET, POST } from "./route";

/**
 * The test-harness endpoint must be unreachable in every configuration that
 * is not the explicit deterministic mode, and that mode itself is rejected
 * in production by the environment contract (verified in
 * src/config/environment.test.ts). These tests exercise the route guard
 * against the real process environment.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  resetScriptedScenario();
});

describe("test-harness scenario route", () => {
  it("404s when the deterministic mode is not configured", async () => {
    const response = await POST(
      new Request("http://localhost/api/test-harness/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: [{ outcome: "transient-failure" }],
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await GET()).toMatchObject({ status: 404 });
  });

  it("404s on an unknown generation-mode value", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DISCUSSION_GENERATION_MODE", "scripted");

    const response = await POST(
      new Request("http://localhost/api/test-harness/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: [] }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("accepts a scenario in deterministic mode and applies it to the scripted adapter", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DISCUSSION_GENERATION_MODE", "deterministic");

    const response = await POST(
      new Request("http://localhost/api/test-harness/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: [
            { outcome: "success", content: "Scripted first Turn." },
            { outcome: "transient-failure" },
          ],
          fallback: { outcome: "success" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(currentScriptedScenario().turns).toHaveLength(2);
    expect(currentScriptedScenario().fallback).toEqual({ outcome: "success" });

    const read = await GET();
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.scenario.turns[0]).toEqual({
      outcome: "success",
      content: "Scripted first Turn.",
    });
  });

  it("rejects a scenario that does not match the scripted-turn contract", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DISCUSSION_GENERATION_MODE", "deterministic");

    const response = await POST(
      new Request("http://localhost/api/test-harness/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: [{ outcome: "explode" }] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(currentScriptedScenario()).toEqual(DEFAULT_SCRIPTED_SCENARIO);
  });

  it("rejects a non-JSON scenario body", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DISCUSSION_GENERATION_MODE", "deterministic");

    const response = await POST(
      new Request("http://localhost/api/test-harness/scenario", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
  });
});
