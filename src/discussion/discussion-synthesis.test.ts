import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscussionGenerationCapacityError,
  DiscussionInvalidStateError,
  DiscussionRunner,
  DiscussionSessionQuotaExceededError,
} from "./discussion-runner";
import { DiscussionGenerationError } from "./discussion";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  SYNTHESIS_REQUEST_ID,
  type DiscussionState,
  type SynthesisContent,
} from "./contracts";
import { InMemoryDiscussionStore } from "./discussion-service";
import { FakeDiscussion } from "./testing/fake-discussion";
import { CapturingTelemetry } from "../observability/telemetry";
import { TelemetryEventSchema } from "../observability/telemetry";

const now = new Date("2026-08-02T12:00:00.000Z");
const ownerSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const discussionId = "11111111-1111-4111-8111-111111111111";
const secondDiscussionId = "22222222-1111-4111-8111-111111111111";
const requestId = "44444444-2222-4222-8222-222222222222";
const secondRequestId = "55555555-2222-4222-8222-222222222222";
const attemptIdA = "66666666-2222-4222-8222-222222222222";
const attemptIdB = "77777777-2222-4222-8222-222222222222";

const generatedTurn = {
  content: "Public parks give more residents access to shared green space.",
  usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
};

const synthesizedContent: SynthesisContent = {
  strongestSupport: "Parks serve residents who lack private green space.",
  strongestOpposition: "Parks divert funds from other public services.",
  agreements: ["Green space is broadly valued."],
  unresolved: "How to fund long-term maintenance.",
  claimsToVerify: ["Property values near parks rise."],
  takeaway: "Pilot one park before a city-wide rollout.",
};

const generatedSynthesis = {
  content: JSON.stringify(synthesizedContent),
  usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
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

/** Narrow the synthesis union for direct member access in assertions. */
function failedSynthesis(state: DiscussionState | null | undefined) {
  const synthesis = state?.synthesis;
  return synthesis?.status === "failed" ? synthesis : null;
}

function completedSynthesis(state: DiscussionState | null | undefined) {
  const synthesis = state?.synthesis;
  return synthesis?.status === "completed" ? synthesis : null;
}

function message(turn: number, generationRequestId = requestId) {
  return DiscussionMessageSchema.parse({
    id: `${String(turn).padStart(8, "0")}-3333-4333-8333-333333333333`,
    content: generatedTurn.content,
    speaker: turn % 2 === 1 ? "supporter" : "opponent",
    createdAt: now.toISOString(),
    turn,
    generation: {
      requestId: generationRequestId,
      usage: generatedTurn.usage,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
    },
  });
}

function completedState(id: string, turnCount: number): DiscussionState {
  return stateFor(id, {
    status: "completed",
    turnLimit: turnCount,
    turnCount,
    transcript: Array.from({ length: turnCount }, (_, index) =>
      message(index + 1, index === turnCount - 1 ? secondRequestId : requestId),
    ),
  });
}

function completedWithSynthesis(
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...stateFor(discussionId, {
      status: "completed",
      turnLimit: 2,
      turnCount: 2,
      transcript: [message(1), message(2)],
    }),
    synthesis: {
      status: "completed",
      requestId: SYNTHESIS_REQUEST_ID,
      attemptId: attemptIdA,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      content,
    },
  };
}

describe("Discussion synthesis lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the final Turn with exactly one synthesis, which is not a Turn", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 2 }));
    const fake = new FakeDiscussion(
      [
        { type: "success", result: generatedTurn },
        { type: "success", result: generatedTurn },
      ],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    await runner.nextTurn(ownerSessionId, discussionId, requestId);
    const result = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      secondRequestId,
    );

    expect(result?.status).toBe("completed");
    // Exactly two Turns and exactly one synthesis were generated.
    expect(fake.calls).toHaveLength(2);
    expect(fake.synthesisCalls).toHaveLength(1);
    // The synthesis is NOT a Turn: count and Transcript are untouched.
    expect(result?.turnCount).toBe(2);
    expect(result?.transcript).toHaveLength(2);
    expect(result?.transcript.map((m) => m.content)).not.toContain(
      synthesizedContent.strongestSupport,
    );
    // The synthesis committed with validated structured content.
    expect(result?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(result)?.content).toEqual(synthesizedContent);
    expect(result?.synthesis?.requestId).toBe(SYNTHESIS_REQUEST_ID);
    expect(completedSynthesis(result)?.outputPolicyOutcome).toEqual({
      decision: "allowed",
      category: null,
      checkedAt: now.toISOString(),
    });
  });

  it("resumes a transiently failed synthesis through the durable retry without the final-Turn request identity", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 2 }));
    const fake = new FakeDiscussion(
      [
        { type: "success", result: generatedTurn },
        { type: "success", result: generatedTurn },
      ],
      [
        {
          type: "failure",
          error: new DiscussionGenerationError(
            new Error("scripted provider outage"),
            true,
          ),
        },
      ],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    await runner.nextTurn(ownerSessionId, discussionId, requestId);
    const failed = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      secondRequestId,
    );
    expect(failed?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(failed)?.failure).toEqual({
      kind: "generation_failed",
      retryable: true,
    });
    // The debate Turn committed despite the synthesis failure.
    expect(fake.calls).toHaveLength(2);
    expect(failed?.turnCount).toBe(2);
    expect(failed?.transcript).toHaveLength(2);

    // Resume through the durable retry seam with NO request identity: the
    // server derives ownership from the session and the retry decision
    // from the persisted synthesis state, so no browser-held final-Turn
    // request is involved. The debate Turn is neither replayed nor
    // regenerated and the logical synthesis is charged at most once.
    fake.enqueueSynthesis({ type: "success", result: generatedSynthesis });
    const retried = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(fake.calls).toHaveLength(2);
    expect(fake.synthesisCalls).toHaveLength(2);
    expect(retried?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(retried)?.content).toEqual(synthesizedContent);
    expect(retried?.turnCount).toBe(2);
    expect(retried?.transcript).toHaveLength(2);
  });

  it("never resumes the synthesis from a replayed final-Turn request", async () => {
    // The Turn request identity is only a Turn identity: replaying it on a
    // completed Discussion returns the authoritative state and never
    // triggers, resumes, or regenerates the synthesis. Synthesis retry is
    // a distinct server-owned operation (`retrySynthesis`).
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [
        {
          type: "failure",
          error: new DiscussionGenerationError(
            new Error("scripted provider outage"),
            true,
          ),
        },
      ],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const failed = await runner.nextTurn(ownerSessionId, discussionId, requestId);
    expect(failed?.synthesis?.status).toBe("failed");

    const replayed = await runner.nextTurn(ownerSessionId, discussionId, requestId);
    // The replay observes the persisted failure; it does not resume it.
    expect(replayed?.synthesis?.status).toBe("failed");
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(replayed?.status).toBe("completed");
  });

  it("marks malformed synthesis output as a non-retryable invalid response and never regenerates on replay", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: { content: "not json at all" } }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const result = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(result?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(result)?.failure).toEqual({
      kind: "invalid_response",
      retryable: false,
    });

    // Replaying the request observes the terminal failure: no retry.
    const replayed = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(replayed?.synthesis?.status).toBe("failed");
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(replayed?.status).toBe("completed");
  });

  it("times out an over-long synthesis and rejects its late result as stale", async () => {
    vi.useFakeTimers();
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [
        {
          type: "success",
          result: generatedSynthesis,
          delayMs: 1_000,
          // Simulates a provider that ignores the abort signal and resolves
          // late; the Runner must discard the late result.
          ignoreAbort: true,
        },
      ],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: { generationTimeoutMs: 50 },
      now: () => now,
    });

    const generation = runner.nextTurn(ownerSessionId, discussionId, requestId);
    await vi.advanceTimersByTimeAsync(0);
    // The synthesis exceeds the 50 ms generation timeout.
    await vi.advanceTimersByTimeAsync(50);
    const result = await generation;
    expect(result?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(result)?.failure).toEqual({
      kind: "timeout",
      retryable: false,
    });

    // The provider resolves late; the persisted state stays failed-timeout
    // (the stale attempt can never commit).
    await vi.advanceTimersByTimeAsync(2_000);
    const persisted = await store.readOwned(ownerSessionId, discussionId);
    expect(persisted?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(persisted)?.failure).toEqual({
      kind: "timeout",
      retryable: false,
    });
  });

  it("blocks a policy-violating synthesis into an output_blocked failure", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const violating = {
      ...synthesizedContent,
      strongestSupport: "Religious minorities should be killed.",
    };
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: { content: JSON.stringify(violating) } }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const result = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(result?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(result)?.failure).toEqual({
      kind: "output_blocked",
      retryable: false,
      category: "protected_class_violence_advocacy",
    });
    // The committed debate is untouched and fully visible.
    expect(result?.turnCount).toBe(1);
    expect(result?.transcript).toHaveLength(1);
  });

  it("holds a capacity slot while the synthesis is generating", async () => {
    vi.useFakeTimers();
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    await store.create(secondSessionId, stateFor(secondDiscussionId, {}));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      // The synthesis is deliberately slow: it must hold the only capacity
      // slot for its whole generation, exactly like a Turn does.
      [{ type: "success", result: generatedSynthesis, delayMs: 100 }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: { maxConcurrentGenerations: 1 },
      now: () => now,
    });

    const finalTurn = runner.nextTurn(ownerSessionId, discussionId, requestId);
    await vi.advanceTimersByTimeAsync(0);
    // The Turn committed and its synthesis is now generating, holding the
    // only slot.
    expect(fake.calls).toHaveLength(1);
    expect(fake.synthesisCalls).toHaveLength(1);

    // A concurrent Turn is capacity-rejected: the synthesis occupies the
    // slot, so the pool is honored across both kinds of generation.
    await expect(
      runner.nextTurn(secondSessionId, secondDiscussionId, secondRequestId),
    ).rejects.toThrow(DiscussionGenerationCapacityError);

    await vi.advanceTimersByTimeAsync(100);
    const result = await finalTurn;
    expect(result?.synthesis?.status).toBe("completed");
  });

  it("charges the synthesis as one logical generation unit per Discussion", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 2,
        sessionGenerationQuotaWindowMs: 60_000,
      },
      now: () => now,
    });

    // The final Turn and the completion synthesis are each one provider
    // generation, so together they consume both logical quota units.
    const result = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(result?.status).toBe("completed");
    expect(result?.synthesis?.status).toBe("completed");
    expect(fake.synthesisCalls).toHaveLength(1);

    // The quota is genuinely binding across both kinds of generation: the
    // window's two units are consumed, so a fresh generation is denied.
    await store.create(ownerSessionId, stateFor(secondDiscussionId, {}));
    await expect(
      runner.nextTurn(ownerSessionId, secondDiscussionId, secondRequestId),
    ).rejects.toThrow(DiscussionSessionQuotaExceededError);
  });

  it("quota exhaustion before the synthesis leaves the debate intact and a retryable synthesis state", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 1,
        sessionGenerationQuotaWindowMs: 60_000,
      },
      now: () => now,
    });

    // The final Turn consumes the only unit; the synthesis is quota-denied
    // AFTER its claim but BEFORE any provider work, and the claim is
    // reconciled into the same retryable failed state recovery produces.
    // The committed debate stays fully intact and no synthesis generated.
    const result = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(result?.status).toBe("completed");
    expect(result?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(result)?.failure).toEqual({
      kind: "generation_failed",
      retryable: true,
    });
    expect(fake.synthesisCalls).toHaveLength(0);
    expect(result?.turnCount).toBe(1);
    expect(result?.transcript).toHaveLength(1);
  });

  it("a retryable synthesis retry does not charge quota twice", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [
        {
          type: "failure",
          error: new DiscussionGenerationError(
            new Error("scripted provider outage"),
            true,
          ),
        },
      ],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 2,
        sessionGenerationQuotaWindowMs: 60_000,
      },
      now: () => now,
    });

    const failed = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(failed?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(failed)?.failure.retryable).toBe(true);

    // The retry is the SAME logical synthesis: it reuses the synthesis
    // charge key, so it generates without consuming another quota unit.
    fake.enqueueSynthesis({ type: "success", result: generatedSynthesis });
    const retried = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(retried?.synthesis?.status).toBe("completed");
    expect(fake.synthesisCalls).toHaveLength(2);

    // Both the Turn and the first synthesis charge are consumed — the
    // retry added nothing — so the window's two units are exhausted and a
    // fresh generation is denied.
    await store.create(ownerSessionId, stateFor(secondDiscussionId, {}));
    await expect(
      runner.nextTurn(ownerSessionId, secondDiscussionId, secondRequestId),
    ).rejects.toThrow(DiscussionSessionQuotaExceededError);
  });

  it("a quota-denied synthesis retries and commits once the window resets", async () => {
    let currentTime = now;
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      budgets: {
        sessionGenerationQuota: 1,
        sessionGenerationQuotaWindowMs: 60_000,
      },
      now: () => currentTime,
    });

    const denied = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(denied?.synthesis?.status).toBe("failed");
    expect(fake.synthesisCalls).toHaveLength(0);

    // Within the window the durable retry stays denied and never generates.
    const retryInWindow = await runner.retrySynthesis(
      ownerSessionId,
      discussionId,
    );
    expect(retryInWindow?.synthesis?.status).toBe("failed");
    expect(fake.synthesisCalls).toHaveLength(0);

    // After the window elapses the same logical synthesis charges from the
    // fresh window and generates exactly once — no duplicate charge, no
    // regenerated debate Turn.
    currentTime = new Date(currentTime.getTime() + 61_000);
    const committed = await runner.retrySynthesis(
      ownerSessionId,
      discussionId,
    );
    expect(committed?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(committed)?.content).toEqual(synthesizedContent);
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(committed?.turnCount).toBe(1);
    expect(committed?.transcript).toHaveLength(1);
  });

  it("replays an already-synthesized final Turn idempotently without regenerating", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const first = await runner.nextTurn(ownerSessionId, discussionId, requestId);
    const replayed = await runner.nextTurn(
      ownerSessionId,
      discussionId,
      requestId,
    );
    expect(replayed?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(replayed)?.content).toEqual(synthesizedContent);
    expect(replayed?.updatedAt).toBe(first?.updatedAt);
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("resumes a missing synthesis after a crash through the durable retry without the final-Turn request identity", async () => {
    // The final Turn committed (status completed, request recorded as
    // succeeded) but the process died before the synthesis was ever
    // claimed: the persisted state has no `synthesis` field. The durable
    // retry seam must produce the synthesis — never regenerate the Turn —
    // so an outage cannot strand the completion step permanently, and no
    // browser-held final-Turn request identity is involved.
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    await store.completeTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId: attemptIdA,
      expectedTurn: 1,
      message: message(1, requestId),
      updatedAt: now.toISOString(),
    });
    const before = await store.readOwned(ownerSessionId, discussionId);
    expect(before?.status).toBe("completed");
    expect(before?.synthesis).toBeUndefined();

    const fake = new FakeDiscussion(
      [],
      [{ type: "success", result: generatedSynthesis }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const resumed = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(resumed?.status).toBe("completed");
    expect(resumed?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(resumed)?.content).toEqual(synthesizedContent);
    // The debate Turn was NOT regenerated by the resume.
    expect(fake.calls).toHaveLength(0);
    expect(fake.synthesisCalls).toHaveLength(1);
    expect(resumed?.turnCount).toBe(1);
    expect(resumed?.transcript).toHaveLength(1);
  });

  it("never regenerates an already-completed synthesis on retry", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    await store.completeSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      content: synthesizedContent,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    });
    const fake = new FakeDiscussion([], []);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const before = await store.readOwned(ownerSessionId, discussionId);
    const retried = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(retried?.synthesis?.status).toBe("completed");
    expect(completedSynthesis(retried)?.content).toEqual(synthesizedContent);
    expect(retried?.updatedAt).toBe(before?.updatedAt);
    expect(fake.synthesisCalls).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("observes a live generating synthesis attempt without a duplicate generation", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    const fake = new FakeDiscussion([], []);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    // A valid live attempt must not be recovered or duplicated by a retry.
    const observed = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(observed?.synthesis?.status).toBe("generating");
    expect(fake.synthesisCalls).toHaveLength(0);
  });

  it("two concurrent synthesis retries commit at most one synthesis", async () => {
    vi.useFakeTimers();
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    // The synthesis is retryable-failed before the retries race.
    await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    await store.failSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      failure: { kind: "generation_failed", retryable: true },
      updatedAt: now.toISOString(),
    });
    const fake = new FakeDiscussion(
      [],
      [{ type: "success", result: generatedSynthesis, delayMs: 100 }],
    );
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const first = runner.retrySynthesis(ownerSessionId, discussionId);
    // The first retry claimed the attempt and is generating; the second
    // retry observes the live attempt instead of starting a second one.
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.synthesisCalls).toHaveLength(1);
    const second = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(second?.synthesis?.status).toBe("generating");
    expect(fake.synthesisCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    const firstResult = await first;
    expect(firstResult?.synthesis?.status).toBe("completed");
    expect(fake.synthesisCalls).toHaveLength(1);
    const persisted = await store.readOwned(ownerSessionId, discussionId);
    expect(persisted?.synthesis?.status).toBe("completed");
  });

  it("keeps a non-retryable synthesis failure disallowed on retry", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    await store.failSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      failure: { kind: "timeout", retryable: false },
      updatedAt: now.toISOString(),
    });
    const fake = new FakeDiscussion([], []);
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      now: () => now,
    });

    const refused = await runner.retrySynthesis(ownerSessionId, discussionId);
    expect(refused?.synthesis?.status).toBe("failed");
    expect(failedSynthesis(refused)?.failure.kind).toBe("timeout");
    expect(fake.synthesisCalls).toHaveLength(0);
  });

  it("refuses the synthesis retry for a Discussion that is not completed", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 2 }));
    const runner = new DiscussionRunner({
      store,
      discussion: new FakeDiscussion([], []),
      now: () => now,
    });

    await expect(
      runner.retrySynthesis(ownerSessionId, discussionId),
    ).rejects.toThrow(DiscussionInvalidStateError);
  });

  it("returns null when retrying a synthesis the session does not own", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    const runner = new DiscussionRunner({
      store,
      discussion: new FakeDiscussion([], []),
      now: () => now,
    });

    const unowned = await runner.retrySynthesis(secondSessionId, discussionId);
    expect(unowned).toBeNull();
  });

  it("never creates a second committed synthesis across replays", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    // Completed already: the first claim observes an absent synthesis.
    const first = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    expect(first.kind).toBe("claimed");
    // A concurrent claim observes the live attempt instead of starting a second.
    const second = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdB,
      updatedAt: now.toISOString(),
    });
    expect(second.kind).toBe("in_progress");
    // A claim after a committed synthesis is already_present.
    await store.completeSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      content: synthesizedContent,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    });
    const afterCommit = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdB,
      updatedAt: now.toISOString(),
    });
    expect(afterCommit.kind).toBe("already_present");
  });

  it("rejects a late result from a replaced synthesis attempt as stale", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));

    const first = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    expect(first.kind).toBe("claimed");

    // The attempt fails transiently; a retry claims a fresh attempt.
    await store.failSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      failure: { kind: "generation_failed", retryable: true },
      updatedAt: now.toISOString(),
    });
    const retry = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdB,
      updatedAt: now.toISOString(),
    });
    expect(retry.kind).toBe("claimed");

    // The dead attempt's late completion is rejected as stale.
    const late = await store.completeSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      content: synthesizedContent,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    });
    expect(late.kind).toBe("stale");
    if (late.kind !== "stale") return;
    expect(late.discussion.synthesis?.attemptId).toBe(attemptIdB);

    // The live attempt commits exactly once.
    const committed = await store.completeSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdB,
      content: synthesizedContent,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
      updatedAt: now.toISOString(),
    });
    expect(committed.kind).toBe("updated");
  });

  it("refuses a synthesis claim after a non-retryable failure", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, completedState(discussionId, 2));
    await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    await store.failSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      failure: { kind: "timeout", retryable: false },
      updatedAt: now.toISOString(),
    });
    const refused = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdB,
      updatedAt: now.toISOString(),
    });
    expect(refused.kind).toBe("invalid_state");
  });

  it("refuses a synthesis claim on a Discussion that is not completed", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, {}));
    const refused = await store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId: attemptIdA,
      updatedAt: now.toISOString(),
    });
    expect(refused.kind).toBe("invalid_state");
  });

  it("records synthesis failure telemetry that validates against the strict schema", async () => {
    const store = new InMemoryDiscussionStore();
    await store.create(ownerSessionId, stateFor(discussionId, { turnLimit: 1 }));
    const fake = new FakeDiscussion(
      [{ type: "success", result: generatedTurn }],
      [
        {
          type: "failure",
          error: new DiscussionGenerationError(
            new Error("provider outage"),
            true,
          ),
        },
      ],
    );
    const telemetry = new CapturingTelemetry();
    const runner = new DiscussionRunner({
      store,
      discussion: fake,
      telemetry,
      now: () => now,
    });

    await runner.nextTurn(ownerSessionId, discussionId, requestId);
    // Every recorded synthesis event must parse against the strict
    // telemetry schema: the sink drops non-conforming records before
    // operators ever see them, so an invalid record is a silent outage
    // of the synthesis failure signal.
    const synthesisEvents = telemetry.events.filter(
      (event) =>
        event.event === "generation" && event.operation === "synthesis",
    );
    expect(synthesisEvents.length).toBeGreaterThan(0);
    for (const event of synthesisEvents) {
      expect(TelemetryEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe("Synthesis schema bounds and legacy compatibility", () => {
  it("rejects a structured field over the per-field ceiling", () => {
    const oversized = {
      ...synthesizedContent,
      takeaway: "x".repeat(1_201),
    };
    expect(
      DiscussionStateSchema.safeParse(
        completedWithSynthesis(oversized),
      ).success,
    ).toBe(false);
  });

  it("rejects an agreements array over the item ceiling", () => {
    const tooManyAgreements = {
      ...synthesizedContent,
      agreements: Array.from({ length: 5 }, (_, index) => `Agreement ${index}`),
    };
    expect(
      DiscussionStateSchema.safeParse(
        completedWithSynthesis(tooManyAgreements),
      ).success,
    ).toBe(false);
  });

  it("rejects content over the total-character ceiling", () => {
    const overTotal = {
      strongestSupport: "a".repeat(1_200),
      strongestOpposition: "b".repeat(1_200),
      agreements: ["c".repeat(1_200)],
      unresolved: "d".repeat(1_200),
      claimsToVerify: ["e".repeat(1_200)],
      takeaway: "f".repeat(1_200),
    };
    // 6 × 1200 > 6000 total ceiling.
    expect(
      DiscussionStateSchema.safeParse(completedWithSynthesis(overTotal)).success,
    ).toBe(false);
  });

  it("parses a legacy completed Discussion without a synthesis field", () => {
    const legacy = stateFor(discussionId, {
      status: "completed",
      turnLimit: 2,
      turnCount: 2,
      transcript: [message(1), message(2)],
    });
    expect(DiscussionStateSchema.parse(legacy).synthesis).toBeUndefined();
  });

  it("rejects a synthesis on a Discussion that is not completed", () => {
    const invalid = {
      ...stateFor(discussionId, { status: "idle" }),
      synthesis: {
        status: "generating",
        requestId: SYNTHESIS_REQUEST_ID,
        attemptId: attemptIdA,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    };
    expect(DiscussionStateSchema.safeParse(invalid).success).toBe(false);
  });
});
