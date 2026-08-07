import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscussionGenerationCapacityError,
  DiscussionRunner,
  DiscussionSessionQuotaExceededError,
} from "./discussion-runner";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  type DiscussionState,
} from "./contracts";
import type {
  ClaimTurnResult,
  DiscussionStore,
  RequestStatusResult,
  StopTurnResult,
  TurnFailure,
  TurnMutationResult,
} from "./discussion-service";
import { FakeDiscussion } from "./testing/fake-discussion";

const now = new Date("2026-08-02T12:00:00.000Z");
const ownerSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const discussionId = "11111111-1111-4111-8111-111111111111";
const secondDiscussionId = "22222222-1111-4111-8111-111111111111";
const thirdDiscussionId = "33333333-1111-4111-8111-111111111111";
const fourthDiscussionId = "44444444-1111-4111-8111-111111111111";
const requestId = "44444444-2222-4222-8222-222222222222";
const secondRequestId = "55555555-2222-4222-8222-222222222222";
const thirdRequestId = "66666666-2222-4222-8222-222222222222";

const generatedTurn = {
  content: "Public parks give more residents access to shared green space.",
  usage: {
    inputTokens: 12,
    outputTokens: 9,
    totalTokens: 21,
  },
};

function stateFor(
  id: string,
  patch: Partial<DiscussionState>,
): DiscussionState {
  return DiscussionStateSchema.parse({
    id,
    topic: "Should cities create more public parks?",
    status: "idle",
    terminalReason: null,
    turnLimit: 12,
    turnCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    policyOutcome: {
      decision: "allowed",
      category: null,
      checkedAt: now.toISOString(),
    },
    transcript: [],
    ...patch,
  });
}

function completedStateFor(id: string): DiscussionState {
  // A completed first Turn: one Message, Turn count advanced once.
  const message = DiscussionMessageSchema.parse({
    id: "77777777-3333-4333-8333-333333333333",
    content: generatedTurn.content,
    speaker: "supporter",
    createdAt: now.toISOString(),
    turn: 1,
    generation: {
      requestId,
      usage: generatedTurn.usage,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
    },
  });
  return stateFor(id, { turnCount: 1, transcript: [message] });
}

/**
 * Store that deterministically reproduces the capacity race the Runner's
 * old hint-based guard could not see: `requestStatus` reports the request
 * as still `generating` (a valid lease), while `claimTurn` actually
 * succeeds — the lease expired and the attempt was recovered in between,
 * turning the call into a legitimate fresh claim. Capacity must therefore
 * be decided from the claim result, not from the stale hint.
 */
class StaleHintStore implements DiscussionStore {
  requestStatusCalls = 0;
  claimedAttempts: Array<{
    discussionId: string;
    requestId: string;
    attemptId: string;
  }> = [];
  resolvedFailures: Array<{
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
  }> = [];

  async create(): Promise<void> {}

  async readOwned(): Promise<DiscussionState | null> {
    return null;
  }

  async requestStatus(): Promise<RequestStatusResult> {
    this.requestStatusCalls += 1;
    // The stale pre-claim hint: the attempt looked actively generating
    // with a still-valid lease when the old guard consulted it.
    return { kind: "generating" };
  }

  async claimTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimTurnResult> {
    this.claimedAttempts.push({
      discussionId: input.discussionId,
      requestId: input.requestId,
      attemptId: input.attemptId,
    });
    // The claim legitimately succeeds: by now the expired attempt was
    // recovered, so this request is a fresh retry of the abandoned Turn.
    return {
      kind: "claimed",
      discussion: stateFor(input.discussionId, { status: "generating" }),
      turn: 1,
      attemptId: input.attemptId,
    };
  }

  async completeTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    message: unknown;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    return {
      kind: "updated",
      discussion: completedStateFor(input.discussionId),
    };
  }

  async failTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    this.resolvedFailures.push(input);
    return {
      kind: "updated",
      discussion: stateFor(input.discussionId, { status: "failed" }),
    };
  }

  async cancelTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    reason: "disconnect" | "timeout";
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    return {
      kind: "updated",
      discussion: stateFor(input.discussionId, { status: "failed" }),
    };
  }

  async stopOwned(): Promise<StopTurnResult> {
    return { kind: "invalid_state" };
  }
}

describe("DiscussionRunner generation capacity", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reserves capacity from the claim result, never from a stale status hint", async () => {
    vi.useFakeTimers();
    const store = new StaleHintStore();
    const fake = new FakeDiscussion([
      { type: "success", result: generatedTurn, delayMs: 100 },
      { type: "success", result: generatedTurn },
    ]);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: { maxConcurrentGenerations: 1 },
      now: () => now,
    });

    // The first generation claims and holds the only capacity slot.
    const first = runner.nextTurn(ownerSessionId, discussionId, requestId);
    // Flush the microtask queue until the claim is made, the capacity slot
    // is acquired, and provider work has started (no wall-clock sleeps).
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(1);

    // The discovered race: requestStatus reports a still-valid lease
    // ("generating"), but by the time claimTurn runs the lease has expired
    // and the attempt was recovered, so the claim legitimately succeeds.
    // The Runner must not start provider work without a slot.
    const second = runner.nextTurn(
      ownerSessionId,
      secondDiscussionId,
      secondRequestId,
    );
    await expect(second).rejects.toThrow(DiscussionGenerationCapacityError);
    expect(fake.calls).toHaveLength(1);

    // The durable claim was resolved into a retryable failure, not
    // abandoned: the Turn is not stranded for the lease duration and a
    // later retry can claim it.
    expect(store.claimedAttempts).toHaveLength(2);
    expect(store.resolvedFailures).toHaveLength(1);
    expect(store.resolvedFailures[0]).toMatchObject({
      discussionId: secondDiscussionId,
      requestId: secondRequestId,
      expectedTurn: 1,
      failure: { kind: "generation_failed", retryable: true },
    });

    // The slot is released when the first generation completes...
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBeTruthy();

    // ...so a later claim starts provider work only with a slot held.
    const third = runner.nextTurn(
      ownerSessionId,
      thirdDiscussionId,
      thirdRequestId,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    await expect(third).resolves.toBeTruthy();
  });

  it("does not charge quota for a capacity-rejected claim", async () => {
    vi.useFakeTimers();
    const store = new StaleHintStore();
    const fake = new FakeDiscussion([
      { type: "success", result: generatedTurn, delayMs: 100 },
      { type: "success", result: generatedTurn },
    ]);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: { maxConcurrentGenerations: 1, sessionGenerationQuota: 1 },
      now: () => now,
    });

    const first = runner.nextTurn(ownerSessionId, discussionId, requestId);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(1);

    // A different session hits the capacity rejection after the durable
    // claim; its quota must remain untouched because the attempt never
    // generated. With a quota of one, any charge would exhaust it.
    await expect(
      runner.nextTurn(secondSessionId, secondDiscussionId, secondRequestId),
    ).rejects.toThrow(DiscussionGenerationCapacityError);

    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBeTruthy();

    // Session A spent its single charge, so a second claim is blocked:
    // the quota of one is genuinely binding, not merely unenforced.
    const third = runner.nextTurn(
      ownerSessionId,
      thirdDiscussionId,
      thirdRequestId,
    );
    await expect(third).rejects.toThrow(DiscussionSessionQuotaExceededError);

    // ...and session B can still make its first legitimate generation.
    // Only a zero-charge rejection leaves room under the quota of one, so
    // this success proves the capacity-rejected attempt was never charged
    // against session B.
    const fourth = runner.nextTurn(
      secondSessionId,
      fourthDiscussionId,
      thirdRequestId,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(fourth).resolves.toBeTruthy();
    expect(fake.calls).toHaveLength(2);
  });
});
