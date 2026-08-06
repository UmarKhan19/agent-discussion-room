import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiscussionStateSchema,
  ErrorResponseSchema,
} from "@/discussion/contracts";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import { DiscussionService } from "@/discussion/discussion-service";
import { LibSQLDiscussionStore } from "@/discussion/libsql-discussion-store";
import {
  DiscussionOutputPolicy,
  DiscussionPolicy,
} from "@/discussion/policy";
import {
  FakeDiscussion,
  type FakeDiscussionOutcome,
} from "@/discussion/testing/fake-discussion";
import { SignedSessionManager } from "@/discussion/signed-session";
import { createDiscussionHttpHandlers } from "./handler";

const now = new Date("2026-08-02T12:00:00.000Z");
const signingKey = "test-signing-key-that-is-at-least-32-characters";
const requestId = "22222222-2222-4222-8222-222222222222";

function turnRequestId(turn: number): string {
  return `22222222-2222-4222-8222-${String(turn).padStart(12, "0")}`;
}

function turnMessageId(turn: number): string {
  return `33333333-3333-4333-8333-${String(turn).padStart(12, "0")}`;
}

const generatedTurn = {
  content: "Public parks give more residents access to shared green space.",
  usage: {
    inputTokens: 12,
    outputTokens: 9,
    totalTokens: 21,
  },
};

function successfulOutcomes(contents: readonly string[]): FakeDiscussionOutcome[] {
  return contents.map((content) => ({
    type: "success",
    result: { content },
  }));
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

interface Harness {
  store: LibSQLDiscussionStore;
  fake: FakeDiscussion;
  handlers: ReturnType<typeof createDiscussionHttpHandlers>;
  ready: Promise<void>;
}

/**
 * Reconstructs the application composition around the same durable store
 * file, exactly as a process restart would: a fresh store connection,
 * fresh service and Runner, fresh session manager, and the startup
 * readiness promise (schema init plus interrupted-generation recovery).
 */
function restartHarness(
  url: string,
  outcomes: readonly FakeDiscussionOutcome[],
): Harness {
  let idCalls = 0;
  let messageIdCalls = 0;
  const store = new LibSQLDiscussionStore({ url, now: () => now });
  const service = new DiscussionService({
    store,
    policy: new DiscussionPolicy(() => now),
    turnLimit: 3,
    now: () => now,
    createId: () => {
      idCalls += 1;
      return `11111111-1111-4111-8111-${String(idCalls).padStart(12, "0")}`;
    },
  });
  const fake = new FakeDiscussion(outcomes);
  const runner = new DiscussionRunner({
    store,
    discussion: fake,
    outputPolicy: new DiscussionOutputPolicy(() => now),
    now: () => now,
    createMessageId: () => {
      messageIdCalls += 1;
      return turnMessageId(messageIdCalls);
    },
    createAttemptId: () => "55555555-5555-4555-8555-555555555555",
  });
  const sessions = new SignedSessionManager(signingKey);
  const ready = store.init().then(async () => {
    await store.recoverInterrupted();
  });
  const handlers = createDiscussionHttpHandlers(
    service,
    sessions,
    runner,
    {},
    ready,
  );
  return { store, fake, handlers, ready };
}

async function waitForClaim(harness: Harness): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (harness.fake.calls.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(harness.fake.calls).toHaveLength(1);
}

describe("Discussion persistence across restarts", () => {
  const directories: string[] = [];

  function databaseUrl(): string {
    const directory = mkdtempSync(join(tmpdir(), "discussion-persistence-"));
    directories.push(directory);
    return `file:${join(directory, "discussions.db")}`;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives a restart during idle with ordered Messages and continued Turns", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, successfulOutcomes(["First Turn", "Second Turn"]));
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    expect(created.status).toBe(201);
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;

    const firstTurn = await first.handlers.postTurn(
      jsonRequest(
        { requestId: turnRequestId(1) },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(firstTurn.status).toBe(200);
    first.store.close();

    const second = restartHarness(url, successfulOutcomes(["Third Turn"]));
    const read = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    const state = DiscussionStateSchema.parse(await read.json());
    expect(state).toMatchObject({
      status: "idle",
      turnCount: 1,
      topic: "Should cities create more public parks?",
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]).toMatchObject({
      turn: 1,
      speaker: "supporter",
      content: "First Turn",
      generation: { requestId: turnRequestId(1) },
    });

    const secondTurn = await second.handlers.postTurn(
      jsonRequest(
        { requestId: turnRequestId(2) },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(secondTurn.status).toBe(200);
    const afterSecond = DiscussionStateSchema.parse(await secondTurn.json());
    expect(afterSecond.transcript.map((m) => m.speaker)).toEqual([
      "supporter",
      "opponent",
    ]);
    second.store.close();
  });

  it("preserves terminal completed state and stable request outcomes", async () => {
    const url = databaseUrl();
    const first = restartHarness(
      url,
      successfulOutcomes(["One", "Two", "Three"]),
    );
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;

    for (let turn = 1; turn <= 3; turn += 1) {
      const response = await first.handlers.postTurn(
        jsonRequest(
          { requestId: turnRequestId(turn) },
          ownerCookie,
          `http://localhost/api/discussions/${discussionId}`,
        ),
        discussionId,
      );
      expect(response.status).toBe(200);
    }
    first.store.close();

    const second = restartHarness(url, []);
    const read = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    const completed = DiscussionStateSchema.parse(await read.json());
    expect(completed).toMatchObject({
      status: "completed",
      turnCount: 3,
      turnLimit: 3,
      terminalReason: null,
    });
    expect(completed.transcript).toHaveLength(3);

    const advanced = await second.handlers.postTurn(
      jsonRequest(
        { requestId: turnRequestId(4) },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(advanced.status).toBe(409);
    expect(ErrorResponseSchema.parse(await advanced.json()).error.code).toBe(
      "DISCUSSION_COMPLETED",
    );

    const replayed = await second.handlers.postTurn(
      jsonRequest(
        { requestId: turnRequestId(3) },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(replayed.status).toBe(200);
    expect(
      DiscussionStateSchema.parse(await replayed.json()).transcript,
    ).toHaveLength(3);
    second.store.close();
  });

  it("preserves a stopped terminal state across a restart", async () => {
    const url = databaseUrl();
    const first = restartHarness(
      url,
      [{ type: "success", result: generatedTurn, delayMs: 100_000 }],
    );
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;

    const pending = first.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    await waitForClaim(first);
    const stopped = await first.handlers.postStop(
      new Request(`http://localhost/api/discussions/${discussionId}/stop`, {
        method: "POST",
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(stopped.status).toBe(200);
    first.store.close();
    await pending.catch(() => undefined);

    const second = restartHarness(url, []);
    const read = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(DiscussionStateSchema.parse(await read.json())).toMatchObject({
      status: "stopped",
      terminalReason: "stop",
      turnCount: 0,
    });
    second.store.close();
  });

  it("preserves a failed state across a restart", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, [
      { type: "failure", error: new Error("provider unavailable") },
    ]);
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;

    const failed = await first.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(failed.status).toBe(502);
    first.store.close();

    const second = restartHarness(url, []);
    const read = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(DiscussionStateSchema.parse(await read.json())).toMatchObject({
      status: "failed",
      terminalReason: null,
      turnCount: 0,
    });
    second.store.close();
  });

  it("recovers an interrupted generating state and retries without duplication", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, []);
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;

    // Simulated crash mid-generation: the Turn is claimed and persisted as
    // generating, then the process exits before the provider responds.
    const claimed = await first.store.claimTurn({
      ownerSessionId: ownerCookie.split("=")[1]!.split(".")[0]!,
      discussionId,
      requestId,
      attemptId: "55555555-5555-4555-8555-555555555555",
      updatedAt: now.toISOString(),
    });
    expect(claimed.kind).toBe("claimed");
    first.store.close();

    const second = restartHarness(url, successfulOutcomes(["Recovered Turn"]));
    const read = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(DiscussionStateSchema.parse(await read.json())).toMatchObject({
      status: "failed",
      terminalReason: null,
      turnCount: 0,
      transcript: [],
    });

    const retried = await second.handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(retried.status).toBe(200);
    const recovered = DiscussionStateSchema.parse(await retried.json());
    expect(recovered).toMatchObject({
      status: "idle",
      turnCount: 1,
    });
    expect(recovered.transcript).toHaveLength(1);
    expect(recovered.transcript[0].content).toBe("Recovered Turn");
    second.store.close();
  });

  it("enforces ownership across a restart", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, []);
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;
    first.store.close();

    const second = restartHarness(url, successfulOutcomes(["Turn"]));
    const unrelated = await second.handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`),
      discussionId,
    );
    expect(unrelated.status).toBe(404);

    const unrelatedTurn = await second.handlers.postTurn(
      jsonRequest(
        { requestId },
        undefined,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(unrelatedTurn.status).toBe(404);

    const ownerTurn = await second.handlers.postTurn(
      jsonRequest(
        { requestId: turnRequestId(1) },
        ownerCookie,
        `http://localhost/api/discussions/${discussionId}`,
      ),
      discussionId,
    );
    expect(ownerTurn.status).toBe(200);
    second.store.close();
  });

  it("waits for durable-store readiness before serving requests", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, []);
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;
    first.store.close();

    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const store = new LibSQLDiscussionStore({ url, now: () => now });
    const service = new DiscussionService({
      store,
      policy: new DiscussionPolicy(() => now),
      turnLimit: 3,
      now: () => now,
    });
    const runner = new DiscussionRunner({
      store,
      discussion: new FakeDiscussion([]),
      outputPolicy: new DiscussionOutputPolicy(() => now),
      now: () => now,
    });
    const sessions = new SignedSessionManager(signingKey);
    const gatedHandlers = createDiscussionHttpHandlers(
      service,
      sessions,
      runner,
      {},
      ready,
    );

    let settled = false;
    const blockedRead = gatedHandlers
      .get(
        new Request(`http://localhost/api/discussions/${discussionId}`, {
          headers: { Cookie: ownerCookie },
        }),
        discussionId,
      )
      .then((response) => {
        settled = true;
        return response;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReady();
    const response = await blockedRead;
    expect(settled).toBe(true);
    expect(response.status).toBe(200);
    store.close();
  });

  it("returns a stable error when the durable store fails startup readiness", async () => {
    const url = databaseUrl();
    const first = restartHarness(url, []);
    const created = await first.handlers.post(
      jsonRequest({ topic: "Should cities create more public parks?" }),
    );
    const ownerCookie = cookiePair(created);
    const discussionId = DiscussionStateSchema.parse(await created.json()).id;
    first.store.close();

    const store = new LibSQLDiscussionStore({ url, now: () => now });
    const service = new DiscussionService({
      store,
      policy: new DiscussionPolicy(() => now),
      turnLimit: 3,
      now: () => now,
    });
    const runner = new DiscussionRunner({
      store,
      discussion: new FakeDiscussion([]),
      outputPolicy: new DiscussionOutputPolicy(() => now),
      now: () => now,
    });
    const sessions = new SignedSessionManager(signingKey);
    const gatedHandlers = createDiscussionHttpHandlers(
      service,
      sessions,
      runner,
      {},
      Promise.reject(new Error("storage is unreachable")),
    );

    const response = await gatedHandlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(response.status).toBe(500);
    expect(ErrorResponseSchema.parse(await response.json())).toMatchObject({
      error: {
        code: "STORAGE_UNAVAILABLE",
        retryable: true,
      },
    });
    store.close();
  });
});
