import { z } from "zod";

export const TOPIC_MAX_LENGTH = 240;
export const MESSAGE_MAX_LENGTH = 12_000;

export const DiscussionTopicSchema = z
  .string()
  .max(TOPIC_MAX_LENGTH)
  .trim()
  .min(1)
  .refine((topic) => !/[\u0000-\u001f\u007f]/u.test(topic));

export const SpeakerSchema = z.enum(["supporter", "opponent"]);
export const DiscussionStatusSchema = z.enum([
  "idle",
  "generating",
  "completed",
  "stopped",
  "failed",
]);
export const DiscussionIdentifierSchema = z.uuid();
export const SessionIdentifierSchema = z.uuid();

export const PolicyCategorySchema = z.enum([
  "protected_class_violence_advocacy",
  "genocide_advocacy",
  "extremist_praise",
]);

export const PolicyOutcomeSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("allowed"),
      category: z.null(),
      checkedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      decision: z.literal("blocked"),
      category: PolicyCategorySchema,
      checkedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const DiscussionMessageSchema = z
  .object({
    id: z.uuid(),
    content: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
    speaker: SpeakerSchema,
    createdAt: z.string().datetime({ offset: true }),
    turn: z.number().int().positive(),
  })
  .strict();

export const StartDiscussionRequestSchema = z
  .object({
    topic: DiscussionTopicSchema,
  })
  .strict();

export const DiscussionStateSchema = z
  .object({
    id: DiscussionIdentifierSchema,
    topic: DiscussionTopicSchema,
    status: DiscussionStatusSchema,
    turnLimit: z.number().int().positive(),
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
    (discussion) => discussion.transcript.length === discussion.turnCount,
    {
      message: "Transcript length must match the Turn count",
      path: ["transcript"],
    },
  );

export const ProductErrorCodeSchema = z.enum([
  "MALFORMED_REQUEST",
  "INVALID_REQUEST",
  "TOPIC_REQUIRED",
  "TOPIC_INVALID",
  "TOPIC_TOO_LONG",
  "TOPIC_BLOCKED",
  "INVALID_DISCUSSION_ID",
  "DISCUSSION_NOT_FOUND",
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
export type Speaker = z.infer<typeof SpeakerSchema>;
export type DiscussionStatus = z.infer<typeof DiscussionStatusSchema>;
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;
export type DiscussionMessage = z.infer<typeof DiscussionMessageSchema>;
export type StartDiscussionRequest = z.infer<
  typeof StartDiscussionRequestSchema
>;
export type DiscussionState = z.infer<typeof DiscussionStateSchema>;
export type ProductErrorCode = z.infer<typeof ProductErrorCodeSchema>;
export type ProductError = z.infer<typeof ProductErrorSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type DiscussionResponse = z.infer<typeof DiscussionResponseSchema>;
