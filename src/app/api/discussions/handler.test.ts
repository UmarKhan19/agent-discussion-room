import { beforeEach, describe, expect, it } from "vitest";
import { DiscussionStateSchema, ErrorResponseSchema } from "@/discussion/contracts";
import {
  DiscussionService,
  InMemoryDiscussionStore,
} from "@/discussion/discussion-service";
import { DiscussionPolicy } from "@/discussion/policy";
import {
  DISCUSSION_SESSION_COOKIE,
  SignedSessionManager,
} from "@/discussion/signed-session";
import { createDiscussionHttpHandlers } from "./handler";

const now = new Date("2026-08-02T12:00:00.000Z");
const discussionId = "11111111-1111-4111-8111-111111111111";
const signingKey = "test-signing-key-that-is-at-least-32-characters";

function jsonRequest(body: unknown, cookie?: string): Request {
  return new Request("http://localhost/api/discussions", {
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

describe("Discussion HTTP interface", () => {
  let idCalls: number;
  let sessions: SignedSessionManager;
  let handlers: ReturnType<typeof createDiscussionHttpHandlers>;

  beforeEach(() => {
    idCalls = 0;
    sessions = new SignedSessionManager(signingKey);
    const policy = new DiscussionPolicy(() => now);
    const service = new DiscussionService({
      store: new InMemoryDiscussionStore(),
      policy,
      turnLimit: 6,
      now: () => now,
      createId: () => {
        idCalls += 1;
        return discussionId;
      },
    });
    handlers = createDiscussionHttpHandlers(service, sessions);
  });

  it("creates a server-owned, runtime-valid initial Discussion", async () => {
    const response = await handlers.post(
      jsonRequest({ topic: "  Should cities create more public parks?  " }),
    );
    const payload: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(DiscussionStateSchema.parse(payload)).toEqual({
      id: discussionId,
      topic: "Should cities create more public parks?",
      status: "idle",
      turnLimit: 6,
      turnCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      policyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: now.toISOString(),
      },
      transcript: [],
    });
    expect(idCalls).toBe(1);
  });

  it.each([
    [{ topic: "" }, "TOPIC_REQUIRED"],
    [{ topic: "   " }, "TOPIC_REQUIRED"],
    [{ topic: 42 }, "TOPIC_INVALID"],
    [{ topic: "line one\nline two" }, "TOPIC_INVALID"],
    [{ topic: "x".repeat(241) }, "TOPIC_TOO_LONG"],
    [{}, "TOPIC_INVALID"],
    [[], "INVALID_REQUEST"],
    [
      { topic: "A Topic", speaker: "supporter", messages: [] },
      "INVALID_REQUEST",
    ],
  ])("rejects invalid input %# before creating state", async (body, code) => {
    const response = await handlers.post(jsonRequest(body));
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe(code);
    expect(payload.error.action.length).toBeGreaterThan(10);
    expect(idCalls).toBe(0);
  });

  it("returns a stable malformed-JSON error", async () => {
    const response = await handlers.post(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        body: "{",
      }),
    );
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("MALFORMED_REQUEST");
    expect(idCalls).toBe(0);
  });

  it.each([
    ["Advocate violence against Black people", "protected_class_violence_advocacy"],
    [
      "Advocate violence against Black people to stop integration",
      "protected_class_violence_advocacy",
    ],
    ["It is right to murder Muslims", "protected_class_violence_advocacy"],
    [
      "Encourage the massacre of Jewish people",
      "protected_class_violence_advocacy",
    ],
    ["Argue that genocide should be justified", "genocide_advocacy"],
    ["Why genocide was good", "genocide_advocacy"],
    ["Genocide is desirable", "genocide_advocacy"],
    ["Praise ISIS and glorify its actions", "extremist_praise"],
    ["Celebrate the accomplishments of ISIS", "extremist_praise"],
  ])("blocks prohibited Topic without creating a Discussion: %s", async (topic, category) => {
    const response = await handlers.post(jsonRequest({ topic }));
    const payload = ErrorResponseSchema.parse(await response.json());

    expect(response.status).toBe(422);
    expect(payload.error).toMatchObject({
      code: "TOPIC_BLOCKED",
      category,
    });
    expect(payload.error.action).toContain("critically examines");
    expect(idCalls).toBe(0);
  });

  it("allows only the signed owner session to read a Discussion", async () => {
    const created = await handlers.post(jsonRequest({ topic: "A permitted Topic" }));
    const ownerCookie = cookiePair(created);

    const ownerRead = await handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: ownerCookie },
      }),
      discussionId,
    );
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.headers.get("cache-control")).toBe("private, no-store");
    expect(ownerRead.headers.get("vary")).toBe("Cookie");
    expect(DiscussionStateSchema.parse(await ownerRead.json()).id).toBe(
      discussionId,
    );

    const unrelatedToken = sessions.createToken(
      "22222222-2222-4222-8222-222222222222",
    );
    const unrelatedRead = await handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: {
          Cookie: `${DISCUSSION_SESSION_COOKIE}=${unrelatedToken}`,
        },
      }),
      discussionId,
    );
    expect(unrelatedRead.status).toBe(404);
    expect(unrelatedRead.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(unrelatedRead.headers.get("vary")).toBe("Cookie");
    expect(
      ErrorResponseSchema.parse(await unrelatedRead.json()).error.code,
    ).toBe("DISCUSSION_NOT_FOUND");

    const identifierOnlyRead = await handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`),
      discussionId,
    );
    expect(identifierOnlyRead.status).toBe(404);

    const lastCharacter = ownerCookie.at(-1);
    const tamperedCookie = `${ownerCookie.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
    const tamperedRead = await handlers.get(
      new Request(`http://localhost/api/discussions/${discussionId}`, {
        headers: { Cookie: tamperedCookie },
      }),
      discussionId,
    );
    expect(tamperedRead.status).toBe(404);
  });

  it("rejects malformed Discussion identifiers before reading state", async () => {
    const response = await handlers.get(
      new Request("http://localhost/api/discussions/not-an-id"),
      "not-an-id",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "INVALID_DISCUSSION_ID",
    );
  });
});
