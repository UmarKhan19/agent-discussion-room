import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function message(turn: number): DiscussionMessage {
  return DiscussionMessageSchema.parse({
    id: `33333333-3333-4333-8333-${String(turn).padStart(12, "0")}`,
    content: `Persisted message for Turn ${turn}`,
    speaker: turn % 2 === 1 ? "supporter" : "opponent",
    createdAt: now.toISOString(),
    turn,
    generation: {
      requestId,
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
    return new LibSQLDiscussionStore({ url, now: () => now });
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
      const firstStore = createStore(url);
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

      const secondStore = createStore(url);
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
        updatedAt: now.toISOString(),
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
        updatedAt: now.toISOString(),
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
});
