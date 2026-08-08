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

describe("ScriptedDiscussion synthesis", () => {
  it("produces deterministic default synthesis content", async () => {
    const fake = new ScriptedDiscussion();
    const result = await fake.generateSynthesis({
      topic: "Should cities create more public parks?",
      transcript: [
        {
          id: "33333333-3333-4333-8333-000000000001",
          content: "yes",
          speaker: "supporter",
          createdAt: "2026-08-02T12:00:00.000Z",
          turn: 1,
          generation: {
            requestId: "44444444-4444-4444-8444-444444444444",
            outputPolicyOutcome: {
              decision: "allowed",
              category: null,
              checkedAt: "2026-08-02T12:00:00.000Z",
            },
          },
        },
        {
          id: "33333333-3333-4333-8333-000000000002",
          content: "no",
          speaker: "opponent",
          createdAt: "2026-08-02T12:00:00.000Z",
          turn: 2,
          generation: {
            requestId: "55555555-5555-4555-8555-555555555555",
            outputPolicyOutcome: {
              decision: "allowed",
              category: null,
              checkedAt: "2026-08-02T12:00:00.000Z",
            },
          },
        },
      ],
    });
    expect(result.model).toBe("deterministic/scripted");
    const parsed = JSON.parse(result.content) as {
      strongestSupport: string;
      strongestOpposition: string;
      agreements: string[];
      unresolved: string;
      claimsToVerify: string[];
      takeaway: string;
    };
    expect(parsed.strongestSupport).toContain("cities create more public parks");
    expect(parsed.strongestOpposition).toContain("against");
    expect(parsed.takeaway).toContain("2 turns");
  });

  it("uses scripted synthesis content and records the call", async () => {
    setScriptedScenario({
      turns: [],
      synthesis: {
        syntheses: [
          { outcome: "success", content: '{"takeaway":"scripted"}' },
        ],
      },
    });
    const fake = new ScriptedDiscussion();
    const result = await fake.generateSynthesis({
      topic: "t",
      transcript: [],
    });
    expect(result.content).toBe('{"takeaway":"scripted"}');
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(fake.synthesisCalls[0].topic).toBe("t");
  });

  it("throws a retryable failure for a transient synthesis failure", async () => {
    setScriptedScenario({
      turns: [],
      synthesis: { syntheses: [{ outcome: "transient-failure" }] },
    });
    const fake = new ScriptedDiscussion();
    await expect(
      fake.generateSynthesis({ topic: "t", transcript: [] }),
    ).rejects.toMatchObject({ retryable: true });
    // Generations beyond the scripted list fall back to success.
    await expect(
      fake.generateSynthesis({ topic: "t", transcript: [] }),
    ).resolves.toBeDefined();
  });

  it("emits policy-violating and invalid synthesis responses", async () => {
    setScriptedScenario({
      turns: [],
      synthesis: {
        syntheses: [
          { outcome: "policy-violation" },
          { outcome: "invalid-response" },
        ],
      },
    });
    const fake = new ScriptedDiscussion();
    const blocked = await fake.generateSynthesis({ topic: "t", transcript: [] });
    const blockedParsed = JSON.parse(blocked.content) as {
      strongestSupport: string;
    };
    expect(blockedParsed.strongestSupport).toBe(
      SCRIPTED_POLICY_VIOLATION_CONTENT,
    );
    const invalid = await fake.generateSynthesis({ topic: "t", transcript: [] });
    expect(invalid.content).toBe("this is not valid synthesis JSON at all");
  });

  it("resets the synthesis script with the scenario", () => {
    setScriptedScenario({
      turns: [],
      synthesis: { syntheses: [{ outcome: "transient-failure" }] },
    });
    resetScriptedScenario();
    expect(currentScriptedScenario().synthesis).toEqual({
      syntheses: [],
      synthesisFallback: { outcome: "success" },
    });
  });
});
