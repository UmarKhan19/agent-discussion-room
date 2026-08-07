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
  /** Server-owned one-based Turn position this generation must produce. */
  turn: number;
  speaker: Speaker;
  transcript: readonly DiscussionMessage[];
  signal?: AbortSignal;
  /**
   * Server-owned output-token ceiling. Passed to the provider when it
   * supports a token limit; never supplied by the client.
   */
  maxOutputTokens?: number;
  /**
   * Server-owned output-character ceiling. Enforced by the adapter and the
   * Discussion Runner after generation; never supplied by the client.
   */
  maxOutputCharacters?: number;
}

export const GeneratedDiscussionTurnSchema = z
  .object({
    content: DiscussionMessageContentSchema,
    usage: GenerationUsageSchema.optional(),
    /**
     * Stable provider/model identifier reported through operational
     * telemetry for cost and reliability investigation. Never persisted in
     * the Discussion system of record.
     */
    model: z.string().trim().min(1).optional(),
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

/** The provider returned more output than the configured ceiling allows. */
export class DiscussionGenerationOutputLimitError extends Error {
  constructor() {
    super("Discussion generation exceeded the configured output limit");
    this.name = "DiscussionGenerationOutputLimitError";
  }
}

export class DiscussionCancelledError extends Error {
  constructor() {
    super("Discussion generation was cancelled");
    this.name = "DiscussionCancelledError";
  }
}
