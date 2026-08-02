import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  speakerForTurn,
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
    super("Discussion is not eligible for another Turn");
    this.name = "DiscussionInvalidStateError";
  }
}

export class DiscussionCompletedError extends Error {
  constructor() {
    super("Discussion has completed its configured Turn limit");
    this.name = "DiscussionCompletedError";
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
  | DiscussionCompletedError
  | DiscussionInvalidStateError
  | DiscussionOutputPolicyBlockedError
  | DiscussionInvalidGeneratedTurnError {
  return (
    error instanceof DiscussionCompletedError ||
    error instanceof DiscussionInvalidStateError ||
    error instanceof DiscussionOutputPolicyBlockedError ||
    error instanceof DiscussionInvalidGeneratedTurnError
  );
}

const RECENT_TRANSCRIPT_TURN_LIMIT = 8;
const TRANSCRIPT_CHARACTER_BUDGET = 32_000;

function selectGenerationTranscript(
  transcript: DiscussionState["transcript"],
): DiscussionState["transcript"] {
  const selected = [] as DiscussionState["transcript"];
  let characterCount = 0;

  for (
    let index = transcript.length - 1;
    index >= 0 && selected.length < RECENT_TRANSCRIPT_TURN_LIMIT;
    index -= 1
  ) {
    const message = transcript[index];
    if (!message) continue;
    if (characterCount + message.content.length > TRANSCRIPT_CHARACTER_BUDGET) {
      break;
    }

    selected.unshift(message);
    characterCount += message.content.length;
  }

  return selected;
}

/** Sole authority for next-Turn lifecycle, Speaker selection, policy, and commit. */
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
        if (current.status === "completed") {
          throw new DiscussionCompletedError();
        }
        if (current.status !== "idle" || current.turnCount >= current.turnLimit) {
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

    const turn = generating.turnCount + 1;
    const speaker = speakerForTurn(turn);
    const generationTranscript = selectGenerationTranscript(
      generating.transcript,
    );

    try {
      const generatedResult = GeneratedDiscussionTurnSchema.safeParse(
        await this.discussion.generateTurn({
          topic: generating.topic,
          speaker,
          transcript: generationTranscript,
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
        speaker,
        createdAt: timestamp,
        turn,
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
          if (
            current.status !== "generating" ||
            current.turnCount !== turn - 1
          ) {
            throw new DiscussionInvalidStateError();
          }

          return {
            ...current,
            status: turn === current.turnLimit ? "completed" : "idle",
            turnCount: turn,
            updatedAt: timestamp,
            transcript: [...current.transcript, messageResult.data],
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
