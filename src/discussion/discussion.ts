import { z } from "zod";
import {
  DiscussionMessageContentSchema,
  GenerationUsageSchema,
  type DiscussionMessage,
  type Speaker,
} from "./contracts";

export type {
  DiscussionMessage,
  GenerationUsage as DiscussionUsage,
  Speaker,
} from "./contracts";

export interface GenerateDiscussionTurnInput {
  topic: string;
  speaker: Speaker;
  transcript: readonly DiscussionMessage[];
  signal?: AbortSignal;
}

export const GeneratedDiscussionTurnSchema = z
  .object({
    content: DiscussionMessageContentSchema,
    usage: GenerationUsageSchema.optional(),
  })
  .strict();

export type GeneratedDiscussionTurn = z.infer<
  typeof GeneratedDiscussionTurnSchema
>;

/** Product-owned boundary for generating one Discussion Turn. */
export interface Discussion {
  generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn>;
}

export class DiscussionGenerationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown, readonly retryable = false) {
    super("Discussion generation failed");
    this.name = "DiscussionGenerationError";
    this.cause = cause;
  }
}

export class DiscussionCancelledError extends Error {
  constructor() {
    super("Discussion generation was cancelled");
    this.name = "DiscussionCancelledError";
  }
}
