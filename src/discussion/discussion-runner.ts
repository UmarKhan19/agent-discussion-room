import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  speakerForTurn,
  type DiscussionState,
  type DiscussionTerminalReason,
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

export const DEFAULT_GENERATION_TIMEOUT_MS = 30_000;

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

export class DiscussionStoppedError extends Error {
  constructor() {
    super("Discussion generation was stopped");
    this.name = "DiscussionStoppedError";
  }
}

export class DiscussionGenerationTimeoutError extends Error {
  constructor() {
    super("Discussion generation reached its hard timeout");
    this.name = "DiscussionGenerationTimeoutError";
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
  generationTimeoutMs?: number;
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

interface ActiveGeneration {
  ownerSessionId: string;
  discussionId: string;
  controller: AbortController;
  cancellation: Promise<never>;
  rejectCancellation: (error: Error) => void;
  reason: DiscussionTerminalReason | null;
  timeout?: ReturnType<typeof setTimeout>;
  disconnectSignal?: AbortSignal;
  onDisconnect?: () => void;
}

function cancellationError(reason: DiscussionTerminalReason): Error {
  return reason === "timeout"
    ? new DiscussionGenerationTimeoutError()
    : new DiscussionStoppedError();
}

/** Sole authority for next-Turn lifecycle, Speaker selection, policy, and commit. */
export class DiscussionRunner {
  private readonly store: DiscussionStore;
  private readonly discussion: Discussion;
  private readonly outputPolicy: DiscussionOutputPolicyEvaluator;
  private readonly now: () => Date;
  private readonly createMessageId: () => string;
  private readonly generationTimeoutMs: number;
  private readonly activeGenerations = new Map<string, ActiveGeneration>();

  constructor(options: DiscussionRunnerOptions) {
    this.store = options.store;
    this.discussion = options.discussion;
    this.outputPolicy =
      options.outputPolicy ?? new DiscussionOutputPolicy(options.now);
    this.now = options.now ?? (() => new Date());
    this.createMessageId =
      options.createMessageId ?? (() => crypto.randomUUID());
    this.generationTimeoutMs =
      options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;

    if (
      !Number.isFinite(this.generationTimeoutMs) ||
      this.generationTimeoutMs <= 0
    ) {
      throw new RangeError("Generation timeout must be a positive number");
    }
  }

  stop(ownerSessionId: string, discussionId: string): DiscussionState | null {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const id = DiscussionIdentifierSchema.parse(discussionId);
    const stopped = this.store.transitionOwned(sessionId, id, (current) => {
      if (current.status === "stopped") return current;
      if (current.status !== "generating") {
        throw new DiscussionInvalidStateError();
      }

      return {
        ...current,
        status: "stopped",
        terminalReason: "stop",
        updatedAt: this.now().toISOString(),
      };
    });

    if (!stopped) return null;

    const active = this.activeGenerations.get(id);
    if (active?.ownerSessionId === sessionId) {
      this.abortPersistedGeneration(active, stopped.terminalReason ?? "stop");
    }

    return stopped;
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
          terminalReason: null,
          updatedAt: this.now().toISOString(),
        };
      },
    );

    if (!generating) return null;

    const active = this.createActiveGeneration(sessionId, id, signal);
    const turn = generating.turnCount + 1;
    const speaker = speakerForTurn(turn);
    const generationTranscript = selectGenerationTranscript(
      generating.transcript,
    );

    try {
      const generated = active.controller.signal.aborted
        ? active.cancellation
        : this.discussion.generateTurn({
            topic: generating.topic,
            speaker,
            transcript: generationTranscript,
            signal: active.controller.signal,
          });
      const generatedResult = GeneratedDiscussionTurnSchema.safeParse(
        await Promise.race([generated, active.cancellation]),
      );

      if (active.controller.signal.aborted) {
        throw cancellationError(active.reason ?? "disconnect");
      }
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
            active.controller.signal.aborted ||
            current.status !== "generating" ||
            current.turnCount !== turn - 1
          ) {
            throw new DiscussionInvalidStateError();
          }

          return {
            ...current,
            status: turn === current.turnLimit ? "completed" : "idle",
            terminalReason: null,
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
      if (active.reason === "timeout") {
        throw new DiscussionGenerationTimeoutError();
      }
      if (active.reason === "stop" || active.reason === "disconnect") {
        throw new DiscussionStoppedError();
      }

      this.markGeneratingAsFailed(sessionId, id);
      if (isRunnerError(error)) throw error;
      throw new DiscussionGenerationFailedError();
    } finally {
      this.releaseActiveGeneration(active);
    }
  }

  private createActiveGeneration(
    ownerSessionId: string,
    discussionId: string,
    disconnectSignal?: AbortSignal,
  ): ActiveGeneration {
    const controller = new AbortController();
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const active: ActiveGeneration = {
      ownerSessionId,
      discussionId,
      controller,
      cancellation,
      rejectCancellation,
      reason: null,
      ...(disconnectSignal ? { disconnectSignal } : {}),
    };

    active.timeout = setTimeout(() => {
      this.cancelActiveGeneration(active, "timeout");
    }, this.generationTimeoutMs);
    if (disconnectSignal) {
      active.onDisconnect = () => {
        this.cancelActiveGeneration(active, "disconnect");
      };
      disconnectSignal.addEventListener("abort", active.onDisconnect, {
        once: true,
      });
    }
    this.activeGenerations.set(discussionId, active);

    if (disconnectSignal?.aborted) {
      this.cancelActiveGeneration(active, "disconnect");
    }

    return active;
  }

  private cancelActiveGeneration(
    active: ActiveGeneration,
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">,
  ): void {
    if (this.activeGenerations.get(active.discussionId) !== active) return;

    const terminal = this.store.transitionOwned(
      active.ownerSessionId,
      active.discussionId,
      (current) => {
        if (current.status !== "generating") return current;

        return {
          ...current,
          status: reason === "timeout" ? "failed" : "stopped",
          terminalReason: reason,
          updatedAt: this.now().toISOString(),
        };
      },
    );

    if (terminal?.terminalReason === reason) {
      this.abortPersistedGeneration(active, reason);
    }
  }

  private abortPersistedGeneration(
    active: ActiveGeneration,
    reason: DiscussionTerminalReason,
  ): void {
    if (active.reason === null) {
      active.reason = reason;
      active.rejectCancellation(cancellationError(reason));
    }
    active.controller.abort();
  }

  private releaseActiveGeneration(active: ActiveGeneration): void {
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    if (active.disconnectSignal && active.onDisconnect) {
      active.disconnectSignal.removeEventListener("abort", active.onDisconnect);
    }
    if (this.activeGenerations.get(active.discussionId) === active) {
      this.activeGenerations.delete(active.discussionId);
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
        terminalReason: null,
        updatedAt: this.now().toISOString(),
      };
    });
  }
}
