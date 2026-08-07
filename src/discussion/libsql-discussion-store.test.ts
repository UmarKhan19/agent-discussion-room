import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  HARD_GENERATION_TIMEOUT_MS,
  RECOVERY_LEASE_GRACE_MS,
} from "./budgets";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  type DiscussionMessage,
  type DiscussionState,
} from "./contracts";
import { LibSQLDiscussionStore } from "./libsql-discussion-store";

const now = new Date("2026-08-02T12:00:00.000Z");
const ownerSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const discussionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const secondRequestId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const secondAttemptId = "66666666-6666-4666-8666-666666666666";

/**
 * Lease derived from a 60 s store generation timeout plus the fixed
 * recovery grace margin; clocks must advance past the whole lease before
 * an attempt becomes recoverable.
 */
const leaseMs = 60_000 + RECOVERY_LEASE_GRACE_MS;

/** Deterministic clock that can be advanced past a lease duration. */
function mutableClock(start: Date): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function idleState(turnLimit = 12): DiscussionState {
  return DiscussionStateSchema.parse({
    id: discussionId,
    topic: "Should cities create more public parks?",
    status: "idle",
    terminalReason: null,
    turnLimit,
    turnCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    policyOutcome: { decision: "allowed", category: null, checkedAt: now.toISOString() },
    transcript: [],
  });
}

function message(turn: number, generationRequestId = requestId): DiscussionMessage {
  return DiscussionMessageSchema.parse({
    id: `33333333-3333-4333-8333-${String(turn).padStart(12, "0")}`,
    content: `Persisted message for Turn ${turn}`,
    speaker: turn % 2 === 1 ? "supporter" : "opponent",
    createdAt: now.toISOString(),
    turn,
    generation: {
      requestId: generationRequestId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
    },
  });
}

describe("LibSQLDiscussionStore", () => {
  const directories: string[] = [];

  function storeUrl(): string {
    const directory = mkdtempSync(join(tmpdir(), "discussion-store-"));
    directories.push(directory);
    return `file:${join(directory, "discussions.db")}`;
  }

  function createStore(url: string): LibSQLDiscussionStore {
    return new LibSQLDiscussionStore({
      url,
      now: () => now,
      generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
    });
  }

  function createLeasedStore(
    url: string,
    options: {
      clock: { now: () => Date };
      generationTimeoutMs: number;
      leaseOwnerId?: string;
    },
  ): LibSQLDiscussionStore {
    return new LibSQLDiscussionStore({
      url,
      now: options.clock.now,
      generationTimeoutMs: options.generationTimeoutMs,
      ...(options.leaseOwnerId === undefined
        ? {}
        : { leaseOwnerId: options.leaseOwnerId }),
    });
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips a created Discussion with runtime validation", async () => {
    const url = storeUrl();
    const store = createStore(url);
    await store.init();
    await store.create(ownerSessionId, idleState());

    const read = await store.readOwned(ownerSessionId, discussionId);
    expect(read).toEqual(idleState());
    expect(DiscussionStateSchema.parse(read)).toEqual(idleState());
    store.close();
  });

  it("enforces ownership on reads", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());

    expect(await store.readOwned(otherSessionId, discussionId)).toBeNull();
    store.close();
  });

  it("claims a Turn and blocks duplicate or overlapping requests", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());

    const claimed = await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") return;
    expect(claimed.turn).toBe(1);
    expect(claimed.discussion).toMatchObject({ status: "generating", turnCount: 0 });

    expect(
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      }),
    ).toEqual({ kind: "request_in_progress" });

    expect(
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId,
        updatedAt: now.toISOString(),
      }),
    ).toEqual({ kind: "turn_in_progress" });
    store.close();
  });

  it("replays a succeeded request identity instead of duplicating a Turn", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    await store.completeTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      message: message(1),
      updatedAt: now.toISOString(),
    });

    const replay = await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId: "77777777-7777-4777-8777-777777777777",
      updatedAt: now.toISOString(),
    });
    expect(replay).toMatchObject({ kind: "replay" });
    expect(await store.requestStatus(ownerSessionId, discussionId, requestId)).toEqual({
      kind: "succeeded",
    });
    store.close();
  });

  it("allows a retry of a retryable failure and reports non-retryable failures", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    await store.failTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      failure: { kind: "generation_failed", retryable: true },
      updatedAt: now.toISOString(),
    });

    expect(await store.requestStatus(ownerSessionId, discussionId, requestId)).toEqual({
      kind: "failed",
      retryable: true,
    });

    const retried = await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    expect(retried.kind).toBe("claimed");
    if (retried.kind !== "claimed") return;
    expect(retried.turn).toBe(1);
    store.close();
  });

  it("refuses to advance a non-retryable failed request", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    await store.failTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      failure: { kind: "output_blocked", retryable: false, category: "extremist_praise" },
      updatedAt: now.toISOString(),
    });

    expect(
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      }),
    ).toMatchObject({ kind: "failed", failure: { kind: "output_blocked" } });
    store.close();
  });

  it("rejects stale attempt mutations after the attempt lost the race", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });

    const stale = await store.completeTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId: "77777777-7777-4777-8777-777777777777",
      expectedTurn: 1,
      message: message(1),
      updatedAt: now.toISOString(),
    });
    expect(stale.kind).toBe("stale");

    const current = await store.completeTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      message: message(1),
      updatedAt: now.toISOString(),
    });
    expect(current.kind).toBe("updated");
    store.close();
  });

  it("persists the terminal state of a stopped Discussion and stays idempotent", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());
    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });

    const stopped = await store.stopOwned(ownerSessionId, discussionId, now.toISOString());
    expect(stopped).toMatchObject({ kind: "stopped" });
    if (stopped.kind !== "stopped") return;
    expect(stopped.discussion).toMatchObject({
      status: "stopped",
      terminalReason: "stop",
      turnCount: 0,
    });

    const repeated = await store.stopOwned(ownerSessionId, discussionId, now.toISOString());
    expect(repeated.kind).toBe("stopped");
    expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
      status: "stopped",
    });
    store.close();
  });

  it("persists cancellation terminal states for disconnect and timeout", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());

    await store.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    await store.cancelTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      reason: "disconnect",
      updatedAt: now.toISOString(),
    });
    expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
      status: "stopped",
      terminalReason: "disconnect",
    });
    store.close();

    const secondStore = createStore(storeUrl());
    await secondStore.create(ownerSessionId, idleState());
    await secondStore.claimTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    await secondStore.cancelTurn({
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      expectedTurn: 1,
      reason: "timeout",
      updatedAt: now.toISOString(),
    });
    expect(await secondStore.readOwned(ownerSessionId, discussionId)).toMatchObject({
      status: "failed",
      terminalReason: "timeout",
    });
    secondStore.close();
  });

  it("allows only one concurrent claim on the same Discussion", async () => {
    const store = createStore(storeUrl());
    await store.create(ownerSessionId, idleState());

    const outcomes = await Promise.all([
      store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      }),
      store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId,
        updatedAt: now.toISOString(),
      }),
    ]);

    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    expect(kinds).toEqual(["claimed", "turn_in_progress"]);
    store.close();
  });

  describe("restart durability", () => {
    it("preserves readable state, ordered Messages, and request outcomes", async () => {
      const url = storeUrl();
      const firstStore = createStore(url);
      await firstStore.init();
      await firstStore.create(ownerSessionId, idleState(2));
      await firstStore.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      await firstStore.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: now.toISOString(),
      });
      firstStore.close();

      const secondStore = createStore(url);
      const read = await secondStore.readOwned(ownerSessionId, discussionId);
      expect(read).toMatchObject({
        status: "idle",
        turnCount: 1,
        topic: "Should cities create more public parks?",
      });
      expect(read?.transcript).toHaveLength(1);
      expect(read?.transcript[0]).toEqual(message(1));
      expect(await secondStore.requestStatus(ownerSessionId, discussionId, requestId)).toEqual({
        kind: "succeeded",
      });

      const next = await secondStore.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      expect(next.kind).toBe("claimed");
      if (next.kind !== "claimed") return;
      expect(next.turn).toBe(2);
      expect(next.discussion.transcript).toHaveLength(1);
      secondStore.close();
    });

    it("keeps ownership enforced after a restart", async () => {
      const url = storeUrl();
      const firstStore = createStore(url);
      await firstStore.create(ownerSessionId, idleState());
      firstStore.close();

      const secondStore = createStore(url);
      expect(await secondStore.readOwned(otherSessionId, discussionId)).toBeNull();
      expect(
        await secondStore.claimTurn({
          ownerSessionId: otherSessionId,
          discussionId,
          requestId,
          attemptId,
          updatedAt: now.toISOString(),
        }),
      ).toEqual({ kind: "not_found" });
      secondStore.close();
    });
  });

  describe("interrupted-generation recovery", () => {
    it("reconciles a generating Discussion into a retryable failed state", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const firstStore = createLeasedStore(url, {
        clock,
        generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
        leaseOwnerId: "instance-a",
      });
      await firstStore.create(ownerSessionId, idleState());
      await firstStore.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      // Simulated crash: the process exits while the Turn is generating.
      firstStore.close();
      // The abandoned attempt is recoverable only after its lease expires.
      clock.advance(
        DEFAULT_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS + 1,
      );

      const secondStore = createLeasedStore(url, {
        clock,
        generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
        leaseOwnerId: "instance-b",
      });
      expect(await secondStore.recoverInterrupted()).toBe(1);

      const recovered = await secondStore.readOwned(ownerSessionId, discussionId);
      expect(recovered).toMatchObject({
        status: "failed",
        terminalReason: null,
        turnCount: 0,
      });
      expect(
        await secondStore.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });

      const retried = await secondStore.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(retried.kind).toBe("claimed");
      if (retried.kind !== "claimed") return;
      expect(retried.turn).toBe(1);

      await secondStore.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect((await secondStore.readOwned(ownerSessionId, discussionId))?.transcript).toHaveLength(1);
      secondStore.close();
    });

    it("is a no-op when no Discussion was interrupted", async () => {
      const store = createStore(storeUrl());
      await store.create(ownerSessionId, idleState());
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      await store.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: now.toISOString(),
      });

      expect(await store.recoverInterrupted()).toBe(0);
      expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "idle",
        turnCount: 1,
      });
      store.close();
    });
  });

  describe("lease-protected generation recovery", () => {
    it("never recovers a healthy in-flight generation owned by another instance", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());

      // Instance A claims the Turn and starts generating.
      const claim = await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(claim.kind).toBe("claimed");

      // Instance B starts while A is still generating and runs recovery.
      expect(await storeB.recoverInterrupted()).toBe(0);

      // A's provider returns and the Turn completes normally.
      const completed = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(completed.kind).toBe("updated");
      expect(await storeB.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "idle",
        turnCount: 1,
      });
      expect(
        (await storeB.readOwned(ownerSessionId, discussionId))?.transcript,
      ).toHaveLength(1);
      storeA.close();
      storeB.close();
    });

    it("keeps conflicts against a live attempt even after another instance recovers", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });

      // B's recovery must not touch the live attempt...
      expect(await storeB.recoverInterrupted()).toBe(0);
      // ...and normal conflict semantics stay intact.
      expect(
        await storeB.claimTurn({
          ownerSessionId,
          discussionId,
          requestId,
          attemptId: secondAttemptId,
          updatedAt: clock.now().toISOString(),
        }),
      ).toEqual({ kind: "request_in_progress" });
      expect(
        await storeB.claimTurn({
          ownerSessionId,
          discussionId,
          requestId: secondRequestId,
          attemptId: secondAttemptId,
          updatedAt: clock.now().toISOString(),
        }),
      ).toEqual({ kind: "turn_in_progress" });
      storeA.close();
      storeB.close();
    });

    it("recovers an expired attempt lazily when the same identity retries", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // No recovery pass runs: the retry itself reclaims the same Turn.
      const retried = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(retried.kind).toBe("claimed");
      if (retried.kind !== "claimed") return;
      expect(retried.turn).toBe(1);

      await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final?.transcript).toHaveLength(1);
      expect(
        await storeB.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "succeeded" });

      // The original owner's late completion is stale.
      const stale = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(stale.kind).toBe("stale");
      storeA.close();
      storeB.close();
    });

    it("lets a fresh request identity reclaim an abandoned Turn without skipping it", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      const claimed = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") return;
      // Same Turn: the abandoned attempt never committed, so nothing is
      // skipped and the Turn is not duplicated.
      expect(claimed.turn).toBe(1);

      await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1, secondRequestId),
        updatedAt: clock.now().toISOString(),
      });
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.turn).toBe(1);
      storeA.close();
      storeB.close();
    });

    it("reports an expired attempt as a retryable failure through requestStatus", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(
        await storeB.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "generating" });
      clock.advance(leaseMs + 1);
      expect(
        await storeB.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });
      storeA.close();
      storeB.close();
    });

    it("concurrent recovery of one expired attempt settles in one deterministic state", async () => {
      const url = storeUrl();      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      const storeC = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-c",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // Two instances run startup recovery at the same time. On a local
      // file the second writer may surface the driver's SQLITE_BUSY
      // instead of a clean no-op (remote libSQL serializes writers
      // server-side); whatever the outcome, exactly one recovery mutates
      // the database and the final state is deterministic.
      const [first, second] = await Promise.allSettled([
        storeB.recoverInterrupted(),
        storeC.recoverInterrupted(),
      ]);
      const recoveredCounts = [first, second]
        .filter((result) => result.status === "fulfilled")
        .map((result) => (result as PromiseFulfilledResult<number>).value);
      expect(recoveredCounts.length).toBeGreaterThan(0);
      expect(recoveredCounts.reduce((sum, value) => sum + value, 0)).toBe(1);

      const recovered = await storeB.readOwned(ownerSessionId, discussionId);
      expect(recovered).toMatchObject({
        status: "failed",
        terminalReason: null,
        turnCount: 0,
        transcript: [],
      });
      expect(
        await storeB.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });
      storeA.close();
      storeB.close();
      storeC.close();
    }, 15_000);

    it("a completion that commits before recovery keeps its Message", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // The original attempt completes (its provider result arrived just
      // after the lease expired but before any recovery ran).
      const completed = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(completed.kind).toBe("updated");

      // The later recovery is a no-op and cannot un-commit the Message.
      expect(await storeB.recoverInterrupted()).toBe(0);
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final).toMatchObject({ status: "idle", turnCount: 1 });
      expect(final?.transcript).toHaveLength(1);
      storeA.close();
      storeB.close();
    });

    it("a recovery that wins makes the original completion stale", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      expect(await storeB.recoverInterrupted()).toBe(1);

      // The late provider result is rejected as stale and commits nothing.
      const stale = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(stale.kind).toBe("stale");
      expect(
        (await storeA.readOwned(ownerSessionId, discussionId))?.transcript,
      ).toHaveLength(0);

      // The participant retries with the same identity: exactly one Message.
      const retried = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(retried.kind).toBe("claimed");
      if (retried.kind !== "claimed") return;
      expect(retried.turn).toBe(1);
      await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final?.transcript).toHaveLength(1);
      storeA.close();
      storeB.close();
    });

    it("never recovers a deliberately stopped Discussion", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const store = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      await store.create(ownerSessionId, idleState());
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      const stopped = await store.stopOwned(
        ownerSessionId,
        discussionId,
        clock.now().toISOString(),
      );
      expect(stopped.kind).toBe("stopped");
      clock.advance(leaseMs + 1);

      expect(await store.recoverInterrupted()).toBe(0);
      expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "stopped",
        terminalReason: "stop",
      });
      store.close();
    });

    it("never recovers a timeout-failed Discussion as retryable", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const store = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      await store.create(ownerSessionId, idleState());
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      await store.cancelTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        reason: "timeout",
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      expect(await store.recoverInterrupted()).toBe(0);
      expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "failed",
        terminalReason: "timeout",
      });
      expect(
        await store.claimTurn({
          ownerSessionId,
          discussionId,
          requestId,
          attemptId: secondAttemptId,
          updatedAt: clock.now().toISOString(),
        }),
      ).toMatchObject({
        kind: "failed",
        failure: { kind: "timeout", retryable: false },
      });
      store.close();
    });

    it("migrates a legacy database and recovers legacy generating rows", async () => {
      const url = storeUrl();
      // A database created before recovery leasing existed: no lease columns.
      const legacy = createClient({ url });
      await legacy.executeMultiple(`
CREATE TABLE discussion (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX discussion_owner_session ON discussion (owner_session_id);
CREATE TABLE discussion_request (
  discussion_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'succeeded', 'failed')),
  failure TEXT,
  PRIMARY KEY (discussion_id, request_id)
);
CREATE INDEX discussion_request_status ON discussion_request (discussion_id, status);
`);
      const interrupted: DiscussionState = DiscussionStateSchema.parse({
        ...idleState(),
        status: "generating",
      });
      await legacy.execute({
        sql: "INSERT INTO discussion (id, owner_session_id, state, updated_at) VALUES (?, ?, ?, ?)",
        args: [
          discussionId,
          ownerSessionId,
          JSON.stringify(interrupted),
          interrupted.updatedAt,
        ],
      });
      await legacy.execute({
        sql: "INSERT INTO discussion_request (discussion_id, request_id, turn, attempt_id, status) VALUES (?, ?, ?, ?, 'generating')",
        args: [discussionId, requestId, 1, attemptId],
      });
      legacy.close();

      // The upgraded store adds the lease columns and treats the legacy row
      // (no lease) as abandoned.
      const store = createStore(url);
      expect(await store.recoverInterrupted()).toBe(1);
      expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "failed",
        terminalReason: null,
      });
      expect(
        await store.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });

      const retried = await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      expect(retried.kind).toBe("claimed");
      if (retried.kind !== "claimed") return;
      expect(retried.turn).toBe(1);
      store.close();
    });
  });

  describe("multi-instance lease safety", () => {
    it("exactly one instance reclaims an expired Turn across separate connections", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      const storeC = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-c",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // Two genuinely separate connections (separate store objects, so
      // separate in-process write queues) race to reclaim the same expired
      // Turn with different request identities. On a local file the losing
      // writer can surface the driver's SQLITE_BUSY instead of a clean
      // conflict; remote libSQL serializes writers server-side.
      const thirdRequestId = "88888888-8888-4888-8888-888888888888";
      const thirdAttemptId = "99999999-9999-4999-8999-999999999999";
      const settled = await Promise.allSettled([
        storeB.claimTurn({
          ownerSessionId,
          discussionId,
          requestId: secondRequestId,
          attemptId: secondAttemptId,
          updatedAt: clock.now().toISOString(),
        }),
        storeC.claimTurn({
          ownerSessionId,
          discussionId,
          requestId: thirdRequestId,
          attemptId: thirdAttemptId,
          updatedAt: clock.now().toISOString(),
        }),
      ]);
      const contenders: Array<{
        requestId: string;
        attemptId: string;
        result: PromiseSettledResult<Awaited<ReturnType<LibSQLDiscussionStore["claimTurn"]>>>;
      }> = [
        { requestId: secondRequestId, attemptId: secondAttemptId, result: settled[0]! },
        { requestId: thirdRequestId, attemptId: thirdAttemptId, result: settled[1]! },
      ];

      const winners = contenders.filter(
        (contender) =>
          contender.result.status === "fulfilled" &&
          contender.result.value.kind === "claimed",
      );
      expect(winners).toHaveLength(1);
      for (const contender of contenders) {
        if (contender.result.status !== "fulfilled") continue;
        if (contender.result.value.kind === "claimed") continue;
        // The loser observes the winner's fresh lease as an in-progress
        // Turn; it must never see a claim.
        expect(contender.result.value.kind).toBe("turn_in_progress");
      }

      const winner = winners[0]!;
      expect(winner).toBeDefined();
      const winnerClaim = winner.result.status === "fulfilled" ? winner.result.value : null;
      if (winnerClaim === null || winnerClaim.kind !== "claimed") {
        throw new Error("expected a claimed winner");
      }

      // The winner completes: exactly one Message, Turn advances once, and
      // no duplicate or skipped Turn is possible.
      const completed = await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId: winner.requestId,
        attemptId: winner.attemptId,
        expectedTurn: winnerClaim.turn,
        message: message(1, winner.requestId),
        updatedAt: clock.now().toISOString(),
      });
      expect(completed.kind).toBe("updated");
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final).toMatchObject({ status: "idle", turnCount: 1 });
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.generation.requestId).toBe(
        winner.requestId,
      );
      expect(
        await storeB.requestStatus(ownerSessionId, discussionId, winner.requestId),
      ).toEqual({ kind: "succeeded" });
      storeA.close();
      storeB.close();
      storeC.close();
    }, 15_000);

    it("blocks the original identity from superseding a fresh-identity owner", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // Request B (fresh identity) reclaims the abandoned Turn.
      const claimedB = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(claimedB.kind).toBe("claimed");

      // A retries while B is generating: conflict, and A cannot supersede B.
      const retriedA = await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: "77777777-7777-4777-8777-777777777777",
        updatedAt: clock.now().toISOString(),
      });
      expect(retriedA.kind).toBe("turn_in_progress");

      // A's late provider result (its old attempt) is stale and commits
      // nothing.
      const staleA = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(staleA.kind).toBe("stale");

      // B completes: exactly one Message, from B.
      const doneB = await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1, secondRequestId),
        updatedAt: clock.now().toISOString(),
      });
      expect(doneB.kind).toBe("updated");
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.generation.requestId).toBe(secondRequestId);
      storeA.close();
      storeB.close();
    });

    it("stops the original identity from regenerating a Turn a fresh identity completed", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // B reclaims and completes the abandoned Turn.
      await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      const doneB = await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1, secondRequestId),
        updatedAt: clock.now().toISOString(),
      });
      expect(doneB.kind).toBe("updated");

      // A retries afterward: it neither replays B's result as its own nor
      // regenerates Turn 1 — the Turn already advanced under B's identity.
      const retriedA = await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: "77777777-7777-4777-8777-777777777777",
        updatedAt: clock.now().toISOString(),
      });
      expect(retriedA.kind).toBe("invalid_state");
      expect(
        await storeA.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });

      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final).toMatchObject({ status: "idle", turnCount: 1 });
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.generation.requestId).toBe(secondRequestId);
      storeA.close();
      storeB.close();
    });

    it("lets the original identity retry first and keeps exclusive ownership", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // A retries first and reclaims its own abandoned Turn...
      const claimedA = await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: "77777777-7777-4777-8777-777777777777",
        updatedAt: clock.now().toISOString(),
      });
      expect(claimedA.kind).toBe("claimed");
      if (claimedA.kind !== "claimed") return;
      expect(claimedA.turn).toBe(1);

      // ...so B, arriving later, can only observe A's fresh lease.
      const conflictB = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(conflictB.kind).toBe("turn_in_progress");

      await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: "77777777-7777-4777-8777-777777777777",
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      const final = await storeA.readOwned(ownerSessionId, discussionId);
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.generation.requestId).toBe(requestId);
      storeA.close();
      storeB.close();
    });

    it("rejects a stale completion from the original identity after a fresh-identity reclaim", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // Fresh request identity B reclaims the same Turn.
      const claimedB = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(claimedB.kind).toBe("claimed");
      if (claimedB.kind !== "claimed") return;
      expect(claimedB.turn).toBe(1);

      // The old provider result from A arrives late: A's completion is
      // stale and never appends a Message.
      const staleA = await storeA.completeTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        expectedTurn: 1,
        message: message(1),
        updatedAt: clock.now().toISOString(),
      });
      expect(staleA.kind).toBe("stale");
      expect(
        (await storeA.readOwned(ownerSessionId, discussionId))?.transcript,
      ).toHaveLength(0);

      // B completes: exactly one Message, and the Turn count advances
      // exactly once.
      const doneB = await storeB.completeTurn({
        ownerSessionId,
        discussionId,
        requestId: secondRequestId,
        attemptId: secondAttemptId,
        expectedTurn: 1,
        message: message(1, secondRequestId),
        updatedAt: clock.now().toISOString(),
      });
      expect(doneB.kind).toBe("updated");
      const final = await storeB.readOwned(ownerSessionId, discussionId);
      expect(final).toMatchObject({ status: "idle", turnCount: 1 });
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]).toMatchObject({
        turn: 1,
        generation: { requestId: secondRequestId },
      });
      storeA.close();
      storeB.close();
    });

    it("completion and recovery racing across connections settle in one consistent state", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);

      // The owner's completion and another instance's startup recovery
      // contend from separate connections. Both orderings are valid; the
      // final state must be exactly one of them, never a mix.
      const [completion, recovery] = await Promise.allSettled([
        storeA.completeTurn({
          ownerSessionId,
          discussionId,
          requestId,
          attemptId,
          expectedTurn: 1,
          message: message(1),
          updatedAt: clock.now().toISOString(),
        }),
        storeB.recoverInterrupted(),
      ]);
      const completed =
        completion.status === "fulfilled" ? completion.value : null;
      const recoveredCount =
        recovery.status === "fulfilled" ? recovery.value : null;
      // On a local file one writer may surface the driver's SQLITE_BUSY;
      // at least one side must win the race.
      expect(completed !== null || recoveredCount !== null).toBe(true);

      const final = await storeB.readOwned(ownerSessionId, discussionId);
      if (completed?.kind === "updated") {
        // Completion won: exactly one Message committed, recovery was a
        // no-op (or the losing writer surfaced SQLITE_BUSY).
        expect(final).toMatchObject({ status: "idle", turnCount: 1 });
        expect(final?.transcript).toHaveLength(1);
        if (recoveredCount !== null) expect(recoveredCount).toBe(0);
      } else {
        // Recovery won: the old completion is stale and committed nothing.
        expect(final).toMatchObject({
          status: "failed",
          terminalReason: null,
          turnCount: 0,
        });
        expect(final?.transcript).toHaveLength(0);
        if (recoveredCount !== null) expect(recoveredCount).toBe(1);
        if (completed !== null) expect(completed.kind).toBe("stale");
      }
      storeA.close();
      storeB.close();
    }, 15_000);

    it("surfaces a degraded but consistent Stop when another instance recovered the owner's attempt", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const storeA = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-a",
      });
      const storeB = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
        leaseOwnerId: "instance-b",
      });
      await storeA.create(ownerSessionId, idleState());
      await storeA.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: clock.now().toISOString(),
      });
      clock.advance(leaseMs + 1);
      expect(await storeB.recoverInterrupted()).toBe(1);

      // The dead owner's Stop can no longer be persisted: its attempt is
      // no longer the current one. The error code is degraded (the owner
      // effectively no longer owns any work), but state stays consistent
      // and the participant can still resume.
      const stopped = await storeA.stopOwned(
        ownerSessionId,
        discussionId,
        clock.now().toISOString(),
      );
      expect(stopped.kind).toBe("invalid_state");
      expect(await storeB.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "failed",
        terminalReason: null,
      });
      const retried = await storeB.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: secondAttemptId,
        updatedAt: clock.now().toISOString(),
      });
      expect(retried.kind).toBe("claimed");
      storeA.close();
      storeB.close();
    });
  });

  describe("lease configuration invariant", () => {
    it("writes the derived lease expiry on every claim", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const store = createLeasedStore(url, {
        clock,
        generationTimeoutMs: 60_000,
      });
      await store.create(ownerSessionId, idleState());
      const claimedAt = clock.now();
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: claimedAt.toISOString(),
      });

      // The persisted expiry is the derived duration: timeout + grace.
      const raw = createClient({ url });
      const rows = await raw.execute({
        sql: "SELECT lease_expires_at FROM discussion_request WHERE discussion_id = ? AND request_id = ?",
        args: [discussionId, requestId],
      });
      const expiresAt = String(rows.rows[0]?.lease_expires_at ?? "");
      expect(expiresAt).not.toBe("");
      expect(new Date(expiresAt).getTime() - claimedAt.getTime()).toBe(
        60_000 + RECOVERY_LEASE_GRACE_MS,
      );
      raw.close();
      store.close();
    });

    it("tracks the maximum allowed generation timeout with a strictly longer lease", async () => {
      const url = storeUrl();
      const clock = mutableClock(now);
      const store = createLeasedStore(url, {
        clock,
        generationTimeoutMs: HARD_GENERATION_TIMEOUT_MS,
      });
      await store.create(ownerSessionId, idleState());
      const claimedAt = clock.now();
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: claimedAt.toISOString(),
      });

      const raw = createClient({ url });
      const rows = await raw.execute({
        sql: "SELECT lease_expires_at FROM discussion_request WHERE discussion_id = ? AND request_id = ?",
        args: [discussionId, requestId],
      });
      const expiresAt = String(rows.rows[0]?.lease_expires_at ?? "");
      expect(new Date(expiresAt).getTime() - claimedAt.getTime()).toBe(
        HARD_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS,
      );
      raw.close();
      store.close();
    });

    it("rejects a generation timeout that could not outlive a legitimate generation", async () => {
      const url = storeUrl();
      for (const invalid of [0, -1, 1.5, HARD_GENERATION_TIMEOUT_MS + 1]) {
        expect(
          () => new LibSQLDiscussionStore({ url, generationTimeoutMs: invalid }),
        ).toThrow(/generationTimeoutMs/);
      }
    });
  });

  describe("migration robustness", () => {
    it("re-initializes an already migrated database idempotently", async () => {
      const url = storeUrl();
      const store = createStore(url);
      await store.init();
      await store.create(ownerSessionId, idleState());
      await store.init();
      await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      expect(await store.recoverInterrupted()).toBe(0);
      store.close();
    });

    it("completes the migration of a database with only one lease column", async () => {
      const url = storeUrl();
      // A database whose upgrade was interrupted halfway: only
      // lease_owner_id exists, and a generating row already carries an
      // owner but no expiry (a mixed-version write).
      const legacy = createClient({ url });
      await legacy.executeMultiple(`
CREATE TABLE discussion (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX discussion_owner_session ON discussion (owner_session_id);
CREATE TABLE discussion_request (
  discussion_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'succeeded', 'failed')),
  failure TEXT,
  PRIMARY KEY (discussion_id, request_id)
);
CREATE INDEX discussion_request_status ON discussion_request (discussion_id, status);
`);
      await legacy.execute(
        "ALTER TABLE discussion_request ADD COLUMN lease_owner_id TEXT",
      );
      const interrupted: DiscussionState = DiscussionStateSchema.parse({
        ...idleState(),
        status: "generating",
      });
      await legacy.execute({
        sql: "INSERT INTO discussion (id, owner_session_id, state, updated_at) VALUES (?, ?, ?, ?)",
        args: [
          discussionId,
          ownerSessionId,
          JSON.stringify(interrupted),
          interrupted.updatedAt,
        ],
      });
      await legacy.execute({
        sql: "INSERT INTO discussion_request (discussion_id, request_id, turn, attempt_id, status, lease_owner_id) VALUES (?, ?, ?, ?, 'generating', ?)",
        args: [discussionId, requestId, 1, attemptId, "instance-a"],
      });
      legacy.close();

      // The upgraded store adds the missing expiry column; the row's null
      // expiry is treated as expired, exactly like a legacy row.
      const store = createStore(url);
      expect(await store.recoverInterrupted()).toBe(1);
      expect(await store.readOwned(ownerSessionId, discussionId)).toMatchObject({
        status: "failed",
        terminalReason: null,
      });
      expect(
        await store.requestStatus(ownerSessionId, discussionId, requestId),
      ).toEqual({ kind: "failed", retryable: true });
      store.close();
    });

    it("initializes concurrently from two instances against one database", async () => {
      const url = storeUrl();
      const storeB = createStore(url);
      const storeC = createStore(url);
      const results = await Promise.allSettled([storeB.init(), storeC.init()]);
      // Remote libSQL serializes schema writers server-side; on a local
      // file one writer can surface the driver's SQLITE_BUSY. Whatever the
      // outcome, every instance whose initialization completed can operate
      // on the shared schema.
      expect(
        results.some((result) => result.status === "fulfilled"),
      ).toBe(true);
      const working = [storeB, storeC].filter(
        (_store, index) => results[index]?.status === "fulfilled",
      );
      const store = working[0]!;
      await store.create(ownerSessionId, idleState());
      const claim = await store.claimTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId,
        updatedAt: now.toISOString(),
      });
      expect(claim.kind).toBe("claimed");
      storeB.close();
      storeC.close();
    }, 15_000);
  });
});
