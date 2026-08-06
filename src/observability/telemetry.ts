import { z } from "zod";
import {
  DiscussionIdentifierSchema,
  GenerationUsageSchema,
  PolicyCategorySchema,
  RequestIdentifierSchema,
} from "@/discussion/contracts";

/**
 * Privacy-safe operational telemetry.
 *
 * Every record is validated against a strict schema before emission, so a
 * conversation field (Topic, Transcript, Message content, prompt, provider
 * response, session secret, authorization material) can never reach a sink:
 * a record carrying one is rejected and reported without echoing its value.
 * On top of that structural guarantee, `redactValue` scrubs credential-shaped
 * values as defense in depth. Conversation redaction therefore never depends
 * on generic secret filtering succeeding.
 */

export const TelemetryOperationSchema = z.enum([
  "start",
  "read",
  "next-turn",
  "stop",
]);

export const TelemetryCancellationReasonSchema = z.enum([
  "stop",
  "disconnect",
  "timeout",
]);

/**
 * Stable, operator-facing error classes. These mirror the product error
 * codes returned to participants plus `INTERNAL` for failures that never
 * surface a product code (for example storage failures during cancellation).
 */
export const TelemetryErrorClassSchema = z.enum([
  "MALFORMED_REQUEST",
  "BODY_TOO_LARGE",
  "CONTENT_TYPE_UNSUPPORTED",
  "INVALID_REQUEST",
  "TOPIC_REQUIRED",
  "TOPIC_INVALID",
  "TOPIC_TOO_LONG",
  "TOPIC_BLOCKED",
  "INVALID_DISCUSSION_ID",
  "DISCUSSION_NOT_FOUND",
  "REQUEST_IN_PROGRESS",
  "TURN_IN_PROGRESS",
  "INVALID_DISCUSSION_STATE",
  "DISCUSSION_COMPLETED",
  "DISCUSSION_STOPPED",
  "OUTPUT_BLOCKED",
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "OUTPUT_LIMIT_EXCEEDED",
  "GENERATION_CAPACITY_EXCEEDED",
  "SESSION_QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
  "STORAGE_UNAVAILABLE",
  "INTERNAL",
]);

/** One HTTP request outcome, recorded at the interface seam. */
const RequestTelemetryEventSchema = z
  .object({
    event: z.literal("request"),
    operation: TelemetryOperationSchema,
    outcome: z.enum(["success", "failure"]),
    durationMs: z.number().nonnegative(),
    statusCode: z.number().int().positive(),
    errorClass: TelemetryErrorClassSchema.optional(),
    retryable: z.boolean().optional(),
    category: PolicyCategorySchema.optional(),
    requestId: RequestIdentifierSchema.optional(),
    discussionId: DiscussionIdentifierSchema.optional(),
  })
  .strict();

/** One claimed model generation, recorded at the Discussion Runner seam. */
const GenerationTelemetryEventSchema = z
  .object({
    event: z.literal("generation"),
    operation: z.literal("next-turn"),
    outcome: z.enum(["success", "failure", "cancelled"]),
    durationMs: z.number().nonnegative(),
    turn: z.number().int().positive(),
    requestId: RequestIdentifierSchema,
    discussionId: DiscussionIdentifierSchema,
    errorClass: TelemetryErrorClassSchema.optional(),
    retryable: z.boolean().optional(),
    category: PolicyCategorySchema.optional(),
    cancellationReason: TelemetryCancellationReasonSchema.optional(),
    model: z.string().trim().min(1).optional(),
    usage: GenerationUsageSchema.optional(),
    /** Present on success: whether this Turn completed the Discussion. */
    completed: z.boolean().optional(),
  })
  .strict();

export const TelemetryEventSchema = z.discriminatedUnion("event", [
  RequestTelemetryEventSchema,
  GenerationTelemetryEventSchema,
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetryOperation = z.infer<typeof TelemetryOperationSchema>;
export type TelemetryErrorClass = z.infer<typeof TelemetryErrorClassSchema>;
export type TelemetryCancellationReason = z.infer<
  typeof TelemetryCancellationReasonSchema
>;

export interface DiscussionTelemetry {
  record(event: TelemetryEvent): void;
}

export const noopTelemetry: DiscussionTelemetry = {
  record(): void {},
};

const SENSITIVE_KEY_PATTERN =
  /^(?:access[-_]?key|api[-_]?key|auth|authorization|bearer(?:[-_]?token)?|client[-_]?secret|cookie|credential|jwt|pass|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?key|signing[-_]?key|token)$/iu;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{8,}$/u,
  /^Bearer\s+[A-Za-z0-9._~+/-]+$/iu,
  /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/u,
  /^[A-Za-z0-9_\-]{40,}$/u,
];

/**
 * Defense-in-depth secret filtering: redacts values whose key names match
 * sensitive field names and values that look like credentials, regardless of
 * their key. This is NOT the conversation-redaction mechanism — records are
 * structurally incapable of carrying conversation content — but it keeps
 * accidental credential leakage out of emitted lines too.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
      ? "[REDACTED]"
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(entry),
      ]),
    );
  }
  return value;
}

export interface TelemetrySink {
  writeLine(line: string): void;
}

const stdoutSink: TelemetrySink = {
  writeLine(line: string): void {
    process.stdout.write(`${line}\n`);
  },
};

/**
 * Default production telemetry: one strict-validated, redacted JSON object
 * per line on stdout. Local behavior never depends on external export
 * credentials; this sink is the always-available operational channel.
 */
export class JsonLineTelemetry implements DiscussionTelemetry {
  constructor(private readonly sink: TelemetrySink = stdoutSink) {}

  record(event: TelemetryEvent): void {
    const parsed = TelemetryEventSchema.safeParse(event);
    if (!parsed.success) {
      this.sink.writeLine(
        JSON.stringify({
          event: "telemetry.rejected",
          problems: parsed.error.issues.map((issue) =>
            "keys" in issue && Array.isArray(issue.keys)
              ? issue.keys.join(",")
              : issue.path.length === 0
                ? "(root)"
                : issue.path.join("."),
          ),
        }),
      );
      return;
    }
    this.sink.writeLine(JSON.stringify(redactValue(parsed.data)));
  }
}

/** In-memory test double: keeps every recorded event for assertions. */
export class CapturingTelemetry implements DiscussionTelemetry {
  readonly events: TelemetryEvent[] = [];

  record(event: TelemetryEvent): void {
    this.events.push(event);
  }
}
