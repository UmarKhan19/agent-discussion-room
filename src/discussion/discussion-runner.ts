import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  type DiscussionState,
  type PolicyOutcome,
} from "./contracts";
import {
  GeneratedDiscussionTurnSchema,
  type Discussion,
} from "./discussion";
import type { DiscussionStore } from "./discussion-service";
import {
  DiscussionOutputPolicy,
  type DiscussionOutputPolicyEvaluator,
} from "./policy";

export class DiscussionInvalidStateError extends Error {
  constructor() {
    super("Discussion is not eligible for its first Turn");
    this.name = "DiscussionInvalidStateError";
  }
}

export class DiscussionOutputPolicyBlockedError extends Error {
  constructor(
    readonly outcome: Extract<PolicyOutcome, { decision: "blocked" }>,
  ) {
    super("Generated Turn was blocked by output policy");
    this.name = "DiscussionOutputPolicyBlockedError";
  }
}

export class DiscussionGenerationFailedError extends Error {
  constructor() {
    super("Discussion Turn generation failed");
    this.name = "DiscussionGenerationFailedError";
  }
}

export class DiscussionInvalidGeneratedTurnError extends Error {
  constructor() {
    super("Generated Turn did not match the product contract");
    this.name = "DiscussionInvalidGeneratedTurnError";
  }
}

export interface DiscussionRunnerOptions {
  store: DiscussionStore;
  discussion: Discussion;
  outputPolicy?: DiscussionOutputPolicyEvaluator;
  now?: () => Date;
  createMessageId?: () => string;
}

function isRunnerError(
  error: unknown,
): error is
  | DiscussionInvalidStateError
  | DiscussionOutputPolicyBlockedError
  | DiscussionInvalidGeneratedTurnError {
  return (
    error instanceof DiscussionInvalidStateError ||
    error instanceof DiscussionOutputPolicyBlockedError ||
    error instanceof DiscussionInvalidGeneratedTurnError
  );
}

/** Sole authority for first-Turn lifecycle, Speaker selection, policy, and commit. */
export class DiscussionRunner {
  private readonly store: DiscussionStore;
  private readonly discussion: Discussion;
  private readonly outputPolicy: DiscussionOutputPolicyEvaluator;
  private readonly now: () => Date;
  private readonly createMessageId: () => string;

  constructor(options: DiscussionRunnerOptions) {
    this.store = options.store;
    this.discussion = options.discussion;
    this.outputPolicy =
      options.outputPolicy ?? new DiscussionOutputPolicy(options.now);
    this.now = options.now ?? (() => new Date());
    this.createMessageId =
      options.createMessageId ?? (() => crypto.randomUUID());
  }

  async nextTurn(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<DiscussionState | null> {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const id = DiscussionIdentifierSchema.parse(discussionId);
    const stableRequestId = RequestIdentifierSchema.parse(requestId);

    const generating = this.store.transitionOwned(
      sessionId,
      id,
      (current) => {
        if (current.status !== "idle" || current.turnCount !== 0) {
          throw new DiscussionInvalidStateError();
        }

        return {
          ...current,
          status: "generating",
          updatedAt: this.now().toISOString(),
        };
      },
    );

    if (!generating) return null;

    try {
      const generatedResult = GeneratedDiscussionTurnSchema.safeParse(
        await this.discussion.generateTurn({
          topic: generating.topic,
          speaker: "supporter",
          transcript: generating.transcript,
          signal,
        }),
      );
      if (!generatedResult.success) {
        throw new DiscussionInvalidGeneratedTurnError();
      }

      const outputPolicyOutcome = this.outputPolicy.evaluate(
        generatedResult.data.content,
      );
      if (outputPolicyOutcome.decision === "blocked") {
        throw new DiscussionOutputPolicyBlockedError(outputPolicyOutcome);
      }

      const timestamp = this.now().toISOString();
      const messageResult = DiscussionMessageSchema.safeParse({
        id: this.createMessageId(),
        content: generatedResult.data.content,
        speaker: "supporter",
        createdAt: timestamp,
        turn: 1,
        generation: {
          requestId: stableRequestId,
          ...(generatedResult.data.usage
            ? { usage: generatedResult.data.usage }
            : {}),
          outputPolicyOutcome,
        },
      });
      if (!messageResult.success) {
        throw new DiscussionInvalidGeneratedTurnError();
      }

      const completedTurn = this.store.transitionOwned(
        sessionId,
        id,
        (current) => {
          if (current.status !== "generating" || current.turnCount !== 0) {
            throw new DiscussionInvalidStateError();
          }

          return {
            ...current,
            status: "idle",
            turnCount: 1,
            updatedAt: timestamp,
            transcript: [messageResult.data],
          };
        },
      );

      if (!completedTurn) {
        throw new DiscussionInvalidGeneratedTurnError();
      }

      return completedTurn;
    } catch (error) {
      this.markGeneratingAsFailed(sessionId, id);
      if (isRunnerError(error)) throw error;
      throw new DiscussionGenerationFailedError();
    }
  }

  private markGeneratingAsFailed(
    ownerSessionId: string,
    discussionId: string,
  ): void {
    this.store.transitionOwned(ownerSessionId, discussionId, (current) => {
      if (current.status !== "generating") return current;

      return {
        ...current,
        status: "failed",
        updatedAt: this.now().toISOString(),
      };
    });
  }
}
