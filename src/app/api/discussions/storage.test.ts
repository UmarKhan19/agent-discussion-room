import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  RECOVERY_LEASE_GRACE_MS,
  type DiscussionBudgets,
} from "@/discussion/budgets";
import {
  DiscussionStateSchema,
  ErrorResponseSchema,
  type DiscussionState,
} from "@/discussion/contracts";
import {
  DiscussionService,
  DiscussionStorageUnavailableError,
  type DiscussionStore,
} from "@/discussion/discussion-service";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import { LibSQLDiscussionStore } from "@/discussion/libsql-discussion-store";
import { DiscussionOutputPolicy, DiscussionPolicy } from "@/discussion/policy";
import {
  FakeDiscussion,
  type FakeDiscussionOutcome,
} from "@/discussion/testing/fake-discussion";
import { SignedSessionManager } from "@/discussion/signed-session";
import { createDiscussionHttpHandlers } from "./handler";

const now = new Date("2026-08-02T12:00:00.000Z");
const signingKey = "test-signing-key-that-is-at-least-32-characters";
const requestId = "22222222-2222-4222-8222-222222222222";
const secondRequestId = "33333333-3333-4333-8333-333333333333";
const attemptId = "55555555-5555-4555-8555-555555555555";

const generatedTurn = {
  content: "Public parks give more residents access to shared green space.",
  usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
};

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

function jsonRequest(
  body: unknown,
  cookie?: string,
  url = "http://localhost/api/discussions",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

const leaseMs = DEFAULT_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS;

interface Harness {
  store: LibSQLDiscussionStore;
  fault: FaultStore;
  fake: FakeDiscussion;
  handlers: ReturnType<typeof createDiscussionHttpHandlers>;
  ready: Promise<void>;
  sessions: SignedSessionManager;
  clock: ReturnType<typeof mutableClock>;
  close: () => void;
}

/**
 * Wraps the real durable store and injects faults at the storage boundary.
 * A faulted method throws `DiscussionStorageUnavailableError`, exactly as
 * `LibSQLDiscussionStore`'s `guardStorage` wraps a real outage. Non-faulted
 * methods delegate to the real store, so leases, ownership, and recovery
 * semantics are real — only the chosen method is short-circuited.
 */
class FaultStore implements DiscussionStore {
  readonly faults: Set<keyof DiscussionStore>;

  constructor(readonly inner: DiscussionStore) {
    this.faults = new Set();
  }

  create(ownerSessionId: string, discussion: DiscussionState): Promise<void> {
    this.assertFault("create");
    return this.inner.create(ownerSessionId, discussion);
  }
  readOwned(ownerSessionId: string, discussionId: string): Promise<DiscussionState | null> {
    this.assertFault("readOwned");
    return this.inner.readOwned(ownerSessionId, discussionId);
  }
  requestStatus(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): ReturnType<DiscussionStore["requestStatus"]> {
    this.assertFault("requestStatus");
    return this.inner.requestStatus(ownerSessionId, discussionId, requestId);
  }
  claimTurn(input: Parameters<DiscussionStore["claimTurn"]>[0]): ReturnType<DiscussionStore["claimTurn"]> {
    this.assertFault("claimTurn");
    return this.inner.claimTurn(input);
  }
  completeTurn(input: Parameters<DiscussionStore["completeTurn"]>[0]): ReturnType<DiscussionStore["completeTurn"]> {
    this.assertFault("completeTurn");
    return this.inner.completeTurn(input);
  }
  failTurn(input: Parameters<DiscussionStore["failTurn"]>[0]): ReturnType<DiscussionStore["failTurn"]> {
    this.assertFault("failTurn");
    return this.inner.failTurn(input);
  }
  cancelTurn(input: Parameters<DiscussionStore["cancelTurn"]>[0]): ReturnType<DiscussionStore["cancelTurn"]> {
    this.assertFault("cancelTurn");
    return this.inner.cancelTurn(input);
  }
  stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): ReturnType<DiscussionStore["stopOwned"]> {
    this.assertFault("stopOwned");
    return this.inner.stopOwned(ownerSessionId, discussionId, updatedAt);
  }

  private assertFault(method: keyof DiscussionStore): void {
    if (this.faults.has(method)) {
      throw new DiscussionStorageUnavailableError(
        new Error("simulated storage outage"),
      );
    }
  }
}

function buildHarness(options?: {
  faults?: (keyof DiscussionStore)[];
  budgets?: Partial<DiscussionBudgets>;
  fakeOutcomes?: FakeDiscussionOutcome[];
}): Harness {
  const directory = mkdtempSync(join(tmpdir(), "discussion-storage-"));
  const url = `file:${join(directory, "discussions.db")}`;

  const clock = mutableClock(now);
  const store = new LibSQLDiscussionStore({
    url,
    now: clock.now,
    generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
  });
  const ready = store.init().then(() => { void store.recoverInterrupted(); });
  const fault = new FaultStore(store);
  for (const method of options?.faults ?? []) fault.faults.add(method);

  const sessions = new SignedSessionManager(signingKey);
  const service = new DiscussionService({
    store: fault,
    policy: new DiscussionPolicy(clock.now),
    turnLimit: 6,
    now: clock.now,
  });
  const fake = new FakeDiscussion(
    options?.fakeOutcomes ?? [
      { type: "success", result: generatedTurn },
      { type: "success", result: generatedTurn },
    ],
  );
  const runner = new DiscussionRunner({
    store: fault,
    discussion: fake,
    outputPolicy: new DiscussionOutputPolicy(clock.now),
    budgets: options?.budgets,
    now: clock.now,
  });
  const handlers = createDiscussionHttpHandlers(service, sessions, runner, {}, ready);

  return {
    store,
    fault,
    fake,
    handlers,
    ready,
    sessions,
    clock,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("Discussion storage-outage handling", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.close();
  });

  it("returns a stable 500 STORAGE_UNAVAILABLE envelope when Start cannot persist", async () => {
    harness = buildHarness({ faults: ["create"] });
    await harness.ready;

    const response = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(payload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect(payload.error.message).not.toContain("simulated");

    // Retry after the outage clears: no Discussion was created, so the
    // request is clean and Start succeeds.
    harness.fault.faults.delete("create");
    const recovered = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    expect(recovered.status).toBe(201);
    expect(DiscussionStateSchema.parse(await recovered.json()).id).toBeDefined();
  });

  it("returns STORAGE_UNAVAILABLE when reading a persisted Discussion fails", async () => {
    harness = buildHarness();
    await harness.ready;

    const created = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(
      await created.clone().json(),
    ).id;

    harness.fault.faults.add("readOwned");
    const response = await harness.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(payload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect(payload.error.message).not.toContain("simulated");

    // Recovery: the Read succeeds using the persisted state once storage
    // is reachable again.
    harness.fault.faults.delete("readOwned");
    const recovered = await harness.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(recovered.status).toBe(200);
    expect(
      DiscussionStateSchema.parse(await recovered.json()).id,
    ).toBe(discussionId);
  });

  it("maps a claim-time outage to STORAGE_UNAVAILABLE without a provider call, then recovers", async () => {
    harness = buildHarness({ faults: ["claimTurn"] });
    await harness.ready;

    const created = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(
      await created.clone().json(),
    ).id;

    const response = await harness.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(payload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    // The outage fired before generation: no provider invocation happened.
    expect(harness.fake.calls).toHaveLength(0);
    // Nothing was persisted as generating or failed; the identity is clean.
    expect(
      await harness.fault.requestStatus(ownerCookie.split("=")[1]!, discussionId, requestId),
    ).toEqual({ kind: "unknown" });

    // Clearing the fault lets the same identity claim and complete exactly
    // one Turn.
    harness.fault.faults.delete("claimTurn");
    const retry = await harness.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(retry.status).toBe(200);
    const committed = DiscussionStateSchema.parse(await retry.json());
    expect(committed).toMatchObject({ status: "idle", turnCount: 1 });
    expect(committed.transcript).toHaveLength(1);
    expect(harness.fake.calls).toHaveLength(1);
  });

  it("does not poison the request identity when completing a persisted Turn fails", async () => {
    harness = buildHarness({ faults: ["completeTurn"] });
    await harness.ready;

    const created = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(
      await created.clone().json(),
    ).id;

    // The claim and generation both succeed; the outage surfaces only at
    // commit time (completing the persisted Turn).
    const failed = await harness.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    const failedPayload = ErrorResponseSchema.parse(await failed.json());

    expect(failed.status).toBe(500);
    expect(failedPayload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect(failedPayload.error.message).not.toContain("simulated");

    // The failed commit must NOT have been recorded as a non-retryable
    // Turn failure (which would poison the identity). The Discussion stays
    // generating with a live recovery lease.
    const generating = await harness.fault.readOwned(
      ownerCookie.split("=")[1]!.split(".")[0]!,
      discussionId,
    );
    expect(generating).toMatchObject({
      status: "generating",
      turnCount: 0,
      transcript: [],
    });

    // Let the recovery lease expire and clear the outage. The original
    // request identity reclaims its Turn (no skip, no duplicate) and the
    // single committed Turn comes from the retry.
    harness.clock.advance(leaseMs + 1);
    harness.fault.faults.delete("completeTurn");
    // The retry re-runs generation (the first result was never committed).
    harness.fake.enqueue({ type: "success", result: generatedTurn });

    const retry = await harness.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(retry.status).toBe(200);
    const committed = DiscussionStateSchema.parse(await retry.json());
    expect(committed).toMatchObject({ status: "idle", turnCount: 1 });
    // Exactly one committed Turn: the abandoned attempt never committed.
    expect(committed.transcript).toHaveLength(1);
  });

  it("maps a Stop outage to STORAGE_UNAVAILABLE on an active generation and recovers", async () => {
    harness = buildHarness({ faults: ["stopOwned"] });
    await harness.ready;

    const created = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(
      await created.clone().json(),
    ).id;

    // Put the Discussion into a generating state directly on the durable
    // store (no in-flight provider promise), then surface the outage from
    // Stop.
    const claimed = await harness.store.claimTurn({
      ownerSessionId: ownerCookie.split("=")[1]!.split(".")[0]!,
      discussionId,
      requestId,
      attemptId,
      updatedAt: now.toISOString(),
    });
    expect(claimed.kind).toBe("claimed");

    const response = await harness.handlers.postStop(
      new Request(`http://localhost/api/discussions/${discussionId}/stop`, {
        method: "POST",
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(payload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect(payload.error.message).not.toContain("simulated");

    // The outage must not have persisted a stop; the Discussion is still
    // generating, so the lease is intact and a retry can stop it.
    expect(
      await harness.fault.readOwned(
        ownerCookie.split("=")[1]!.split(".")[0]!,
        discussionId,
      ),
    ).toMatchObject({ status: "generating" });

    harness.fault.faults.delete("stopOwned");
    const recovered = await harness.handlers.postStop(
      new Request(`http://localhost/api/discussions/${discussionId}/stop`, {
        method: "POST",
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(recovered.status).toBe(200);
    expect(
      DiscussionStateSchema.parse(await recovered.json()).status,
    ).toBe("stopped");
  });

  it("surfaces STORAGE_UNAVAILABLE, not GENERATION_CAPACITY_EXCEEDED, when capacity-rejection reconciliation cannot persist", async () => {
    // Reproduction of the masking race: the only capacity slot is held by
    // an in-flight first Turn, so the second next-Turn is rejected at
    // capacity; the rejection's reconciliation write (failTurn) then hits a
    // storage outage and must surface as STORAGE_UNAVAILABLE, never as
    // GENERATION_CAPACITY_EXCEEDED.
    harness = buildHarness({
      budgets: { maxConcurrentGenerations: 1 },
      // The first Turn holds the only slot in-flight; the second is
      // capacity-rejected.
      fakeOutcomes: [
        { type: "success", result: generatedTurn, delayMs: 50 },
        { type: "success", result: generatedTurn },
      ],
      faults: ["failTurn"],
    });
    await harness.ready;

    const createdA = await harness.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(createdA);
    const ownerSessionId = ownerCookie.split("=")[1]!.split(".")[0]!;
    const discussionIdA = DiscussionStateSchema.parse(
      await createdA.clone().json(),
    ).id;

    const createdB = await harness.handlers.post(
      jsonRequest(
        { topic: "Should cities create more public parks?" },
        ownerCookie,
      ),
    );
    const discussionIdB = DiscussionStateSchema.parse(
      await createdB.clone().json(),
    ).id;

    // Hold the only generation slot with an in-flight first Turn. The
    // provider is invoked only after the slot is acquired, so waiting on
    // that call guarantees capacity is held before the second call runs.
    const first = harness.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdA}`,
      ),
      discussionIdA,
    );
    // The provider is invoked only after the slot is acquired, so waiting
    // until it has been called guarantees capacity is held before the
    // second call runs.
    await vi.waitFor(() => expect(harness.fake.calls).toHaveLength(1));

    // The second Turn claims successfully (Discussion B is idle) then is
    // rejected at capacity; reconciliation via failTurn hits the outage.
    const rejected = await harness.handlers.postTurn(
      jsonRequest(
        { requestId: secondRequestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdB}`,
      ),
      discussionIdB,
    );
    const rejectedPayload = ErrorResponseSchema.parse(
      await rejected.clone().json(),
    );

    expect(rejected.status).toBe(500);
    expect(rejectedPayload.error).toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      retryable: true,
    });
    expect(rejectedPayload.error.code).not.toBe("GENERATION_CAPACITY_EXCEEDED");
    expect(rejectedPayload.error.message).not.toContain("simulated");
    // Provider is never called for the capacity-rejected Turn.
    expect(harness.fake.calls).toHaveLength(1);

    // The authoritative persisted state was not reconciled: Discussion B is
    // still generating, with a live recovery lease, and its request identity
    // is observable as a live generating attempt (not a poisoned failure).
    expect(
      await harness.fault.requestStatus(ownerSessionId, discussionIdB, secondRequestId),
    ).toEqual({ kind: "generating" });
    expect(
      await harness.fault.readOwned(ownerSessionId, discussionIdB),
    ).toMatchObject({ status: "generating", turnCount: 0, transcript: [] });

    // Let the held first Turn finish (its commit path is not faulted) so the
    // capacity slot is released.
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(
      DiscussionStateSchema.parse(await firstResponse.clone().json()).turnCount,
    ).toBe(1);

    // Let B's recovery lease expire and clear the outage. The same request
    // identity reclaims its Turn via lazy lease recovery (no skip, no
    // duplicate, identity not poisoned), and produces exactly one committed
    // Turn.
    harness.clock.advance(leaseMs + 1);
    harness.fault.faults.delete("failTurn");
    harness.fake.enqueue({ type: "success", result: generatedTurn });

    const recovered = await harness.handlers.postTurn(
      jsonRequest(
        { requestId: secondRequestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdB}`,
      ),
      discussionIdB,
    );
    expect(recovered.status).toBe(200);
    const committed = DiscussionStateSchema.parse(await recovered.clone().json());
    expect(committed).toMatchObject({ status: "idle", turnCount: 1 });
    expect(committed.transcript).toHaveLength(1);
    // Exactly two provider calls across the whole test: the held first Turn,
    // and the retried second Turn. The capacity-rejected attempt never
    // generated.
    expect(harness.fake.calls).toHaveLength(2);
  });

  describe("non-storage failures", () => {
    const cases: ReadonlyArray<{
      label: string;
      fault: keyof DiscussionStore;
      action: "start" | "read" | "nextTurn" | "stop";
    }> = [
      { label: "Start create", fault: "create", action: "start" },
      { label: "Read readOwned", fault: "readOwned", action: "read" },
      { label: "Next-Turn claimTurn", fault: "claimTurn", action: "nextTurn" },
      { label: "Stop stopOwned", fault: "stopOwned", action: "stop" },
    ];

    // A raw, non-storage failure; must never surface as STORAGE_UNAVAILABLE,
    // and its message must never leak to the participant.
    function installRawError(harness: Harness, fault: keyof DiscussionStore): Error {
      const raw = new Error("schema invariant violated: unexpected actor");
      (harness.fault as unknown as Record<string, unknown>)[fault] = () => {
        throw raw;
      };
      return raw;
    }

    it.each(cases)(
      "returns a non-storage %s failure as a stable 500 (not STORAGE_UNAVAILABLE) without leaking details",
      async ({ fault, action }) => {
        harness = buildHarness();
        await harness.ready;

        const created = await harness.handlers.post(
          jsonRequest({ topic: "Should cities create more public parks?" }),
        );
        const ownerCookie = cookiePair(created);
        const discussionId = DiscussionStateSchema.parse(
          await created.clone().json(),
        ).id;

        const raw = installRawError(harness, fault);

        let response: Response;
        if (action === "start") {
          response = await harness.handlers.post(
            jsonRequest({ topic: "Should cities create more public parks?" }),
          );
        } else if (action === "read") {
          response = await harness.handlers.get(
            new Request(`http://localhost/api/discussions/${discussionId}`, {
              headers: { Cookie: ownerCookie },
            }),
            discussionId,
          );
        } else if (action === "nextTurn") {
          response = await harness.handlers.postTurn(
            jsonRequest(
              { requestId },
              ownerCookie,
              `http://localhost/api/discussions/${discussionId}`,
            ),
            discussionId,
          );
        } else {
          response = await harness.handlers.postStop(
            new Request(`http://localhost/api/discussions/${discussionId}/stop`, {
              method: "POST",
              headers: { Cookie: ownerCookie },
            }),
            discussionId,
          );
        }

        const body = await response.text();
        const payload = ErrorResponseSchema.parse(JSON.parse(body));

        expect(response.status).toBe(500);
        expect(payload.error.code).not.toBe("STORAGE_UNAVAILABLE");
        expect(payload.error.code).toBe("INVALID_RESPONSE");
        expect(body).not.toContain("simulated");
        expect(body).not.toContain(raw.message);
      },
    );
  });
});
