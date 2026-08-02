import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  speakerForTurn,
  type DiscussionState,
  type DiscussionTerminalReason,
  type PolicyCategory,
} from "./contracts";
import {
  DiscussionGenerationError,
  GeneratedDiscussionTurnSchema,
  type Discussion,
} from "./discussion";
import type {
  DiscussionStore,
  TurnFailure,
} from "./discussion-service";
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

export class DiscussionRequestInProgressError extends Error {
  constructor() {
    super("This request identity already has an active generation");
    this.name = "DiscussionRequestInProgressError";
  }
}

export class DiscussionTurnInProgressError extends Error {
  constructor() {
    super("Another request identity already has an active generation");
    this.name = "DiscussionTurnInProgressError";
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
  constructor(readonly category: PolicyCategory) {
    super("Generated Turn was blocked by output policy");
    this.name = "DiscussionOutputPolicyBlockedError";
  }
}

export class DiscussionGenerationFailedError extends Error {
  constructor(readonly retryable: boolean) {
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
  createAttemptId?: () => string;
  generationTimeoutMs?: number;
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
  requestId: string;
  attemptId: string;
  turn: number;
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

function failureForError(error: unknown): TurnFailure {
  if (error instanceof DiscussionOutputPolicyBlockedError) {
    return {
      kind: "output_blocked",
      retryable: false,
      category: error.category,
    };
  }
  if (error instanceof DiscussionInvalidGeneratedTurnError) {
    return { kind: "invalid_response", retryable: false };
  }
  if (error instanceof DiscussionGenerationError) {
    return { kind: "generation_failed", retryable: error.retryable };
  }
  if (error instanceof DiscussionGenerationFailedError) {
    return { kind: "generation_failed", retryable: error.retryable };
  }
  return { kind: "generation_failed", retryable: false };
}

function errorForFailure(failure: TurnFailure): Error {
  switch (failure.kind) {
    case "output_blocked":
      return new DiscussionOutputPolicyBlockedError(failure.category);
    case "invalid_response":
      return new DiscussionInvalidGeneratedTurnError();
    case "timeout":
      return new DiscussionGenerationTimeoutError();
    case "stopped":
      return new DiscussionStoppedError();
    case "generation_failed":
      return new DiscussionGenerationFailedError(failure.retryable);
  }
}

function errorForTerminalState(state: DiscussionState): Error | null {
  if (state.status === "stopped") return new DiscussionStoppedError();
  if (state.status === "failed" && state.terminalReason === "timeout") {
    return new DiscussionGenerationTimeoutError();
  }
  return null;
}

/** Sole authority for next-Turn lifecycle, Speaker selection, policy, and commit. */
export class DiscussionRunner {
  private readonly store: DiscussionStore;
  private readonly discussion: Discussion;
  private readonly outputPolicy: DiscussionOutputPolicyEvaluator;
  private readonly now: () => Date;
  private readonly createMessageId: () => string;
  private readonly createAttemptId: () => string;
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
    this.createAttemptId =
      options.createAttemptId ?? (() => crypto.randomUUID());
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
    const stopped = this.store.stopOwned(
      sessionId,
      id,
      this.now().toISOString(),
    );
    if (stopped.kind === "not_found") return null;
    if (stopped.kind === "invalid_state") {
      throw new DiscussionInvalidStateError();
    }

    const active = this.activeGenerations.get(id);
    if (active?.ownerSessionId === sessionId) {
      this.abortPersistedGeneration(active, "stop");
    }
    return stopped.discussion;
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
    const attemptId = RequestIdentifierSchema.parse(this.createAttemptId());
    const claim = this.store.claimTurn({
      ownerSessionId: sessionId,
      discussionId: id,
      requestId: stableRequestId,
      attemptId,
      updatedAt: this.now().toISOString(),
    });

    switch (claim.kind) {
      case "not_found":
        return null;
      case "replay":
        return claim.discussion;
      case "request_in_progress":
        throw new DiscussionRequestInProgressError();
      case "turn_in_progress":
        throw new DiscussionTurnInProgressError();
      case "failed":
        throw errorForFailure(claim.failure);
      case "completed":
        throw new DiscussionCompletedError();
      case "invalid_state":
        throw new DiscussionInvalidStateError();
      case "claimed":
        break;
    }

    const generating = claim.discussion;
    const turn = claim.turn;
    const active = this.createActiveGeneration({
      ownerSessionId: sessionId,
      discussionId: id,
      requestId: stableRequestId,
      attemptId: claim.attemptId,
      turn,
      disconnectSignal: signal,
    });
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
        throw new DiscussionOutputPolicyBlockedError(
          outputPolicyOutcome.category,
        );
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

      const completed = this.store.completeTurn({
        ownerSessionId: sessionId,
        discussionId: id,
        requestId: stableRequestId,
        attemptId: claim.attemptId,
        expectedTurn: turn,
        message: messageResult.data,
        updatedAt: timestamp,
      });
      if (completed.kind === "updated") return completed.discussion;
      if (completed.kind === "stale") {
        throw errorForTerminalState(completed.discussion) ??
          new DiscussionInvalidStateError();
      }
      throw new DiscussionInvalidGeneratedTurnError();
    } catch (error) {
      if (active.reason === "timeout") {
        throw new DiscussionGenerationTimeoutError();
      }
      if (active.reason === "stop" || active.reason === "disconnect") {
        throw new DiscussionStoppedError();
      }

      const failure = failureForError(error);
      const failed = this.store.failTurn({
        ownerSessionId: sessionId,
        discussionId: id,
        requestId: stableRequestId,
        attemptId: claim.attemptId,
        expectedTurn: turn,
        failure,
        updatedAt: this.now().toISOString(),
      });
      if (failed.kind === "stale") {
        throw errorForTerminalState(failed.discussion) ??
          (error instanceof DiscussionInvalidStateError
            ? error
            : new DiscussionInvalidStateError());
      }
      if (failed.kind === "not_found") {
        throw new DiscussionInvalidGeneratedTurnError();
      }
      throw errorForFailure(failure);
    } finally {
      this.releaseActiveGeneration(active);
    }
  }

  private createActiveGeneration(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    turn: number;
    disconnectSignal?: AbortSignal;
  }): ActiveGeneration {
    const controller = new AbortController();
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const active: ActiveGeneration = {
      ownerSessionId: input.ownerSessionId,
      discussionId: input.discussionId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      turn: input.turn,
      controller,
      cancellation,
      rejectCancellation,
      reason: null,
      ...(input.disconnectSignal
        ? { disconnectSignal: input.disconnectSignal }
        : {}),
    };

    active.timeout = setTimeout(() => {
      this.cancelActiveGeneration(active, "timeout");
    }, this.generationTimeoutMs);
    if (input.disconnectSignal) {
      active.onDisconnect = () => {
        this.cancelActiveGeneration(active, "disconnect");
      };
      input.disconnectSignal.addEventListener("abort", active.onDisconnect, {
        once: true,
      });
    }
    this.activeGenerations.set(input.discussionId, active);

    if (input.disconnectSignal?.aborted) {
      this.cancelActiveGeneration(active, "disconnect");
    }

    return active;
  }

  private cancelActiveGeneration(
    active: ActiveGeneration,
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">,
  ): void {
    if (this.activeGenerations.get(active.discussionId) !== active) return;

    const terminal = this.store.cancelTurn({
      ownerSessionId: active.ownerSessionId,
      discussionId: active.discussionId,
      requestId: active.requestId,
      attemptId: active.attemptId,
      expectedTurn: active.turn,
      reason,
      updatedAt: this.now().toISOString(),
    });

    if (terminal.kind === "updated") {
      this.abortPersistedGeneration(active, reason);
    } else if (terminal.kind === "stale") {
      const terminalError = errorForTerminalState(terminal.discussion);
      if (terminalError instanceof DiscussionStoppedError) {
        this.abortPersistedGeneration(active, "stop");
      }
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
}
