import { z } from "zod";

export const TOPIC_MAX_LENGTH = 240;
export const MESSAGE_MAX_LENGTH = 12_000;
export const DEFAULT_DISCUSSION_TURN_LIMIT = 12;
export const HARD_DISCUSSION_TURN_LIMIT = 12;

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
    turnLimit: z.number().int().positive().max(HARD_DISCUSSION_TURN_LIMIT),
    turnCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    policyOutcome: PolicyOutcomeSchema,
    transcript: z.array(DiscussionMessageSchema),
  })
  .strict()
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
  .superRefine((discussion, context) => {
    discussion.transcript.forEach((message, index) => {
      if (message.turn !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Message Turn positions must be ordered without gaps",
          path: ["transcript", index, "turn"],
        });
      }
    });
  });

export const ProductErrorCodeSchema = z.enum([
  "MALFORMED_REQUEST",
  "INVALID_REQUEST",
  "TOPIC_REQUIRED",
  "TOPIC_INVALID",
  "TOPIC_TOO_LONG",
  "TOPIC_BLOCKED",
  "INVALID_DISCUSSION_ID",
  "DISCUSSION_NOT_FOUND",
  "INVALID_DISCUSSION_STATE",
  "DISCUSSION_COMPLETED",
  "OUTPUT_BLOCKED",
  "GENERATION_FAILED",
  "INVALID_RESPONSE",
]);

export const ProductErrorSchema = z
  .object({
    code: ProductErrorCodeSchema,
    message: z.string().min(1),
    action: z.string().min(1),
    category: PolicyCategorySchema.optional(),
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
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type AllowedPolicyOutcome = z.infer<typeof AllowedPolicyOutcomeSchema>;
export type GenerationUsage = z.infer<typeof GenerationUsageSchema>;
export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;
export type DiscussionMessage = z.infer<typeof DiscussionMessageSchema>;
export type StartDiscussionRequest = z.infer<
  typeof StartDiscussionRequestSchema
>;
export type NextTurnRequest = z.infer<typeof NextTurnRequestSchema>;
export type DiscussionState = z.infer<typeof DiscussionStateSchema>;
export type ProductErrorCode = z.infer<typeof ProductErrorCodeSchema>;
export type ProductError = z.infer<typeof ProductErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type DiscussionResponse = z.infer<typeof DiscussionResponseSchema>;
