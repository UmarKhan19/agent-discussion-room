import { afterEach, describe, expect, it } from "vitest";
import {
  DiscussionCancelledError,
  DiscussionGenerationError,
  type GenerateDiscussionTurnInput,
} from "./discussion";
import { DiscussionOutputPolicy } from "./policy";
import {
  DEFAULT_SCRIPTED_SCENARIO,
  SCRIPTED_POLICY_VIOLATION_CONTENT,
  ScriptedDiscussion,
  currentScriptedScenario,
  defaultScriptedContent,
  resetScriptedScenario,
  setScriptedScenario,
} from "./scripted-discussion";

function input(overrides: Partial<GenerateDiscussionTurnInput> = {}): GenerateDiscussionTurnInput {
  return {
    topic: "Should cities create more public parks?",
    turn: 1,
    speaker: "supporter",
    transcript: [],
    ...overrides,
  };
}

afterEach(() => {
  resetScriptedScenario();
});

describe("ScriptedDiscussion", () => {
  it("produces deterministic default content per Speaker, Turn, and Topic", async () => {
    const adapter = new ScriptedDiscussion();

    const supporter = await adapter.generateTurn(
      input({ turn: 1, speaker: "supporter" }),
    );
    const opponent = await adapter.generateTurn(
      input({ turn: 2, speaker: "opponent" }),
    );

    expect(supporter.content).toBe(
      defaultScriptedContent("supporter", 1, "Should cities create more public parks?"),
    );
    expect(supporter.content).toContain("Supporter");
    expect(opponent.content).toContain("Opponent");
    expect(opponent.content).toContain("Turn 2");
  });

  it("uses scripted content when the scenario provides it", async () => {
    setScriptedScenario({
      turns: [{ outcome: "success", content: "A scripted opening statement." }],
    });
    const adapter = new ScriptedDiscussion();

    const result = await adapter.generateTurn(input());

    expect(result.content).toBe("A scripted opening statement.");
  });

  it("consumes the turn script in call order and falls back for later calls", async () => {
    setScriptedScenario({
      turns: [
        { outcome: "success", content: "First scripted reply." },
        { outcome: "success", content: "Second scripted reply." },
      ],
      fallback: { outcome: "success", content: "Fallback reply." },
    });
    const adapter = new ScriptedDiscussion();

    expect((await adapter.generateTurn(input({ turn: 1 }))).content).toBe(
      "First scripted reply.",
    );
    expect((await adapter.generateTurn(input({ turn: 2 }))).content).toBe(
      "Second scripted reply.",
    );
    expect((await adapter.generateTurn(input({ turn: 3 }))).content).toBe(
      "Fallback reply.",
    );
  });

  it("throws a retryable provider failure for a transient-failure outcome", async () => {
    setScriptedScenario({ turns: [{ outcome: "transient-failure" }] });
    const adapter = new ScriptedDiscussion();

    const failure = await adapter
      .generateTurn(input())
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(DiscussionGenerationError);
    expect((failure as DiscussionGenerationError).retryable).toBe(true);
  });

  it("produces content the server-owned output policy blocks", async () => {
    setScriptedScenario({ turns: [{ outcome: "policy-violation" }] });
    const adapter = new ScriptedDiscussion();

    const result = await adapter.generateTurn(input());

    expect(result.content).toBe(SCRIPTED_POLICY_VIOLATION_CONTENT);
    expect(
      new DiscussionOutputPolicy().evaluate(result.content).decision,
    ).toBe("blocked");
  });

  it("waits for the scripted delay before resolving", async () => {
    setScriptedScenario({
      turns: [{ outcome: "success", delayMs: 25 }],
    });
    const adapter = new ScriptedDiscussion();
    const startedAt = Date.now();

    await adapter.generateTurn(input());

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it("rejects promptly when the generation signal aborts during the delay", async () => {
    setScriptedScenario({
      turns: [{ outcome: "success", delayMs: 5_000 }],
    });
    const adapter = new ScriptedDiscussion();
    const controller = new AbortController();

    const pending = adapter.generateTurn(input({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DiscussionCancelledError);
  });

  it("resolves late even after abort when ignoreAbort simulates an uncooperative provider", async () => {
    setScriptedScenario({
      turns: [{ outcome: "success", delayMs: 15, ignoreAbort: true }],
    });
    const adapter = new ScriptedDiscussion();
    const controller = new AbortController();

    const pending = adapter.generateTurn(input({ signal: controller.signal }));
    controller.abort();

    const result = await pending;
    expect(result.content).toBe(defaultScriptedContent("supporter", 1, input().topic));
  });

  it("records every generation call in arrival order", async () => {
    const adapter = new ScriptedDiscussion();
    await adapter.generateTurn(input({ turn: 1 }));
    await adapter.generateTurn(input({ turn: 2, speaker: "opponent" }));

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]).toMatchObject({ turn: 1, speaker: "supporter" });
    expect(adapter.calls[1]).toMatchObject({ turn: 2, speaker: "opponent" });
  });
});

describe("scripted scenario registry", () => {
  it("defaults to the all-success scenario and resets on demand", () => {
    expect(currentScriptedScenario()).toEqual(DEFAULT_SCRIPTED_SCENARIO);

    setScriptedScenario({
      turns: [{ outcome: "transient-failure" }],
      fallback: { outcome: "success" },
    });
    expect(currentScriptedScenario().turns).toHaveLength(1);
    expect(currentScriptedScenario().fallback).toEqual({ outcome: "success" });

    resetScriptedScenario();
    expect(currentScriptedScenario()).toEqual(DEFAULT_SCRIPTED_SCENARIO);
  });
});
