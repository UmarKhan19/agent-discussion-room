import type { DiscussionMessage, Speaker } from "./contracts";

export type { DiscussionMessage, Speaker } from "./contracts";

export interface DiscussionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerateDiscussionTurnInput {
  topic: string;
  speaker: Speaker;
  transcript: readonly DiscussionMessage[];
  signal?: AbortSignal;
}

export interface GeneratedDiscussionTurn {
  content: string;
  usage?: DiscussionUsage;
}

/** Product-owned boundary for generating one Discussion Turn. */
export interface Discussion {
  generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn>;
}

export class DiscussionGenerationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
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
