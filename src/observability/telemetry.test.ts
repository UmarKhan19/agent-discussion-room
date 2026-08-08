import { describe, expect, it } from "vitest";
import { ProductErrorCodeSchema } from "@/discussion/contracts";
import {
  CapturingTelemetry,
  JsonLineTelemetry,
  TelemetryEventSchema,
  noopTelemetry,
  redactValue,
  type TelemetryEvent,
  type TelemetrySink,
} from "./telemetry";

const requestId = "22222222-2222-4222-8222-222222222222";
const discussionId = "11111111-1111-4111-8111-111111111111";

type RequestEvent = Extract<TelemetryEvent, { event: "request" }>;
type GenerationEvent = Extract<TelemetryEvent, { event: "generation" }>;

function requestEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    event: "request",
    operation: "start",
    outcome: "success",
    durationMs: 12.5,
    statusCode: 201,
    requestId,
    discussionId,
    ...overrides,
  };
}

function generationEvent(
  overrides: Partial<GenerationEvent> = {},
): GenerationEvent {
  return {
    event: "generation",
    operation: "next-turn",
    outcome: "success",
    durationMs: 240,
    turn: 1,
    requestId,
    discussionId,
    model: "opencode/deepseek-v4-flash-free",
    usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    ...overrides,
  };
}

function linesOf(events: TelemetryEvent[]): string[] {
  const lines: string[] = [];
  const sink: TelemetrySink = { writeLine: (line) => lines.push(line) };
  const telemetry = new JsonLineTelemetry(sink);
  for (const event of events) telemetry.record(event);
  return lines;
}

describe("TelemetryEventSchema", () => {
  it("accepts a complete request event with error classification", () => {
    expect(
      TelemetryEventSchema.parse({
        event: "request",
        operation: "next-turn",
        outcome: "failure",
        durationMs: 3,
        statusCode: 429,
        errorClass: "RATE_LIMITED",
        retryable: true,
        requestId,
        discussionId,
      }),
    ).toBeDefined();
  });

  it("accepts a generation event with model, usage, and cancellation reason", () => {
    expect(
      TelemetryEventSchema.parse({
        event: "generation",
        operation: "next-turn",
        outcome: "cancelled",
        durationMs: 40,
        turn: 3,
        requestId,
        discussionId,
        errorClass: "DISCUSSION_STOPPED",
        cancellationReason: "stop",
      }),
    ).toBeDefined();
  });

  it("accepts a synthesis generation event without a Turn index", () => {
    expect(
      TelemetryEventSchema.parse({
        event: "generation",
        operation: "synthesis",
        outcome: "success",
        durationMs: 40,
        requestId,
        discussionId,
        model: "opencode/deepseek-v4-flash-free",
        usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
      }),
    ).toBeDefined();
  });

  it.each([
    ["topic", "Should cities create more public parks?"],
    ["transcript", [{ speaker: "supporter", content: "secret turn" }]],
    ["content", "The generated message content"],
    ["prompt", "internal model instructions"],
    ["messages", [{ content: "a persisted message" }]],
    ["sessionSecret", "super-secret-signing-key-value"],
    ["authorization", "Bearer super-secret-token"],
    ["providerResponse", { raw: "provider payload" }],
  ])("rejects a %s field even when every required field is present", (field, value) => {
    const result = TelemetryEventSchema.safeParse({
      ...generationEvent(),
      [field]: value,
    });

    expect(result.success).toBe(false);
  });
});

describe("redactValue", () => {
  it.each([
    "sk-secret-provider-credential",
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "ghp_012345678901234567890123456789012345",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ])("redacts a credential-shaped value: %s", (value) => {
    expect(redactValue(value)).toBe("[REDACTED]");
  });

  it("redacts values under sensitive key names regardless of shape", () => {
    expect(
      redactValue({
        metadata: {
          apiKey: "anything",
          Authorization: "anything",
          signingKey: "anything",
          model: "opencode/deepseek-v4-flash-free",
        },
      }),
    ).toEqual({
      metadata: {
        apiKey: "[REDACTED]",
        Authorization: "[REDACTED]",
        signingKey: "[REDACTED]",
        model: "opencode/deepseek-v4-flash-free",
      },
    });
  });

  it("redacts values inside arrays and leaves ordinary values untouched", () => {
    expect(
      redactValue({
        usage: { inputTokens: 12, outputTokens: 9 },
        ids: [requestId, "sk-leaked-key-value"],
        errorClass: "GENERATION_FAILED",
      }),
    ).toEqual({
      usage: { inputTokens: 12, outputTokens: 9 },
      ids: [requestId, "[REDACTED]"],
      errorClass: "GENERATION_FAILED",
    });
  });
});

describe("JsonLineTelemetry", () => {
  it("emits one structured JSON line per valid event", () => {
    const lines = linesOf([requestEvent(), generationEvent()]);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "request",
      operation: "start",
      outcome: "success",
      statusCode: 201,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "generation",
      operation: "next-turn",
      outcome: "success",
      turn: 1,
      model: "opencode/deepseek-v4-flash-free",
      usage: { inputTokens: 12 },
    });
  });

  it("never writes conversation content into a valid event line", () => {
    const lines = linesOf([
      generationEvent(),
      requestEvent({ operation: "next-turn", outcome: "failure", errorClass: "GENERATION_FAILED", statusCode: 502 }),
    ]);
    const serialized = lines.join("\n");

    expect(serialized).not.toContain("Should cities");
    expect(serialized).not.toContain("secret turn");
    expect(serialized).not.toContain("internal model instructions");
  });

  it("redacts credential-shaped values inside emitted lines", () => {
    const lines = linesOf([
      generationEvent({
        outcome: "failure",
        errorClass: "GENERATION_FAILED",
        retryable: true,
        model: "sk-accidental-model-secret",
      }),
    ]);
    const serialized = lines.join("\n");

    expect(serialized).not.toContain("sk-accidental-model-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("rejects events carrying forbidden fields without echoing their values", () => {
    const secretTopic = "Should cities create more public parks?";
    const lines = linesOf([
      { ...generationEvent(), topic: secretTopic } as unknown as TelemetryEvent,
    ]);

    expect(lines).toHaveLength(1);
    const rejected = JSON.parse(lines[0]!);
    expect(rejected).toMatchObject({
      event: "telemetry.rejected",
      problems: ["topic"],
    });
    expect(lines[0]).not.toContain(secretTopic);
  });

  it("keeps a valid event flowing when an earlier event was rejected", () => {
    const lines = linesOf([
      { ...requestEvent(), transcript: ["leaked"] } as unknown as TelemetryEvent,
      requestEvent(),
    ]);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "request",
      outcome: "success",
    });
    expect(lines.join("\n")).not.toContain("leaked");
  });
});

describe("CapturingTelemetry and noopTelemetry", () => {
  it("captures every recorded event in order", () => {
    const telemetry = new CapturingTelemetry();
    const first = requestEvent();
    const second = generationEvent();

    telemetry.record(first);
    telemetry.record(second);

    expect(telemetry.events).toEqual([first, second]);
  });

  it("noopTelemetry swallows records", () => {
    expect(() => noopTelemetry.record(generationEvent())).not.toThrow();
  });
});

describe("telemetry error-class coverage of product error codes", () => {
  it("accepts every ProductErrorCode as a stable telemetry error class", () => {
    // A product code missing from the telemetry vocabulary would make every
    // failure of that class emit a telemetry.rejected line instead of an
    // observable classification. The schema is the single source of truth.
    for (const code of ProductErrorCodeSchema.options) {
      expect(
        TelemetryEventSchema.safeParse({
          ...requestEvent(),
          outcome: "failure",
          errorClass: code,
        }).success,
      ).toBe(true);
    }
  });
});
