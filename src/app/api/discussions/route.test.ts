import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionResponseSchema, ErrorResponseSchema } from "@/discussion/contracts";
import { GET, POST as POST_TURN } from "./[id]/route";
import { POST as POST_STOP } from "./[id]/stop/route";
import { POST } from "./route";

function expectPrivateSessionResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("Discussion routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { discussionHttpHandlers?: unknown })
      .discussionHttpHandlers;
  });

  it("uses a lower server-configured Turn limit", async () => {
    vi.stubEnv("DISCUSSION_TURN_LIMIT", "2");
    delete (globalThis as { discussionHttpHandlers?: unknown })
      .discussionHttpHandlers;
    vi.resetModules();
    const { POST: configuredPost } = await import("./route");

    const created = await configuredPost(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "How cities can improve public parks" }),
      }),
    );
    const discussion = DiscussionResponseSchema.parse(await created.json());

    expect(discussion.turnLimit).toBe(2);
  });

  it("wires an ownership-protected next-Turn POST on the Discussion resource", async () => {
    const created = await POST(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "How cities can improve public parks" }),
      }),
    );
    const discussion = DiscussionResponseSchema.parse(await created.json());

    const denied = await POST_TURN(
      new Request(`http://localhost/api/discussions/${discussion.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
      { params: Promise.resolve({ id: discussion.id }) },
    );

    expect(denied.status).toBe(404);
    expectPrivateSessionResponse(denied);
    expect(ErrorResponseSchema.parse(await denied.json()).error.code).toBe(
      "DISCUSSION_NOT_FOUND",
    );
  });

  it("wires the ownership-protected Stop endpoint", async () => {
    const created = await POST(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "How cities can improve public parks" }),
      }),
    );
    const discussion = DiscussionResponseSchema.parse(await created.json());
    const setCookie = created.headers.get("set-cookie");
    if (!setCookie) throw new Error("Expected the signed session cookie");
    const ownerCookie = setCookie.split(";", 1)[0];

    const denied = await POST_STOP(
      new Request(
        `http://localhost/api/discussions/${discussion.id}/stop`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ id: discussion.id }) },
    );
    expect(denied.status).toBe(404);
    expectPrivateSessionResponse(denied);

    const idleConflict = await POST_STOP(
      new Request(
        `http://localhost/api/discussions/${discussion.id}/stop`,
        { method: "POST", headers: { Cookie: ownerCookie } },
      ),
      { params: Promise.resolve({ id: discussion.id }) },
    );
    expect(idleConflict.status).toBe(409);
    expectPrivateSessionResponse(idleConflict);
    expect(
      ErrorResponseSchema.parse(await idleConflict.json()).error.code,
    ).toBe("INVALID_DISCUSSION_STATE");
  });

  it("prevents successful and denied session reads from being cached", async () => {
    const created = await POST(
      new Request("http://localhost/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "How cities can improve public parks" }),
      }),
    );
    const discussion = DiscussionResponseSchema.parse(await created.json());
    const setCookie = created.headers.get("set-cookie");
    if (!setCookie) throw new Error("Expected the signed session cookie");
    const ownerCookie = setCookie.split(";", 1)[0];

    const ownerRead = await GET(
      new Request(`http://localhost/api/discussions/${discussion.id}`, {
        headers: { Cookie: ownerCookie },
      }),
      { params: Promise.resolve({ id: discussion.id }) },
    );
    expect(ownerRead.status).toBe(200);
    expectPrivateSessionResponse(ownerRead);
    expect(DiscussionResponseSchema.parse(await ownerRead.json()).id).toBe(
      discussion.id,
    );

    const unrelatedRead = await GET(
      new Request(`http://localhost/api/discussions/${discussion.id}`),
      { params: Promise.resolve({ id: discussion.id }) },
    );
    expect(unrelatedRead.status).toBe(404);
    expectPrivateSessionResponse(unrelatedRead);
    expect(ErrorResponseSchema.parse(await unrelatedRead.json()).error.code).toBe(
      "DISCUSSION_NOT_FOUND",
    );
  });

  it.each([
    "DISCUSSION_TURN_LIMIT",
    "DISCUSSION_RECENT_TRANSCRIPT_TURNS",
    "DISCUSSION_TRANSCRIPT_CHARACTER_BUDGET",
    "DISCUSSION_MAX_OUTPUT_TOKENS",
    "DISCUSSION_MAX_OUTPUT_CHARACTERS",
    "DISCUSSION_GENERATION_TIMEOUT_MS",
    "DISCUSSION_MAX_CONCURRENT_GENERATIONS",
    "DISCUSSION_SESSION_GENERATION_QUOTA",
  ])(
    "fails startup loudly when a budget environment value is out of range: %s",
    async (name) => {
      vi.stubEnv(name, "999999999");
      delete (globalThis as { discussionHttpHandlers?: unknown })
        .discussionHttpHandlers;
      vi.resetModules();
      await expect(import("./route")).rejects.toThrow();
    },
  );
});
