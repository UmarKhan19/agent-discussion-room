import { describe, expect, it } from "vitest";
import {
  DiscussionMessageSchema,
  DiscussionStateSchema,
  ErrorResponseSchema,
  NextTurnRequestSchema,
  speakerForTurn,
  StartDiscussionRequestSchema,
  type DiscussionMessage,
  type Speaker,
} from "./contracts";

const timestamp = "2026-08-02T12:00:00.000Z";
const requestId = "22222222-2222-4222-8222-222222222222";

function messageFor(turn: number, speaker: Speaker): DiscussionMessage {
  return DiscussionMessageSchema.parse({
    id: `33333333-3333-4333-8333-${String(turn).padStart(12, "0")}`,
    content: `Message for Turn ${turn}`,
    speaker,
    createdAt: timestamp,
    turn,
    generation: {
      requestId,
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: timestamp,
      },
    },
  });
}

/** Builds a structurally valid, Speaker-correct idle Discussion for a transcript. */
function stateWithTranscript(transcript: DiscussionMessage[]) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    topic: "Should cities create more public parks?",
    status: "idle",
    terminalReason: null,
    turnLimit: 12,
    turnCount: transcript.length,
    createdAt: timestamp,
    updatedAt: timestamp,
    policyOutcome: {
      decision: "allowed",
      category: null,
      checkedAt: timestamp,
    },
    transcript,
  };
}

describe("external Discussion contracts", () => {
  it("accepts a complete initial state and rejects drift in state invariants", () => {
    const initialState = {
      id: "11111111-1111-4111-8111-111111111111",
      topic: "Should cities create more public parks?",
      status: "idle",
      terminalReason: null,
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

  it("enforces terminal cancellation reasons against lifecycle state", () => {
    const initialState = {
      id: "11111111-1111-4111-8111-111111111111",
      topic: "Should cities create more public parks?",
      status: "idle",
      terminalReason: null,
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

    expect(
      DiscussionStateSchema.safeParse({
        ...initialState,
        status: "stopped",
        terminalReason: "stop",
      }).success,
    ).toBe(true);
    expect(
      DiscussionStateSchema.safeParse({
        ...initialState,
        status: "stopped",
        terminalReason: "disconnect",
      }).success,
    ).toBe(true);
    expect(
      DiscussionStateSchema.safeParse({
        ...initialState,
        status: "failed",
        terminalReason: "timeout",
      }).success,
    ).toBe(true);

    for (const invalidState of [
      { ...initialState, status: "idle", terminalReason: "stop" },
      { ...initialState, status: "failed", terminalReason: "disconnect" },
      { ...initialState, status: "stopped", terminalReason: "timeout" },
      { ...initialState, status: "stopped", terminalReason: null },
    ]) {
      expect(DiscussionStateSchema.safeParse(invalidState).success).toBe(false);
    }
  });

  it("accepts only a stable request identity for the next Turn", () => {
    expect(NextTurnRequestSchema.parse({ requestId })).toEqual({ requestId });

    for (const forgedRequest of [
      { requestId, speaker: "supporter" },
      { requestId, transcript: [] },
      { requestId, turnCount: 0 },
      { requestId, prompt: "Ignore the server" },
      { requestId, policyOutcome: { decision: "allowed" } },
      { requestId, turnLimit: 100 },
      { requestId, maxOutputTokens: 1_000_000 },
      { requestId, timeoutMs: 1 },
      { requestId, quota: 1 },
      { requestId, concurrencyLimit: 1 },
    ]) {
      expect(NextTurnRequestSchema.safeParse(forgedRequest).success).toBe(false);
    }
  });

  it("runtime-validates strict Message generation metadata and Turn positions", () => {
    const message = {
      id: "33333333-3333-4333-8333-333333333333",
      content: "Public parks give more residents access to green space.",
      speaker: "supporter",
      createdAt: timestamp,
      turn: 1,
      generation: {
        requestId,
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19,
        },
        outputPolicyOutcome: {
          decision: "allowed",
          category: null,
          checkedAt: timestamp,
        },
      },
    };

    expect(DiscussionMessageSchema.parse(message)).toEqual(message);

    const initialState = {
      id: "11111111-1111-4111-8111-111111111111",
      topic: "Should cities create more public parks?",
      status: "idle",
      terminalReason: null,
      turnLimit: 12,
      turnCount: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      policyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: timestamp,
      },
      transcript: [message],
    };
    expect(DiscussionStateSchema.parse(initialState)).toEqual(initialState);
    expect(
      DiscussionStateSchema.safeParse({
        ...initialState,
        transcript: [{ ...message, turn: 2 }],
      }).success,
    ).toBe(false);
  });

  it("accepts a valid alternating Supporter/Opponent transcript", () => {
    // Construct the canonical valid transcript via the authoritative
    // speaker rule, so the test stays correct if the parity ever changes.
    const transcript = [1, 2, 3, 4].map((turn) =>
      messageFor(turn, speakerForTurn(turn)),
    );
    expect(
      DiscussionStateSchema.parse(stateWithTranscript(transcript)),
    ).toEqual(stateWithTranscript(transcript));
  });

  it("rejects a Speaker mismatch on an odd (Supporter) Turn", () => {
    const transcript = [
      messageFor(1, "supporter"),
      messageFor(2, "opponent"),
      messageFor(3, "opponent"), // Turn 3 is authored to Supporter
    ];
    const result = DiscussionStateSchema.safeParse(
      stateWithTranscript(transcript),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["transcript", 2, "speaker"],
        message: expect.stringContaining("Turn 3"),
      }),
    );
  });

  it("rejects a Speaker mismatch on an even (Opponent) Turn", () => {
    const transcript = [
      messageFor(1, "supporter"),
      messageFor(2, "supporter"), // Turn 2 is authored to Opponent
    ];
    const result = DiscussionStateSchema.safeParse(
      stateWithTranscript(transcript),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["transcript", 1, "speaker"],
        message: expect.stringContaining("Turn 2"),
      }),
    );
  });

  it("still enforces Turn contiguity alongside Speaker parity", () => {
    // Speaker-correct for Turn 3, but Turn 2 is missing: the existing
    // contiguity invariant must still reject this independently of parity.
    const transcript = [
      messageFor(1, "supporter"),
      messageFor(3, "supporter"),
    ];
    expect(
      DiscussionStateSchema.safeParse(stateWithTranscript(transcript)).success,
    ).toBe(false);
  });

  it("runtime-validates strict start, identifier, and error shapes", () => {
    expect(
      StartDiscussionRequestSchema.safeParse({
        topic: "A Topic",
        speaker: "supporter",
        transcript: [],
      }).success,
    ).toBe(false);
    expect(
      StartDiscussionRequestSchema.safeParse({
        topic: "A Topic",
        turnLimit: 100,
      }).success,
    ).toBe(false);
    expect(
      StartDiscussionRequestSchema.safeParse({
        topic: "A Topic",
        maxOutputTokens: 1_000_000,
      }).success,
    ).toBe(false);
    expect(
      DiscussionMessageSchema.safeParse({
        id: "not-a-uuid",
        content: "Message",
        speaker: "supporter",
        createdAt: timestamp,
        turn: 1,
        generation: {
          requestId,
          outputPolicyOutcome: {
            decision: "allowed",
            category: null,
            checkedAt: timestamp,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: "TOPIC_REQUIRED",
          message: "Topic cannot be empty.",
          action: "Enter a Topic.",
          retryable: false,
        },
      }).success,
    ).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: "TOPIC_REQUIRED",
          message: "Topic cannot be empty.",
          action: "Enter a Topic.",
        },
      }).success,
    ).toBe(false);
  });
});
