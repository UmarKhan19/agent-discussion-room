import { z } from "zod";

export const TOPIC_MAX_LENGTH = 240;
export const MESSAGE_MAX_LENGTH = 12_000;
export const DEFAULT_DISCUSSION_TURN_LIMIT = 12;
export const HARD_DISCUSSION_TURN_LIMIT = 12;

/**
 * Server-reserved request identity of the one logical synthesis that
 * completes a naturally finished Discussion.
 *
 * The synthesis is a server-owned completion step, never a client Turn
 * request: the browser does not invent, submit, or even know this identity,
 * and the ordinary per-Turn `requestId` namespace is untouched. It is a
 * stable logical identity across retries — persisted on
 * `DiscussionState.synthesis` for idempotency and telemetry — so a retry can
 * never create a second synthesis object and a stale attempt can never
 * overwrite a valid one. Deliberately a well-known UUID: scoped per
 * Discussion in the persisted state document, so sharing one value across
 * Discussions is safe.
 */
export const SYNTHESIS_REQUEST_ID = "00000000-0000-4000-8000-000000000001";

/** One structured string field of the synthesis content. */
export const SYNTHESIS_FIELD_MAX_CHARACTERS = 1_200;
/** Ceiling on the `agreements` array (the sides may have agreed on nothing). */
export const SYNTHESIS_MAX_AGREEMENTS = 4;
/** Ceiling on the `claimsToVerify` array (nothing may need verification). */
export const SYNTHESIS_MAX_CLAIMS = 4;
/** Ceiling across every structured field of the persisted synthesis content. */
export const SYNTHESIS_MAX_TOTAL_CHARACTERS = 6_000;

export const DiscussionTopicSchema = z
  .string()
  .max(TOPIC_MAX_LENGTH)
  .trim()
  .min(1)
  .refine((topic) => !/[\u0000-\u001f\u007f]/u.test(topic));

export const SpeakerSchema = z.enum(["supporter", "opponent"]);

export function speakerForTurn(turn: number): Speaker {
  return turn % 2 === 1 ? "supporter" : "opponent";
}

export const DiscussionStatusSchema = z.enum([
  "idle",
  "generating",
  "completed",
  "stopped",
  "failed",
]);
export const DiscussionTerminalReasonSchema = z.enum([
  "stop",
  "disconnect",
  "timeout",
]);
export const DiscussionIdentifierSchema = z.uuid();
export const SessionIdentifierSchema = z.uuid();
export const RequestIdentifierSchema = z.uuid();

export const PolicyCategorySchema = z.enum([
  "protected_class_violence_advocacy",
  "genocide_advocacy",
  "extremist_praise",
]);

export const AllowedPolicyOutcomeSchema = z
  .object({
    decision: z.literal("allowed"),
    category: z.null(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const BlockedPolicyOutcomeSchema = z
  .object({
    decision: z.literal("blocked"),
    category: PolicyCategorySchema,
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const PolicyOutcomeSchema = z.discriminatedUnion("decision", [
  AllowedPolicyOutcomeSchema,
  BlockedPolicyOutcomeSchema,
]);

export const GenerationUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (usage) =>
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalTokens !== undefined,
    { message: "Generation usage must contain at least one token count" },
  );

export const GenerationMetadataSchema = z
  .object({
    requestId: RequestIdentifierSchema,
    usage: GenerationUsageSchema.optional(),
    outputPolicyOutcome: AllowedPolicyOutcomeSchema,
  })
  .strict();

/**
 * The structured, validated synthesis content. Every field is bounded; the
 * arrays are bounded in length and may legitimately be empty. The schema is
 * the runtime contract for the synthesis model output: malformed, oversized,
 * or incorrectly typed output fails validation and is never persisted.
 */
export const SynthesisContentSchema = z
  .object({
    strongestSupport: z
      .string()
      .trim()
      .min(1)
      .max(SYNTHESIS_FIELD_MAX_CHARACTERS),
    strongestOpposition: z
      .string()
      .trim()
      .min(1)
      .max(SYNTHESIS_FIELD_MAX_CHARACTERS),
    agreements: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(SYNTHESIS_FIELD_MAX_CHARACTERS),
      )
      .max(SYNTHESIS_MAX_AGREEMENTS),
    unresolved: z.string().trim().min(1).max(SYNTHESIS_FIELD_MAX_CHARACTERS),
    claimsToVerify: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(SYNTHESIS_FIELD_MAX_CHARACTERS),
      )
      .max(SYNTHESIS_MAX_CLAIMS),
    takeaway: z.string().trim().min(1).max(SYNTHESIS_FIELD_MAX_CHARACTERS),
  })
  .strict()
  .refine(
    (content) =>
      content.strongestSupport.length +
        content.strongestOpposition.length +
        content.agreements.reduce((sum, item) => sum + item.length, 0) +
        content.unresolved.length +
        content.claimsToVerify.reduce((sum, item) => sum + item.length, 0) +
        content.takeaway.length <=
      SYNTHESIS_MAX_TOTAL_CHARACTERS,
    {
      message: `Synthesis content exceeds ${SYNTHESIS_MAX_TOTAL_CHARACTERS} characters`,
      path: [],
    },
  );

/**
 * Stable, closed classification of why a synthesis did not complete. Unlike
 * a Turn failure it has no `stopped` kind: once the final debate Turn
 * commits, Stop is no longer meaningful and synthesis is never "stopped" —
 * it completes, fails, or times out.
 */
export const SynthesisFailureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("generation_failed"),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("invalid_response"),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("output_blocked"),
      retryable: z.literal(false),
      category: PolicyCategorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("output_limit_exceeded"),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("timeout"),
      retryable: z.literal(false),
    })
    .strict(),
]);

/**
 * The persisted synthesis attempt record. The discussion state is
 * `completed` (the debate is durable and the Transcript intact) while the
 * synthesis runs; `synthesis.status` is the explicit sub-state the product
 * shows instead of pretending a finished synthesis exists.
 */
export const SynthesisSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("generating"),
      requestId: RequestIdentifierSchema,
      attemptId: RequestIdentifierSchema,
      startedAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
      /** Recovery lease; written by the durable store, null in-memory. */
      leaseOwnerId: z.string().trim().min(1).nullable(),
      leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      requestId: RequestIdentifierSchema,
      attemptId: RequestIdentifierSchema,
      content: SynthesisContentSchema,
      usage: GenerationUsageSchema.optional(),
      outputPolicyOutcome: AllowedPolicyOutcomeSchema,
      startedAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
      leaseOwnerId: z.null(),
      leaseExpiresAt: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      requestId: RequestIdentifierSchema,
      attemptId: RequestIdentifierSchema,
      failure: SynthesisFailureSchema,
      startedAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
      leaseOwnerId: z.null(),
      leaseExpiresAt: z.null(),
    })
    .strict(),
]);

export const DiscussionMessageContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(MESSAGE_MAX_LENGTH);

export const DiscussionMessageSchema = z
  .object({
    id: z.uuid(),
    content: DiscussionMessageContentSchema,
    speaker: SpeakerSchema,
    createdAt: z.string().datetime({ offset: true }),
    turn: z.number().int().positive(),
    generation: GenerationMetadataSchema,
  })
  .strict();

export const StartDiscussionRequestSchema = z
  .object({
    topic: DiscussionTopicSchema,
    /**
     * Stable client-generated identity for one logical Start operation.
     * The server persists the (owner session, creation request identity)
     * mapping durably, so retrying the same logical Start — after a lost
     * response, a network failure, or a browser reload — replays the same
     * Discussion instead of creating a duplicate. A genuinely new Start
     * action must use a new identity. Deliberately distinct from the
     * next-Turn `requestId` (different namespace and lifecycle operation).
     */
    creationRequestId: RequestIdentifierSchema,
  })
  .strict();

export const NextTurnRequestSchema = z
  .object({
    requestId: RequestIdentifierSchema,
  })
  .strict();

export const DiscussionStateSchema = z
  .object({
    id: DiscussionIdentifierSchema,
    topic: DiscussionTopicSchema,
    status: DiscussionStatusSchema,
    terminalReason: DiscussionTerminalReasonSchema.nullable().default(null),
    turnLimit: z.number().int().positive().max(HARD_DISCUSSION_TURN_LIMIT),
    turnCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    policyOutcome: PolicyOutcomeSchema,
    transcript: z.array(DiscussionMessageSchema),
    /**
     * Optional: a naturally completed Discussion carries a synthesis; legacy
     * completed Discussions predate the feature and stay valid without one.
     */
    synthesis: SynthesisSchema.optional(),
  })
  .strict()
  .refine(
    (discussion) =>
      discussion.synthesis === undefined || discussion.status === "completed",
    {
      message: "Synthesis exists only on a completed Discussion",
      path: ["synthesis"],
    },
  )
  .refine((discussion) => discussion.turnCount <= discussion.turnLimit, {
    message: "Turn count cannot exceed the Turn limit",
    path: ["turnCount"],
  })
  .refine(
    (discussion) =>
      discussion.status !== "completed" ||
      discussion.turnCount === discussion.turnLimit,
    {
      message: "A completed Discussion must be at its Turn limit",
      path: ["status"],
    },
  )
  .refine(
    (discussion) =>
      discussion.turnCount !== discussion.turnLimit ||
      discussion.status === "completed",
    {
      message: "A Discussion at its Turn limit must be completed",
      path: ["status"],
    },
  )
  .refine(
    (discussion) => discussion.transcript.length === discussion.turnCount,
    {
      message: "Transcript length must match the Turn count",
      path: ["transcript"],
    },
  )
  .refine(
    (discussion) =>
      discussion.status === "stopped"
        ? discussion.terminalReason === "stop" ||
          discussion.terminalReason === "disconnect"
        : discussion.terminalReason !== "stop" &&
          discussion.terminalReason !== "disconnect",
    {
      message: "Stopped Discussions require a Stop or disconnect reason",
      path: ["terminalReason"],
    },
  )
  .refine(
    (discussion) =>
      discussion.terminalReason === "timeout"
        ? discussion.status === "failed"
        : true,
    {
      message: "Timeout is valid only for a failed Discussion",
      path: ["terminalReason"],
    },
  )
  .superRefine((discussion, context) => {
    discussion.transcript.forEach((message, index) => {
      if (message.turn !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Message Turn positions must be ordered without gaps",
          path: ["transcript", index, "turn"],
        });
      }
      // Each Turn has a single authoritative speaker (odd => Supporter,
      // even => Opponent). A persisted Message whose speaker does not
      // match its Turn represents an impossible transcript and must not
      // pass persistence validation, even when the Turn number itself is
      // well-formed. Reuses `speakerForTurn` so the domain rule has one
      // source of truth rather than being duplicated here.
      if (message.speaker !== speakerForTurn(message.turn)) {
        context.addIssue({
          code: "custom",
          message: `Speaker "${message.speaker}" is not valid for Turn ${message.turn} (expected "${speakerForTurn(message.turn)}")`,
          path: ["transcript", index, "speaker"],
        });
      }
    });
  });

export const ProductErrorCodeSchema = z.enum([
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
  "START_REQUEST_CONFLICT",
  "INVALID_RESPONSE",
  "STORAGE_UNAVAILABLE",
]);

export const ProductErrorSchema = z
  .object({
    code: ProductErrorCodeSchema,
    message: z.string().min(1),
    action: z.string().min(1),
    retryable: z.boolean(),
    category: PolicyCategorySchema.optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: ProductErrorSchema,
  })
  .strict();

export const DiscussionResponseSchema = DiscussionStateSchema;

export type DiscussionTopic = z.infer<typeof DiscussionTopicSchema>;
export type DiscussionIdentifier = z.infer<
  typeof DiscussionIdentifierSchema
>;
export type SessionIdentifier = z.infer<typeof SessionIdentifierSchema>;
export type RequestIdentifier = z.infer<typeof RequestIdentifierSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type DiscussionStatus = z.infer<typeof DiscussionStatusSchema>;
export type DiscussionTerminalReason = z.infer<
  typeof DiscussionTerminalReasonSchema
>;
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type AllowedPolicyOutcome = z.infer<typeof AllowedPolicyOutcomeSchema>;
export type GenerationUsage = z.infer<typeof GenerationUsageSchema>;
export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;
export type DiscussionMessage = z.infer<typeof DiscussionMessageSchema>;
export type SynthesisContent = z.infer<typeof SynthesisContentSchema>;
export type SynthesisFailure = z.infer<typeof SynthesisFailureSchema>;
export type Synthesis = z.infer<typeof SynthesisSchema>;
export type StartDiscussionRequest = z.infer<
  typeof StartDiscussionRequestSchema
>;
export type NextTurnRequest = z.infer<typeof NextTurnRequestSchema>;
export type DiscussionState = z.infer<typeof DiscussionStateSchema>;
export type ProductErrorCode = z.infer<typeof ProductErrorCodeSchema>;
export type ProductError = z.infer<typeof ProductErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type DiscussionResponse = z.infer<typeof DiscussionResponseSchema>;
