import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscussionGenerationCapacityError,
  DiscussionGenerationFailedError,
  DiscussionRunner,
  DiscussionSessionQuotaExceededError,
} from "./discussion-runner";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  type DiscussionState,
} from "./contracts";
import {
  InMemoryDiscussionStore,
  type ClaimTurnResult,
  type DiscussionStore,
  type RequestStatusResult,
  type StopTurnResult,
  type TurnFailure,
  type TurnMutationResult,
} from "./discussion-service";
import { DiscussionGenerationError } from "./discussion";
import { FakeDiscussion, type FakeDiscussionOutcome } from "./testing/fake-discussion";
import type { DiscussionBudgets } from "./budgets";

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

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("DiscussionRunner time-windowed generation quota", () => {
  const windowMs = 60_000;

  function freshRunner(
    clock: () => Date,
    quotas: Partial<DiscussionBudgets>,
    outcomes: FakeDiscussionOutcome[],
  ): DiscussionRunner {
    return new DiscussionRunner({
      store: new StaleHintStore(),
      discussion: new FakeDiscussion(outcomes),
      budgets: {
        sessionGenerationQuota: 1,
        sessionGenerationQuotaWindowMs: windowMs,
        ...quotas,
      },
      now: clock,
    });
  }

  it("restores the per-session quota after the time window elapses", async () => {
    let currentTime = now;
    const clock = () => currentTime;
    const runner = freshRunner(clock, {}, [
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn },
    ]);

    // Charge the single quota slot.
    await runner.nextTurn(
      ownerSessionId,
      uuidFor(1),
      uuidFor(101),
    );

    // Quota exhausted — second request is blocked.
    await expect(
      runner.nextTurn(ownerSessionId, uuidFor(2), uuidFor(102)),
    ).rejects.toThrow(DiscussionSessionQuotaExceededError);

    // Advance past the window.
    currentTime = new Date(now.getTime() + windowMs + 1);

    // Quota restored — third request succeeds.
    const result = await runner.nextTurn(
      ownerSessionId,
      uuidFor(3),
      uuidFor(103),
    );
    expect(result).not.toBeNull();
  });

  it("carries retryAfterSeconds on the quota-exceeded error", async () => {
    const runner = freshRunner(() => now, {}, [
      { type: "success", result: generatedTurn },
    ]);

    await runner.nextTurn(ownerSessionId, uuidFor(1), uuidFor(101));

    let retryAfter: number | undefined;
    try {
      await runner.nextTurn(ownerSessionId, uuidFor(2), uuidFor(102));
    } catch (error) {
      if (error instanceof DiscussionSessionQuotaExceededError) {
        retryAfter = error.retryAfterSeconds;
      }
    }
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("consumes quota on provider failure (charge precedes generation)", async () => {
    const runner = freshRunner(() => now, {}, [
      { type: "failure", error: new Error("provider failure") },
      { type: "success", result: generatedTurn },
    ]);

    // The generation fails, but the quota charge has already happened.
    await expect(
      runner.nextTurn(ownerSessionId, uuidFor(1), uuidFor(101)),
    ).rejects.toThrow();

    // Quota is consumed — the next request is blocked.
    await expect(
      runner.nextTurn(ownerSessionId, uuidFor(2), uuidFor(102)),
    ).rejects.toThrow(DiscussionSessionQuotaExceededError);
  });

  it("removes expired sessions from the outer Map via periodic sweep", async () => {
    let currentTime = now;
    const clock = () => currentTime;
    const sessionCount = 200;
    const fake = new FakeDiscussion(
      Array.from({ length: sessionCount + 128 }, () => ({
        type: "success" as const,
        result: generatedTurn,
      })),
    );
    const runner = new DiscussionRunner({
      store: new StaleHintStore(),
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 500,
        sessionGenerationQuotaWindowMs: windowMs,
      },
      now: clock,
    });

    // Create 200 sessions, each charging one generation.
    for (let i = 0; i < sessionCount; i += 1) {
      await runner.nextTurn(
        uuidFor(i),
        uuidFor(i + 10_000),
        uuidFor(i + 20_000),
      );
    }
    expect(runner.quotaSize).toBe(sessionCount);

    // All windows expire.
    currentTime = new Date(now.getTime() + windowMs + 1);

    // Trigger the amortized periodic sweep (every QUOTA_SWEEP_INTERVAL
    // check calls) via enough nextTurn calls with fresh sessions.
    for (let i = 0; i < 128; i += 1) {
      await runner.nextTurn(
        uuidFor(i + 30_000),
        uuidFor(i + 40_000),
        uuidFor(i + 50_000),
      );
    }

    // Old sessions swept; only the new ones remain.
    expect(runner.quotaSize).toBeLessThan(sessionCount);
  });

  it("contains the final-slot race: two concurrent unique requests from one session never both generate", async () => {
    vi.useFakeTimers();
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, {}));
    await store.create(ownerSessionId, stateFor(secondDiscussionId, {}));
    await store.create(ownerSessionId, stateFor(thirdDiscussionId, {}));

    // Outcomes: the prior charge, the race winner, and the later fresh
    // session. The winner is kept in flight so the losing path can be
    // observed while it still holds its capacity slot.
    const fake = new FakeDiscussion([
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn, delayMs: 100 },
      { type: "success", result: generatedTurn, delayMs: 100 },
    ]);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 2,
        sessionGenerationQuotaWindowMs: windowMs,
        maxConcurrentGenerations: 2,
      },
      now: () => now,
    });

    // Consume the first of two slots.
    await runner.nextTurn(ownerSessionId, discussionId, requestId);
    expect(fake.calls).toHaveLength(1);

    // Two unique requests from the SAME session race for the final slot.
    // Both pass the advisory check (one slot remains), both claim, both
    // acquire capacity; only the authoritative charge may proceed.
    const winner = runner.nextTurn(
      ownerSessionId,
      secondDiscussionId,
      secondRequestId,
    );
    const loser = runner.nextTurn(
      ownerSessionId,
      thirdDiscussionId,
      thirdRequestId,
    );
    // Attach the rejection assertion immediately so the loser's rejection
    // is handled the moment it settles (no unhandled-rejection window).
    const loserRejection = expect(loser).rejects.toThrow(
      DiscussionSessionQuotaExceededError,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Exactly one provider generation started from the race.
    expect(fake.calls).toHaveLength(2);

    // The loser receives the quota error, not a generation outcome.
    await loserRejection;

    // The winner is mid-generation.
    expect(
      (await store.readOwned(ownerSessionId, secondDiscussionId))?.status,
    ).toBe("generating");

    // The loser's persisted claim was reconciled into a retryable failed
    // state: the Discussion is not stuck in `generating`, committed no
    // Turn, and the same request identity can be retried once the window
    // resets.
    const loserState = await store.readOwned(ownerSessionId, thirdDiscussionId);
    expect(loserState?.status).toBe("failed");
    expect(loserState?.terminalReason).toBeNull();
    expect(loserState?.transcript).toHaveLength(0);
    expect(
      await store.requestStatus(
        ownerSessionId,
        thirdDiscussionId,
        thirdRequestId,
      ),
    ).toEqual({ kind: "failed", retryable: true });

    // Capacity was fully released by the losing path: a fresh session can
    // start a generation while the winner still holds its slot.
    await store.create(secondSessionId, stateFor(fourthDiscussionId, {}));
    const fourth = runner.nextTurn(
      secondSessionId,
      fourthDiscussionId,
      "88888888-2222-4222-8222-222222222222",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(3);

    // Complete the winner and the fresh session: exactly one Turn is
    // committed for the winner, none for the loser.
    await vi.advanceTimersByTimeAsync(100);
    await expect(winner).resolves.not.toBeNull();
    await expect(fourth).resolves.not.toBeNull();
    expect(
      (await store.readOwned(ownerSessionId, secondDiscussionId))?.transcript,
    ).toHaveLength(1);
    expect(
      (await store.readOwned(ownerSessionId, thirdDiscussionId))?.transcript,
    ).toHaveLength(0);
  });

  it("never recharges or regenerates a successful replay, even after the window elapses", async () => {
    let currentTime = now.getTime();
    const clock = () => new Date(currentTime);
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, {}));
    const fake = new FakeDiscussion([
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn },
    ]);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 1,
        sessionGenerationQuotaWindowMs: windowMs,
      },
      now: clock,
    });

    // Charge the single slot and commit a Turn.
    await runner.nextTurn(ownerSessionId, discussionId, requestId);
    expect(fake.calls).toHaveLength(1);

    // Advance past the window: the in-memory charge key is gone, so a
    // non-authoritative implementation could wrongly re-admit the replay.
    currentTime = now.getTime() + windowMs + 1;

    // The persisted outcome is authoritative: the replay returns the
    // committed state without invoking the provider or consuming quota.
    const replay = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(replay).not.toBeNull();
    expect(replay?.transcript).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);

    // A NEW identity still has the fresh window's full allowance: had the
    // replay consumed the window's single slot, this would be blocked.
    await store.create(ownerSessionId, stateFor(secondDiscussionId, {}));
    const next = await runner.nextTurn(
      ownerSessionId,
      secondDiscussionId,
      secondRequestId,
    );
    expect(next).not.toBeNull();
    expect(fake.calls).toHaveLength(2);
  });

  it("charges a retry from a later quota window against that window's allowance", async () => {
    let currentTime = now.getTime();
    const clock = () => new Date(currentTime);
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, {}));
    const fake = new FakeDiscussion([
      {
        type: "failure",
        error: new DiscussionGenerationError(new Error("transient"), true),
      },
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn },
    ]);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 1,
        sessionGenerationQuotaWindowMs: windowMs,
      },
      now: clock,
    });

    // Window 1: the generation is admitted (charged) but fails retryably.
    await expect(
      runner.nextTurn(ownerSessionId, discussionId, requestId),
    ).rejects.toThrow(DiscussionGenerationFailedError);

    // Advance past the window.
    currentTime = now.getTime() + windowMs + 1;

    // Window 2: retrying the SAME logical request is a fresh provider
    // execution in a fresh cost window, so it consumes window 2's slot.
    const retried = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(retried).not.toBeNull();
    expect(retried?.transcript).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);

    // Window 2's allowance is now spent: a new identity is blocked, which
    // proves the retry was charged to the later window.
    await store.create(ownerSessionId, stateFor(secondDiscussionId, {}));
    await expect(
      runner.nextTurn(ownerSessionId, secondDiscussionId, secondRequestId),
    ).rejects.toThrow(DiscussionSessionQuotaExceededError);
    expect(fake.calls).toHaveLength(2);
  });
});
