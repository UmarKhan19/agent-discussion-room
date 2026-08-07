import type { AnySpan } from "@mastra/core/observability";
import { describe, expect, it } from "vitest";
import { ConversationRedactionSpanProcessor } from "./conversation-redaction";

function fakeSpan(overrides: Partial<AnySpan> = {}): AnySpan {
  return {
    id: "span-1",
    traceId: "0123456789abcdef0123456789abcdef",
    name: "agent run: 'supporter-agent'",
    type: "agent_run",
    startTime: new Date("2026-08-02T12:00:00.000Z"),
    endTime: new Date("2026-08-02T12:00:05.000Z"),
    isEvent: false,
    isInternal: false,
    input: {
      messages: [
        {
          role: "user",
          content: "Topic: Should cities create more public parks?",
        },
      ],
    },
    output: {
      text: "Public parks give more residents access to shared green space.",
    },
    attributes: {
      model: "opencode/deepseek-v4-flash-free",
      usage: { inputTokens: 12, outputTokens: 9 },
    },
    metadata: { requestId: "22222222-2222-4222-8222-222222222222" },
    errorInfo: {
      message: "rate limit exceeded",
      name: "APICallError",
      stack: "Error: rate limit exceeded\n    at Provider.call (...)",
      details: { raw: "provider response payload" },
    },
    ...overrides,
  } as unknown as AnySpan;
}

describe("ConversationRedactionSpanProcessor", () => {
  const processor = new ConversationRedactionSpanProcessor();

  it("removes prompts and model output from exported spans", () => {
    const processed = processor.process(fakeSpan())!;

    expect(processed.input).toBeUndefined();
    expect(processed.output).toBeUndefined();
  });

  it("removes free-text error messages, provider stacks, and raw payload details from error spans", () => {
    const processed = processor.process(
      fakeSpan({
        errorInfo: {
          message: "rate limit exceeded",
          name: "APICallError",
          stack: "Error: rate limit exceeded\n    at Provider.call (...)",
          details: { raw: "provider response payload" },
        },
      }),
    )!;

    expect(processed.errorInfo).toEqual({
      name: "APICallError",
    });
  });

  it("strips a provider error message that echoes prompt or output fragments", () => {
    const processed = processor.process(
      fakeSpan({
        errorInfo: {
          message:
            "provider rejected request containing: Topic: Should cities create more public parks? (sk-secret-provider-credential)",
          name: "APICallError",
          details: { raw: "provider response payload" },
        },
      }),
    )!;

    expect(processed.errorInfo).toEqual({
      name: "APICallError",
    });
    expect(JSON.stringify(processed.errorInfo)).not.toContain(
      "Should cities create more public parks?",
    );
    expect(JSON.stringify(processed.errorInfo)).not.toContain(
      "sk-secret-provider-credential",
    );
  });

  it("keeps attributes and metadata that carry model, usage, and request identity", () => {
    const processed = processor.process(fakeSpan())!;

    expect(processed.attributes).toEqual({
      model: "opencode/deepseek-v4-flash-free",
      usage: { inputTokens: 12, outputTokens: 9 },
    });
    expect(processed.metadata).toEqual({
      requestId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("preserves span identity and lifecycle fields", () => {
    const original = fakeSpan();
    const processed = processor.process(original)!;

    expect(processed.id).toBe(original.id);
    expect(processed.traceId).toBe(original.traceId);
    expect(processed.name).toBe(original.name);
    expect(processed.type).toBe(original.type);
    expect(processed.startTime).toBe(original.startTime);
    expect(processed.endTime).toBe(original.endTime);
  });

  it("returns the same span instance so the observability runtime can call its methods after processing", () => {
    const original = fakeSpan();
    const exportSpan = () => ({ id: "exported" });
    (original as unknown as { exportSpan: unknown }).exportSpan = exportSpan;

    const processed = processor.process(original)!;

    // Regression: returning a `{ ...span }` plain-object copy drops the
    // prototype methods (e.g. `exportSpan`), which made every agent
    // generation fail with "exportSpan is not a function".
    expect(processed).toBe(original);
    expect(
      (processed as unknown as { exportSpan: typeof exportSpan }).exportSpan,
    ).toBe(exportSpan);
  });

  it("returns undefined for an undefined span and shuts down without work", async () => {
    expect(processor.process(undefined)).toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});
