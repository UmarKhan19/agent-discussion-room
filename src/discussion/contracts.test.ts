import { describe, expect, it } from "vitest";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  ErrorResponseSchema,
  StartDiscussionRequestSchema,
} from "./contracts";

const timestamp = "2026-08-02T12:00:00.000Z";

describe("external Discussion contracts", () => {
  it("accepts a complete initial state and rejects drift in state invariants", () => {
    const initialState = {
      id: "11111111-1111-4111-8111-111111111111",
      topic: "Should cities create more public parks?",
      status: "idle",
      turnLimit: 12,
      turnCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      policyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: timestamp,
      },
      transcript: [],
    };

    expect(DiscussionStateSchema.parse(initialState)).toEqual(initialState);
    expect(
      DiscussionStateSchema.safeParse({ ...initialState, turnCount: 1 }).success,
    ).toBe(false);
  });

  it("runtime-validates strict request, Message, identifier, and error shapes", () => {
    expect(
      StartDiscussionRequestSchema.safeParse({
        topic: "A Topic",
        speaker: "supporter",
        transcript: [],
      }).success,
    ).toBe(false);
    expect(
      DiscussionMessageSchema.safeParse({
        id: "not-a-uuid",
        content: "Message",
        speaker: "supporter",
        createdAt: timestamp,
        turn: 1,
      }).success,
    ).toBe(false);
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: "TOPIC_REQUIRED",
          message: "Topic cannot be empty.",
          action: "Enter a Topic.",
        },
      }).success,
    ).toBe(true);
  });
});
