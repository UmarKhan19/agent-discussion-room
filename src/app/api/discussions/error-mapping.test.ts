import { describe, expect, it } from "vitest";
import { ErrorResponseSchema, type PolicyOutcome } from "@/discussion/contracts";
import {
  DiscussionCompletedError,
  DiscussionGenerationCapacityError,
  DiscussionGenerationFailedError,
  DiscussionGenerationTimeoutError,
  DiscussionInvalidGeneratedTurnError,
  DiscussionInvalidStateError,
  DiscussionOutputPolicyBlockedError,
  DiscussionRequestInProgressError,
  DiscussionSessionQuotaExceededError,
  DiscussionStoppedError,
  DiscussionTurnInProgressError,
} from "@/discussion/discussion-runner";
import { DiscussionGenerationOutputLimitError } from "@/discussion/discussion";
import {
  DiscussionPolicyBlockedError,
  DiscussionStartConflictError,
} from "@/discussion/discussion-service";
import { DiscussionStorageUnavailableError } from "@/discussion/discussion-store";
import { noopTelemetry } from "@/observability/telemetry";
import { mapDiscussionError } from "./handler";

const blockedOutcome = {
  decision: "blocked",
  category: "genocide_advocacy",
  checkedAt: "2026-08-02T12:00:00.000Z",
} as const satisfies Extract<PolicyOutcome, { decision: "blocked" }>;

const meta = { operation: "next-turn", startedAt: 0 } as const;

interface MappingCase {
  name: string;
  error: unknown;
  status: number;
  code: string;
}

/**
 * The centralized error mapper is the single place where every known
 * application/domain/infrastructure error becomes its stable HTTP envelope.
 * This table pins that contract so a future endpoint cannot drift: each row
 * is the (error class, operation) → (status, code) mapping asserted by the
 * API integration tests end-to-end.
 */
describe("mapDiscussionError", () => {
  const cases: MappingCase[] = [
    {
      name: "storage unavailable",
      error: new DiscussionStorageUnavailableError(new Error("db down")),
      status: 500,
      code: "STORAGE_UNAVAILABLE",
    },
    {
      name: "input policy block",
      error: new DiscussionPolicyBlockedError(blockedOutcome),
      status: 422,
      code: "TOPIC_BLOCKED",
    },
    {
      name: "Start identity conflict",
      error: new DiscussionStartConflictError(),
      status: 409,
      code: "START_REQUEST_CONFLICT",
    },
    {
      name: "duplicate in-flight request identity",
      error: new DiscussionRequestInProgressError(),
      status: 409,
      code: "REQUEST_IN_PROGRESS",
    },
    {
      name: "competing request identity",
      error: new DiscussionTurnInProgressError(),
      status: 409,
      code: "TURN_IN_PROGRESS",
    },
    {
      name: "session generation quota",
      error: new DiscussionSessionQuotaExceededError(42),
      status: 429,
      code: "SESSION_QUOTA_EXCEEDED",
    },
    {
      name: "generation capacity",
      error: new DiscussionGenerationCapacityError(),
      status: 503,
      code: "GENERATION_CAPACITY_EXCEEDED",
    },
    {
      name: "completed Discussion",
      error: new DiscussionCompletedError(),
      status: 409,
      code: "DISCUSSION_COMPLETED",
    },
    {
      name: "invalid Discussion state (next Turn)",
      error: new DiscussionInvalidStateError(),
      status: 409,
      code: "INVALID_DISCUSSION_STATE",
    },
    {
      name: "output policy block",
      error: new DiscussionOutputPolicyBlockedError("extremist_praise"),
      status: 422,
      code: "OUTPUT_BLOCKED",
    },
    {
      name: "generated Turn violates the contract",
      error: new DiscussionInvalidGeneratedTurnError(),
      status: 502,
      code: "INVALID_RESPONSE",
    },
    {
      name: "generated Turn exceeds the output limit",
      error: new DiscussionGenerationOutputLimitError(),
      status: 502,
      code: "OUTPUT_LIMIT_EXCEEDED",
    },
    {
      name: "generation timeout",
      error: new DiscussionGenerationTimeoutError(),
      status: 504,
      code: "GENERATION_TIMEOUT",
    },
    {
      name: "stopped Discussion",
      error: new DiscussionStoppedError(),
      status: 409,
      code: "DISCUSSION_STOPPED",
    },
    {
      name: "non-retryable generation failure",
      error: new DiscussionGenerationFailedError(false),
      status: 502,
      code: "GENERATION_FAILED",
    },
  ];

  it.each(cases)("maps $name to $status $code", async ({ error, status, code }) => {
    const response = mapDiscussionError(noopTelemetry, error, meta);
    expect(response).not.toBeNull();
    const body = ErrorResponseSchema.parse(await response!.json());
    expect(response!.status).toBe(status);
    expect(body.error.code).toBe(code);
  });

  it("keeps unknown errors unmapped so the endpoint fallback answers them", () => {
    expect(mapDiscussionError(noopTelemetry, new Error("boom"), meta)).toBeNull();
    expect(mapDiscussionError(noopTelemetry, "not even an error", meta)).toBeNull();
  });

  it("keys the INVALID_DISCUSSION_STATE copy off the operation", async () => {
    const cases = [
      {
        operation: "next-turn",
        message: "This Discussion is not eligible for another Turn.",
      },
      {
        operation: "stop",
        message: "This Discussion has no active generation to stop.",
      },
      {
        operation: "synthesis",
        message: "The synthesis can only be retried for a completed Discussion.",
      },
    ] as const;
    for (const { operation, message } of cases) {
      const response = mapDiscussionError(noopTelemetry, new DiscussionInvalidStateError(), {
        operation,
        startedAt: 0,
      });
      expect(response).not.toBeNull();
      const body = ErrorResponseSchema.parse(await response!.json());
      expect(body.error.code).toBe("INVALID_DISCUSSION_STATE");
      expect(body.error.message).toBe(message);
    }
  });

  it("never discloses an unknown error message or stack", () => {
    const response = mapDiscussionError(
      noopTelemetry,
      new Error("secret-internal-detail: leaked"),
      meta,
    );
    expect(response).toBeNull();
  });
});
