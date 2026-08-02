import { describe, expect, it } from "vitest";
import { DiscussionResponseSchema, ErrorResponseSchema } from "@/discussion/contracts";
import { GET } from "./[id]/route";
import { POST } from "./route";

function expectPrivateSessionResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("Discussion routes", () => {
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
});
