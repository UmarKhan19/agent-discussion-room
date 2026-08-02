import { describe, expect, it } from "vitest";
import { FakeDiscussion } from "@/discussion/testing/fake-discussion";
import { createChatPostHandler } from "./handler";

describe("chat transport", () => {
  it("generates through an injected Discussion", async () => {
    const discussion = new FakeDiscussion([
      {
        type: "success",
        result: {
          content: "A deterministic turn",
          usage: { totalTokens: 9 },
        },
      },
    ]);
    const post = createChatPostHandler(discussion);
    const requestBody = {
      topic: "A permitted topic",
      speaker: "supporter",
      messages: [],
    };

    const response = await post(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      content: "A deterministic turn",
      sender: "supporter",
    });
    expect(discussion.calls).toHaveLength(1);
    expect(discussion.calls[0]).toMatchObject({
      topic: requestBody.topic,
      speaker: requestBody.speaker,
      transcript: requestBody.messages,
    });
  });
});
