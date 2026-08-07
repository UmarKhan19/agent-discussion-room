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
  DiscussionGenerationOutputLimitError,
  GeneratedDiscussionTurnSchema,
  type Discussion,
} from "./discussion";

import {
  noopTelemetry,
  type DiscussionTelemetry,
  type TelemetryEvent,
} from "@/observability/telemetry";

export { DiscussionGenerationOutputLimitError } from "./discussion";
import {
  DEFAULT_DISCUSSION_BUDGETS,
  DiscussionBudgetSchema,
  type DiscussionBudgets,
} from "./budgets";
import type {
  DiscussionStore,
  TurnFailure,
  TurnMutationResult,
} from "./discussion-service";
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

/** The process-wide simultaneous-generation ceiling is already in use. */
export class DiscussionGenerationCapacityError extends Error {
  constructor() {
    super("Discussion generation capacity is exhausted");
    this.name = "DiscussionGenerationCapacityError";
  }
}

/** The owning session has claimed its configured generation quota. */
export class DiscussionSessionQuotaExceededError extends Error {
  constructor() {
    super("Discussion session generation quota exceeded");
    this.name = "DiscussionSessionQuotaExceededError";
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
  /**
   * Server-owned generation budgets. Values merge over the safe defaults
   * and are validated against the hard maximums; the client cannot submit
   * any budget.
   */
  budgets?: Partial<DiscussionBudgets>;
  /** Privacy-safe operational telemetry; defaults to a no-op recorder. */
  telemetry?: DiscussionTelemetry;
}

/**
 * Process-wide generation capacity. Only claimed generation work holds a
 * slot; replays, duplicates, and requests rejected before claim do not.
 */
class GenerationCapacity {
  private inUse = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.inUse >= this.max) return false;
    this.inUse += 1;
    return true;
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
  }
}

interface ActiveGeneration {
  ownerSessionId: string;
  discussionId: string;
  requestId: string;
  attemptId: string;
  turn: number;
  /** Monotonic clock reading when this generation was claimed. */
  startedAt: number;
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
  if (error instanceof DiscussionGenerationOutputLimitError) {
    return { kind: "output_limit_exceeded", retryable: false };
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
    case "output_limit_exceeded":
      return new DiscussionGenerationOutputLimitError();
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
  private readonly budgets: DiscussionBudgets;
  private readonly telemetry: DiscussionTelemetry;
  private readonly capacity: GenerationCapacity;
  private readonly activeGenerations = new Map<string, ActiveGeneration>();
  /**
   * Session -> generation charge keys. A key is `discussionId/requestId`, so
   * reusing one request identity across Discussions charges each Discussion
   * separately while a retry of the same identity in the same Discussion is
   * charged at most once. Replays, conflicts, and rejected duplicates never
   * charge.
   */
  private readonly chargedGenerationKeys = new Map<string, Set<string>>();

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
    this.budgets = DiscussionBudgetSchema.parse({
      ...DEFAULT_DISCUSSION_BUDGETS,
      ...options.budgets,
    });
    this.telemetry = options.telemetry ?? noopTelemetry;
    this.capacity = new GenerationCapacity(
      this.budgets.maxConcurrentGenerations,
    );
  }

  async stop(ownerSessionId: string, discussionId: string): Promise<DiscussionState | null> {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const id = DiscussionIdentifierSchema.parse(discussionId);
    const stopped = await this.store.stopOwned(
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

    // Quota guard: charged before any generation starts, and only once per
    // (Discussion, request identity) pair. Replayed, in-flight, and rejected
    // duplicate requests are already charged or never claim, so they are not
    // blocked and never double charge; reusing an identity in a fresh
    // Discussion still counts against the session quota.
    const chargeKey = `${id}/${stableRequestId}`;
    const sessionCharges =
      this.chargedGenerationKeys.get(sessionId) ?? new Set<string>();
    if (
      !sessionCharges.has(chargeKey) &&
      sessionCharges.size >= this.budgets.sessionGenerationQuota
    ) {
      throw new DiscussionSessionQuotaExceededError();
    }

    // Capacity guard: only requests that can start a fresh generation
    // reserve a process-wide slot. Observing a prior outcome (replay,
    // conflict, non-retryable failure) never reserves capacity.
    const status = await this.store.requestStatus(sessionId, id, stableRequestId);
    const needsCapacity =
      status.kind === "unknown" ||
      (status.kind === "failed" && status.retryable);
    const capacityHeld = needsCapacity && this.capacity.tryAcquire();
    if (needsCapacity && !capacityHeld) {
      throw new DiscussionGenerationCapacityError();
    }

    try {
      const claim = await this.store.claimTurn({
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
          sessionCharges.add(chargeKey);
          this.chargedGenerationKeys.set(sessionId, sessionCharges);
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
      const generationTranscript = this.selectGenerationTranscript(
        generating.transcript,
      );

      try {
        const generated = active.controller.signal.aborted
          ? active.cancellation
          : this.discussion.generateTurn({
              topic: generating.topic,
              turn,
              speaker,
              transcript: generationTranscript,
              signal: active.controller.signal,
              maxOutputTokens: this.budgets.maxOutputTokens,
              maxOutputCharacters: this.budgets.maxOutputCharacters,
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
        if (
          generatedResult.data.content.length >
          this.budgets.maxOutputCharacters
        ) {
          throw new DiscussionGenerationOutputLimitError();
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

        const completed = await this.store.completeTurn({
          ownerSessionId: sessionId,
          discussionId: id,
          requestId: stableRequestId,
          attemptId: claim.attemptId,
          expectedTurn: turn,
          message: messageResult.data,
          updatedAt: timestamp,
        });
        if (completed.kind === "updated") {
          this.generationTelemetry(active, {
            outcome: "success",
            model: generatedResult.data.model,
            usage: generatedResult.data.usage,
            completed: completed.discussion.status === "completed",
          });
          return completed.discussion;
        }
        if (completed.kind === "stale") {
          throw errorForTerminalState(completed.discussion) ??
            new DiscussionInvalidStateError();
        }
        throw new DiscussionInvalidGeneratedTurnError();
      } catch (error) {
        if (active.reason === "timeout") {
          this.generationTelemetry(active, {
            outcome: "cancelled",
            errorClass: "GENERATION_TIMEOUT",
            cancellationReason: "timeout",
          });
          throw new DiscussionGenerationTimeoutError();
        }
        if (active.reason === "stop" || active.reason === "disconnect") {
          this.generationTelemetry(active, {
            outcome: "cancelled",
            errorClass: "DISCUSSION_STOPPED",
            cancellationReason: active.reason,
          });
          throw new DiscussionStoppedError();
        }

        const failure = failureForError(error);
        const failed = await this.store.failTurn({
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
        this.generationTelemetry(
          active,
          this.generationTelemetryForFailure(failure),
        );
        throw errorForFailure(failure);
      } finally {
        this.releaseActiveGeneration(active);
      }
    } finally {
      // Reserved capacity is released on every path: completion, failure,
      // timeout, Stop, disconnect, late results, and claims that turned out
      // to be replays or conflicts.
      if (capacityHeld) this.capacity.release();
    }
  }

  private selectGenerationTranscript(
    transcript: DiscussionState["transcript"],
  ): DiscussionState["transcript"] {
    const selected = [] as DiscussionState["transcript"];
    let characterCount = 0;

    for (
      let index = transcript.length - 1;
      index >= 0 && selected.length < this.budgets.recentTranscriptTurns;
      index -= 1
    ) {
      const message = transcript[index];
      if (!message) continue;
      if (
        characterCount + message.content.length >
        this.budgets.transcriptCharacterBudget
      ) {
        break;
      }

      selected.unshift(message);
      characterCount += message.content.length;
    }

    return selected;
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
      startedAt: performance.now(),
      controller,
      cancellation,
      rejectCancellation,
      reason: null,
      ...(input.disconnectSignal
        ? { disconnectSignal: input.disconnectSignal }
        : {}),
    };

    active.timeout = setTimeout(() => {
      void this.cancelActiveGeneration(active, "timeout");
    }, this.budgets.generationTimeoutMs);
    if (input.disconnectSignal) {
      active.onDisconnect = () => {
        void this.cancelActiveGeneration(active, "disconnect");
      };
      input.disconnectSignal.addEventListener("abort", active.onDisconnect, {
        once: true,
      });
    }
    this.activeGenerations.set(input.discussionId, active);

    if (input.disconnectSignal?.aborted) {
      void this.cancelActiveGeneration(active, "disconnect");
    }

    return active;
  }

  private async cancelActiveGeneration(
    active: ActiveGeneration,
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">,
  ): Promise<void> {
    if (this.activeGenerations.get(active.discussionId) !== active) return;

    let terminal: TurnMutationResult;
    try {
      terminal = await this.store.cancelTurn({
        ownerSessionId: active.ownerSessionId,
        discussionId: active.discussionId,
        requestId: active.requestId,
        attemptId: active.attemptId,
        expectedTurn: active.turn,
        reason,
        updatedAt: this.now().toISOString(),
      });
    } catch {
      // The store could not record the cancellation. The in-flight Turn is
      // left running; its own completion path will surface the store failure
      // to the participant instead of crashing the process. The failure is
      // reported through structured telemetry only — never the raw error,
      // which could carry provider payloads.
      this.generationTelemetry(active, {
        outcome: "failure",
        errorClass: "INTERNAL",
        retryable: true,
      });
      return;
    }

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

  /**
   * Records one generation-level telemetry event bound to the active
   * generation's request identity, Turn, and elapsed duration. Only
   * identifier, outcome, and metadata fields are ever passed — never the
   * Topic, Transcript, prompt, output, or provider payload.
   */
  private generationTelemetry(
    active: ActiveGeneration,
    partial: Omit<
      Extract<TelemetryEvent, { event: "generation" }>,
      "event" | "operation" | "durationMs" | "turn" | "requestId" | "discussionId"
    >,
  ): void {
    this.telemetry.record({
      event: "generation",
      operation: "next-turn",
      durationMs: performance.now() - active.startedAt,
      turn: active.turn,
      requestId: active.requestId,
      discussionId: active.discussionId,
      ...partial,
    });
  }

  private generationTelemetryForFailure(
    failure: TurnFailure,
  ): Omit<
    Extract<TelemetryEvent, { event: "generation" }>,
    "event" | "operation" | "durationMs" | "turn" | "requestId" | "discussionId"
  > {
    switch (failure.kind) {
      case "output_blocked":
        return {
          outcome: "failure",
          errorClass: "OUTPUT_BLOCKED",
          category: failure.category,
        };
      case "invalid_response":
        return { outcome: "failure", errorClass: "INVALID_RESPONSE" };
      case "output_limit_exceeded":
        return {
          outcome: "failure",
          errorClass: "OUTPUT_LIMIT_EXCEEDED",
        };
      case "generation_failed":
        return {
          outcome: "failure",
          errorClass: "GENERATION_FAILED",
          retryable: failure.retryable,
        };
      case "timeout":
        return {
          outcome: "cancelled",
          errorClass: "GENERATION_TIMEOUT",
          cancellationReason: "timeout",
        };
      case "stopped":
        return {
          outcome: "cancelled",
          errorClass: "DISCUSSION_STOPPED",
          cancellationReason: "stop",
        };
    }
  }
}
