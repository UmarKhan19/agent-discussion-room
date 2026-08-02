import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscussionCancelledError,
  DiscussionGenerationError,
  type Discussion,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
} from "./discussion";
import { MastraDiscussion } from "./mastra-discussion";
import { FakeDiscussion } from "./testing/fake-discussion";

const request: GenerateDiscussionTurnInput = {
  topic: "Remote work is better than working from an office",
  speaker: "supporter",
  transcript: [],
};

const controlledResult: GeneratedDiscussionTurn = {
  content: "A controlled response",
  usage: {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
  },
};

const implementations: Array<{
  name: string;
  create: () => Discussion;
}> = [
  {
    name: "Mastra adapter",
    create: () => {
      const agent = {
        generate: async () => ({
          text: controlledResult.content,
          usage: controlledResult.usage,
        }),
      };

      return new MastraDiscussion({ supporter: agent, opponent: agent });
    },
  },
  {
    name: "deterministic fake",
    create: () =>
      new FakeDiscussion([
        { type: "success", result: controlledResult },
      ]),
  },
];

describe.each(implementations)("Discussion generation contract: $name", ({ create }) => {
  it("returns generated content and normalized usage", async () => {
    await expect(create().generateTurn(request)).resolves.toEqual(
      controlledResult,
    );
  });
});

describe("MastraDiscussion provider error normalization", () => {
  it.each([
    [{ status: 503, secret: "sk-secret" }, true],
    [{ code: "ECONNRESET", rawResponse: "provider body" }, true],
    [new Error("unclassified provider failure"), false],
  ])("classifies retryability without changing the stable adapter error", async (providerError, retryable) => {
    const agent = {
      generate: async () => {
        throw providerError;
      },
    };
    const discussion = new MastraDiscussion({
      supporter: agent,
      opponent: agent,
    });

    try {
      await discussion.generateTurn(request);
      throw new Error("Expected generation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscussionGenerationError);
      expect(error).toMatchObject({
        message: "Discussion generation failed",
        retryable,
      });
    }
  });
});

describe("FakeDiscussion controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays a successful outcome deterministically", async () => {
    vi.useFakeTimers();
    const discussion = new FakeDiscussion([
      { type: "success", result: controlledResult, delayMs: 100 },
    ]);
    const generated = discussion.generateTurn(request);
    let settled = false;
    void generated.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(generated).resolves.toEqual(controlledResult);
  });

  it("produces a controlled failure", async () => {
    const failure = new Error("controlled failure");
    const discussion = new FakeDiscussion([
      { type: "failure", error: failure },
    ]);

    await expect(discussion.generateTurn(request)).rejects.toBe(failure);
  });

  it("produces a controlled cancellation", async () => {
    const discussion = new FakeDiscussion([{ type: "cancellation" }]);

    await expect(discussion.generateTurn(request)).rejects.toBeInstanceOf(
      DiscussionCancelledError,
    );
  });

  it("honors cancellation while a delayed outcome is pending", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const discussion = new FakeDiscussion([
      { type: "success", result: controlledResult, delayMs: 100 },
    ]);
    const generated = discussion.generateTurn({
      ...request,
      signal: controller.signal,
    });
    const rejected = expect(generated).rejects.toBeInstanceOf(
      DiscussionCancelledError,
    );

    controller.abort();

    await rejected;
  });
});
