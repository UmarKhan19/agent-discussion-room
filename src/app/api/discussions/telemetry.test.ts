import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionBudgets } from "@/discussion/budgets";
import {
  DiscussionGenerationError,
  type Discussion,
} from "@/discussion/discussion";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import {
  DiscussionService,
  InMemoryDiscussionStore,
} from "@/discussion/discussion-service";
import {
  DiscussionOutputPolicy,
  DiscussionPolicy,
} from "@/discussion/policy";
import {
  FakeDiscussion,
  type FakeDiscussionOutcome,
} from "@/discussion/testing/fake-discussion";
import { SignedSessionManager } from "@/discussion/signed-session";
import {
  JsonLineTelemetry,
  TelemetryEventSchema,
  type TelemetrySink,
} from "@/observability/telemetry";
import { createDiscussionHttpHandlers } from "./handler";

const now = new Date("2026-08-02T12:00:00.000Z");
const TOPIC = "Should cities create more public parks?";
const MESSAGE_CONTENT =
  "Public parks give more residents access to shared green space.";
const SECRET = "sk-secret-provider-credential";
const MODEL = "opencode/deepseek-v4-flash-free";
const signingKey = "test-signing-key-that-is-at-least-32-characters";
const requestId = "22222222-2222-4222-8222-222222222222";

function discussionIdFor(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function messageIdFor(turn: number): string {
  return `33333333-3333-4333-8333-${String(turn).padStart(12, "0")}`;
}

/**
 * Test Starts predate the required `creationRequestId`; inject a unique one
 * whenever a body carries a Topic but no identity, leaving malformed bodies
 * untouched so validation tests keep their intent.
 */
let startRequestSequence = 0;
function testCreationRequestId(): string {
  startRequestSequence += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(startRequestSequence).padStart(12, "0")}`;
}

function withDefaultCreationRequestId(body: unknown): unknown {
  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "topic" in body &&
    !("creationRequestId" in body)
  ) {
    return { ...(body as Record<string, unknown>), creationRequestId: testCreationRequestId() };
  }
  return body;
}

function jsonRequest(
  body: unknown,
  cookie?: string,
  url = "http://localhost/api/discussions",
  signal?: AbortSignal,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(withDefaultCreationRequestId(body)),
    signal,
  });
}

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

type LoggedEvent = Record<string, unknown>;

interface TelemetryFixture {
  telemetry: JsonLineTelemetry;
  lines: string[];
  events: LoggedEvent[];
}

function captureTelemetry(): TelemetryFixture {
  const lines: string[] = [];
  const events: LoggedEvent[] = [];
  const sink: TelemetrySink = {
    writeLine(line: string): void {
      lines.push(line);
      events.push(JSON.parse(line) as LoggedEvent);
    },
  };
  return { telemetry: new JsonLineTelemetry(sink), lines, events };
}

describe("privacy-safe operational telemetry at the HTTP seam", () => {
  let idCalls: number;
  let messageIdCalls: number;
  let sessions: SignedSessionManager;
  let store: InMemoryDiscussionStore;
  let service: DiscussionService;
  let fakeDiscussion: FakeDiscussion;
  let runner: DiscussionRunner;
  let handlers: ReturnType<typeof createDiscussionHttpHandlers>;
  let fixture: TelemetryFixture;

  function install(
    discussion: Discussion,
    budgets?: Partial<DiscussionBudgets>,
  ): void {
    runner = new DiscussionRunner({
      store,
      discussion,
      outputPolicy: new DiscussionOutputPolicy(() => now),
      now: () => now,
      createMessageId: () => {
        messageIdCalls += 1;
        return messageIdFor(messageIdCalls);
      },
      telemetry: fixture.telemetry,
      ...(budgets === undefined ? {} : { budgets }),
    });
    handlers = createDiscussionHttpHandlers(
      service,
      sessions,
      runner,
      undefined,
      Promise.resolve(),
      fixture.telemetry,
    );
  }

  function configureService(turnLimit?: number): void {
    store = new InMemoryDiscussionStore();
    service = new DiscussionService({
      store,
      policy: new DiscussionPolicy(() => now),
      ...(turnLimit === undefined ? {} : { turnLimit }),
      now: () => now,
      createId: () => {
        idCalls += 1;
        return discussionIdFor(idCalls);
      },
    });
  }

  function useFake(outcomes: readonly FakeDiscussionOutcome[]): void {
    fakeDiscussion = new FakeDiscussion(outcomes);
    install(fakeDiscussion);
  }

  async function waitForFakeCall(): Promise<void> {
    for (
      let attempt = 0;
      attempt < 10 && fakeDiscussion.calls.length === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(fakeDiscussion.calls).toHaveLength(1);
  }

  function requestEvents(): LoggedEvent[] {
    return fixture.events.filter((event) => event.event === "request");
  }

  function generationEvents(): LoggedEvent[] {
    return fixture.events.filter((event) => event.event === "generation");
  }

  function expectNoConversationContent(...additional: string[]): void {
    const serialized = fixture.lines.join("\n");
    expect(serialized).not.toContain(TOPIC);
    expect(serialized).not.toContain(MESSAGE_CONTENT);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("provider stack");
    expect(serialized).not.toContain("internal prompt");
    for (const forbidden of additional) {
      expect(serialized).not.toContain(forbidden);
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    idCalls = 0;
    messageIdCalls = 0;
    sessions = new SignedSessionManager(signingKey);
    fixture = captureTelemetry();
    configureService(6);
    useFake([
      {
        type: "success",
        result: {
          content: MESSAGE_CONTENT,
          usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
          model: MODEL,
        },
      },
    ]);
  });

  it("records success metadata for start and Turn without conversation content", async () => {
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);

    const turn = await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    expect(turn.status).toBe(200);

    expect(requestEvents()).toHaveLength(2);
    expect(requestEvents()[0]).toMatchObject({
      event: "request",
      operation: "start",
      outcome: "success",
      statusCode: 201,
      discussionId: discussionIdFor(1),
      durationMs: expect.any(Number),
    });
    expect(requestEvents()[1]).toMatchObject({
      event: "request",
      operation: "next-turn",
      outcome: "success",
      statusCode: 200,
      requestId,
      discussionId: discussionIdFor(1),
      durationMs: expect.any(Number),
    });
    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      operation: "next-turn",
      outcome: "success",
      turn: 1,
      requestId,
      discussionId: discussionIdFor(1),
      model: MODEL,
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
      durationMs: expect.any(Number),
    });
    expectNoConversationContent();
  });

  it("records validation failures with a stable error class", async () => {
    const response = await handlers.post(jsonRequest({ topic: "   " }));

    expect(response.status).toBe(400);
    expect(requestEvents()).toHaveLength(1);
    expect(requestEvents()[0]).toMatchObject({
      event: "request",
      operation: "start",
      outcome: "failure",
      statusCode: 400,
      errorClass: "TOPIC_REQUIRED",
      retryable: false,
    });
    expectNoConversationContent();
  });

  it("records a blocked Topic with its policy category", async () => {
    const blockedTopic = "Advocate violence against Black people";
    const response = await handlers.post(jsonRequest({ topic: blockedTopic }));

    expect(response.status).toBe(422);
    expect(requestEvents()).toHaveLength(1);
    expect(requestEvents()[0]).toMatchObject({
      event: "request",
      operation: "start",
      outcome: "failure",
      statusCode: 422,
      errorClass: "TOPIC_BLOCKED",
      category: "protected_class_violence_advocacy",
    });
    expectNoConversationContent(blockedTopic);
  });

  it("records a blocked model output with its policy category", async () => {
    const blockedOutput =
      "Violence against Black people is justified and should be supported.";
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);
    useFake([
      {
        type: "success",
        result: {
          content: blockedOutput,
        },
      },
    ]);

    const response = await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    expect(response.status).toBe(422);

    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      outcome: "failure",
      errorClass: "OUTPUT_BLOCKED",
      category: "protected_class_violence_advocacy",
      turn: 1,
    });
    expect(requestEvents()).toHaveLength(2);
    expect(requestEvents()[1]).toMatchObject({
      event: "request",
      operation: "next-turn",
      outcome: "failure",
      statusCode: 422,
      errorClass: "OUTPUT_BLOCKED",
      category: "protected_class_violence_advocacy",
      requestId,
    });
    expectNoConversationContent();
  });

  it("records a rate-limited request with retry metadata", async () => {
    handlers = createDiscussionHttpHandlers(
      service,
      sessions,
      runner,
      { sessionRateLimit: 1, sessionRateWindowMs: 60_000 },
      Promise.resolve(),
      fixture.telemetry,
    );
    const first = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(first);

    const blocked = await handlers.post(
      jsonRequest({ topic: "A second Topic" }, ownerCookie),
    );
    expect(blocked.status).toBe(429);

    expect(requestEvents().at(-1)).toMatchObject({
      event: "request",
      operation: "start",
      outcome: "failure",
      statusCode: 429,
      errorClass: "RATE_LIMITED",
      retryable: true,
    });
    expectNoConversationContent();
  });

  it("records session quota exhaustion with a stable error class", async () => {
    configureService(6);
    useFake([
      { type: "success", result: { content: MESSAGE_CONTENT } },
      { type: "success", result: { content: MESSAGE_CONTENT } },
    ]);
    install(fakeDiscussion, { sessionGenerationQuota: 1 });

    const first = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(first);
    const firstTurn = await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    expect(firstTurn.status).toBe(200);

    const second = await handlers.post(
      jsonRequest({ topic: "A second permitted Topic" }, ownerCookie),
    );
    expect(second.status).toBe(201);
    const quotaBlocked = await handlers.postTurn(
      jsonRequest(
        { requestId: "44444444-4444-4444-8444-444444444444" },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(2)}`,
      ),
      discussionIdFor(2),
    );
    expect(quotaBlocked.status).toBe(429);

    expect(requestEvents().at(-1)).toMatchObject({
      event: "request",
      operation: "next-turn",
      outcome: "failure",
      statusCode: 429,
      errorClass: "SESSION_QUOTA_EXCEEDED",
      requestId: "44444444-4444-4444-8444-444444444444",
    });
    expect(generationEvents()).toHaveLength(1);
    expectNoConversationContent();
  });

  it("records provider failures with retryability and never the provider detail", async () => {
    useFake([
      {
        type: "failure",
        error: new DiscussionGenerationError(
          new Error(`provider stack ${SECRET} and internal prompt`),
          true,
        ),
      },
    ]);
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);

    const response = await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    expect(response.status).toBe(502);

    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      outcome: "failure",
      errorClass: "GENERATION_FAILED",
      retryable: true,
      turn: 1,
    });
    expect(requestEvents().at(-1)).toMatchObject({
      event: "request",
      outcome: "failure",
      statusCode: 502,
      errorClass: "GENERATION_FAILED",
      retryable: true,
    });
    expectNoConversationContent();
  });

  it("records a hard timeout as a cancelled generation with the timeout reason", async () => {
    vi.useFakeTimers();
    fakeDiscussion = new FakeDiscussion([
      {
        type: "success",
        result: { content: MESSAGE_CONTENT },
        delayMs: 100,
        ignoreAbort: true,
      },
    ]);
    install(fakeDiscussion, { generationTimeoutMs: 50 });
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);
    const pendingTurn = handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    await waitForFakeCall();

    await vi.advanceTimersByTimeAsync(50);
    const response = await pendingTurn;
    expect(response.status).toBe(504);

    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      outcome: "cancelled",
      errorClass: "GENERATION_TIMEOUT",
      cancellationReason: "timeout",
      turn: 1,
    });
    expect(requestEvents().at(-1)).toMatchObject({
      event: "request",
      outcome: "failure",
      statusCode: 504,
      errorClass: "GENERATION_TIMEOUT",
    });
    expectNoConversationContent();
  });

  it("records Stop as a cancelled generation with the stop reason", async () => {
    vi.useFakeTimers();
    fakeDiscussion = new FakeDiscussion([
      {
        type: "success",
        result: { content: MESSAGE_CONTENT },
        delayMs: 100,
        ignoreAbort: true,
      },
    ]);
    install(fakeDiscussion);
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);
    const pendingTurn = handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    await waitForFakeCall();

    const stopResponse = await handlers.postStop(
      new Request(
        `http://localhost/api/discussions/${discussionIdFor(1)}/stop`,
        { method: "POST", headers: { Cookie: ownerCookie } },
      ),
      discussionIdFor(1),
    );
    expect(stopResponse.status).toBe(200);
    expect((await pendingTurn).status).toBe(409);

    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      outcome: "cancelled",
      errorClass: "DISCUSSION_STOPPED",
      cancellationReason: "stop",
      turn: 1,
    });
    expect(requestEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "start", outcome: "success" }),
        expect.objectContaining({
          operation: "next-turn",
          outcome: "failure",
          errorClass: "DISCUSSION_STOPPED",
        }),
        expect.objectContaining({ operation: "stop", outcome: "success" }),
      ]),
    );
    expectNoConversationContent();
  });

  it("marks the generation event completed when the Turn limit is reached", async () => {
    configureService(1);
    useFake([{ type: "success", result: { content: MESSAGE_CONTENT } }]);
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);

    const turn = await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    expect(turn.status).toBe(200);

    expect(generationEvents()).toHaveLength(1);
    expect(generationEvents()[0]).toMatchObject({
      event: "generation",
      outcome: "success",
      turn: 1,
      completed: true,
    });
    expectNoConversationContent();
  });

  it("records read requests without content", async () => {
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);

    const read = await handlers.get(
      new Request(`http://localhost/api/discussions/${discussionIdFor(1)}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionIdFor(1),
    );
    expect(read.status).toBe(200);

    expect(requestEvents().at(-1)).toMatchObject({
      event: "request",
      operation: "read",
      outcome: "success",
      statusCode: 200,
      discussionId: discussionIdFor(1),
    });
    expectNoConversationContent();
  });

  it("keeps every emitted log line free of conversation content across a mixed lifecycle", async () => {
    useFake([
      { type: "success", result: { content: MESSAGE_CONTENT } },
      { type: "success", result: { content: MESSAGE_CONTENT } },
      {
        type: "failure",
        error: new Error("provider stack included sk-secret-provider-credential"),
      },
    ]);
    const created = await handlers.post(jsonRequest({ topic: TOPIC }));
    const ownerCookie = cookiePair(created);
    await handlers.postTurn(
      jsonRequest(
        { requestId },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    await handlers.post(
      jsonRequest({ topic: "  A second Topic with padding  " }, ownerCookie),
    );
    await handlers.postTurn(
      jsonRequest(
        { requestId: "44444444-4444-4444-8444-444444444444" },
        ownerCookie,
        `http://localhost/api/discussions/${discussionIdFor(1)}`,
      ),
      discussionIdFor(1),
    );
    await handlers.post(
      jsonRequest(
        { topic: "Advocate violence against Black people" },
        ownerCookie,
      ),
    );

    for (const event of fixture.events) {
      expect(TelemetryEventSchema.safeParse(event).success).toBe(true);
    }
    expectNoConversationContent();
  });
});
