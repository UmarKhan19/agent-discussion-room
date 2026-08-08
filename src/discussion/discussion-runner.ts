import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  SYNTHESIS_REQUEST_ID,
  SynthesisContentSchema,
  speakerForTurn,
  type DiscussionState,
  type DiscussionTerminalReason,
  type PolicyCategory,
  type SynthesisContent,
  type SynthesisFailure,
} from "./contracts";
import {
  DiscussionGenerationError,
  DiscussionGenerationOutputLimitError,
  GeneratedDiscussionTurnSchema,
  GeneratedSynthesisSchema,
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
  ClaimTurnResult,
  DiscussionStore,
  TurnFailure,
  TurnMutationResult,
} from "./discussion-service";
import { DiscussionStorageUnavailableError } from "./discussion-service";
import {
  DiscussionOutputPolicy,
  type DiscussionOutputPolicyEvaluator,
} from "./policy";
import { SessionGenerationQuota } from "./quota";

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
  constructor(readonly retryAfterSeconds: number) {
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
  /** Whether this is an ordinary Turn generation or the completion synthesis. */
  kind: "turn" | "synthesis";
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

/**
 * Parses and validates the raw provider synthesis output as structured
 * content. The provider is not trusted with the persisted shape: malformed
 * JSON, wrong types, or over-budget fields fail validation and are reported
 * as a non-retryable `invalid_response` failure.
 */
function parseSynthesisContent(content: string): SynthesisContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DiscussionInvalidGeneratedTurnError();
  }
  const result = SynthesisContentSchema.safeParse(parsed);
  if (!result.success) throw new DiscussionInvalidGeneratedTurnError();
  return result.data;
}

/** Classifies any generation error into the closed synthesis failure set. */
function synthesisFailureForError(error: unknown): SynthesisFailure {
  if (error instanceof DiscussionOutputPolicyBlockedError) {
    return {
      kind: "output_blocked",
      retryable: false,
      category: error.category,
    };
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
  if (error instanceof DiscussionInvalidGeneratedTurnError) {
    return { kind: "invalid_response", retryable: false };
  }
  return { kind: "generation_failed", retryable: false };
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
   * Time-windowed per-session quota tracker. A Turn charge key is
   * `discussionId/requestId`, so reusing one request identity across
   * Discussions charges each Discussion separately while a retry of the
   * same identity in the same Discussion is charged at most once. The one
   * completion synthesis per naturally completed Discussion is a separate
   * provider generation with its own key (`discussionId/synthesis`) and is
   * charged exactly once per Discussion; synthesis retries reuse that key
   * and never double-charge. Replays, conflicts, and rejected duplicates
   * never charge. Expired windows and abandoned sessions are reclaimed
   * automatically; see `SessionGenerationQuota`.
   */
  private readonly quota: SessionGenerationQuota;

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
    this.quota = new SessionGenerationQuota(
      this.budgets.sessionGenerationQuota,
      this.budgets.sessionGenerationQuotaWindowMs,
      () => this.now().getTime(),
    );
  }

  /** Number of sessions tracked by the generation quota; a diagnostics aid. */
  get quotaSize(): number {
    return this.quota.size;
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

    // Quota guard: checked before any generation starts as an advisory
    // fast-path, and charged only once per (Discussion, request identity)
    // pair — and only after generation capacity has been acquired. The
    // charge itself (`attemptCharge`) is the authoritative mutation: it
    // atomically re-validates the session's window state, so two concurrent
    // requests that both passed the early check can never over-commit the
    // final quota slot. Replayed, in-flight, and rejected duplicate
    // requests are already charged or never claim, so they are not blocked
    // and never double charge; reusing an identity in a fresh Discussion
    // still counts against the session quota. The quota is time-windowed:
    // an exhausted session recovers after its window elapses, making "try
    // again later" truthful.
    const chargeKey = `${id}/${stableRequestId}`;
    const quotaCheck = this.quota.check(sessionId, chargeKey);
    if (quotaCheck.kind === "exhausted") {
      throw new DiscussionSessionQuotaExceededError(
        quotaCheck.retryAfterSeconds,
      );
    }

    // Capacity guard: the claim result is the only authoritative signal
    // that this process will start new provider work, and the slot is
    // reserved from it. A pre-claim status hint can go stale: an attempt
    // observed as generating with a valid lease may have its lease expire,
    // be recovered by another instance, and then be claimed (as a retry)
    // by this request before `claimTurn` runs — a hint-based guard could
    // therefore let a fresh generation start without a slot. Observing a
    // prior outcome (replay, conflict, non-retryable failure) never
    // reserves capacity, because no claim — and so no provider work —
    // occurs.
    const claim = await this.store.claimTurn({
      ownerSessionId: sessionId,
      discussionId: id,
      requestId: stableRequestId,
      attemptId,
      updatedAt: this.now().toISOString(),
    });

    let capacityHeld = false;
    /** Completed Discussion whose synthesis must be generated after the Turn slot is released. */
    let completedForSynthesis: DiscussionState | null = null;
    try {
      switch (claim.kind) {
        case "not_found":
          return null;
        case "replay":
          // A replay of a succeeded request observes the authoritative
          // outcome. The completion synthesis is a distinct server-owned
          // operation with its own retry seam (`retrySynthesis` / the
          // synthesis endpoint): replaying a Turn request never triggers,
          // resumes, or regenerates the synthesis, and the HTTP request
          // identity that happened to commit the final debate Turn is never
          // required to recover a failed or missing synthesis.
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

      if (!this.capacity.tryAcquire()) {
        // The durable claim must not be abandoned: resolve it into the
        // same retryable failed state recovery produces, so the Turn is
        // not stranded until lease expiry and a later retry can claim it.
        // Quota is never charged for an attempt that did not generate.
        // A storage-unavailability failure here is propagated (not
        // swallowed) so it surfaces as STORAGE_UNAVAILABLE instead of a
        // capacity rejection; see `resolveUnstartedClaim`.
        await this.resolveUnstartedClaim(
          sessionId,
          id,
          stableRequestId,
          claim,
        );
        throw new DiscussionGenerationCapacityError();
      }
      capacityHeld = true;

      // Authoritative quota decision, made only once capacity is held so
      // a request rejected for lack of capacity never consumes quota. If
      // the final slot was taken by a concurrent request after the early
      // check passed, the durable claim is reconciled (never abandoned)
      // and the caller receives the quota error: the Turn is not stranded
      // in `generating` until lease expiry, a later retry can claim it
      // once the window resets, and no quota or capacity is left held.
      const chargeOutcome = this.quota.attemptCharge(sessionId, chargeKey);
      if (chargeOutcome.kind === "quotaExceeded") {
        await this.resolveUnstartedClaim(
          sessionId,
          id,
          stableRequestId,
          claim,
        );
        throw new DiscussionSessionQuotaExceededError(
          chargeOutcome.retryAfterSeconds,
        );
      }

      const generating = claim.discussion;
      const turn = claim.turn;
      const active = this.createActiveGeneration({
        kind: "turn",
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
          if (completed.discussion.status === "completed") {
            // The final debate Turn committed. The debate Transcript is now
            // durable; the synthesis is the server-owned completion step and
            // runs after the Turn's capacity slot is released below, so the
            // two generations never double-count the same slot.
            completedForSynthesis = completed.discussion;
          } else {
            return completed.discussion;
          }
        } else if (completed.kind === "stale") {
          throw errorForTerminalState(completed.discussion) ??
            new DiscussionInvalidStateError();
        } else {
          throw new DiscussionInvalidGeneratedTurnError();
        }
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

        // Storage unavailable: the authoritative persisted state could not
        // be updated. Do not convert the outage into a Turn failure and do
        // not attempt to persist one while the store is down: the attempt
        // keeps its recovery lease and is reclaimed through the normal
        // recovery path, so a retry of the same request identity can never
        // duplicate a committed Turn. The caller surfaces the stable
        // storage error.
        if (error instanceof DiscussionStorageUnavailableError) {
          throw error;
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

    if (completedForSynthesis !== null) {
      return this.completeWithSynthesis(
        sessionId,
        id,
        SYNTHESIS_REQUEST_ID,
        completedForSynthesis,
      );
    }
    // Defensive: every Turn path above returns or throws.
    throw new DiscussionInvalidGeneratedTurnError();
  }

  /**
   * Resolves a freshly claimed attempt that cannot start provider work —
   * because the process-wide capacity slot was unavailable, or because the
   * authoritative quota charge was rejected by a concurrent request — into
   * the same retryable failed state recovery produces for an abandoned
   * attempt. The Turn is not stranded for the lease duration, and a later
   * retry can claim it (once capacity frees up, or once the quota window
   * resets). Quota is never charged on this path: the attempt never
   * generated.
   *
   * Reconciliation is best-effort for non-storage failures: if the store
   * cannot record the resolution for a transient reason other than an
   * outage, the attempt's lease will expire and recovery will reconcile it,
   * and the caller still receives the capacity/quota error.
   *
   * A storage-unavailability failure is authoritative, not best-effort: the
   * persisted lifecycle state could not be updated, so swallowing it would
   * misreport the outcome as a capacity/quota rejection. It is propagated
   * so the request surfaces as `500 STORAGE_UNAVAILABLE`; the attempt
   * keeps its recovery lease and is reconciled through the normal
   * lease/recovery path, so a retry of the same request identity can never
   * duplicate a committed Turn.
   */
  private async resolveUnstartedClaim(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
    claim: Extract<ClaimTurnResult, { kind: "claimed" }>,
  ): Promise<void> {
    try {
      await this.store.failTurn({
        ownerSessionId,
        discussionId,
        requestId,
        attemptId: claim.attemptId,
        expectedTurn: claim.turn,
        failure: { kind: "generation_failed", retryable: true },
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      // Storage unavailable is authoritative: the persisted lifecycle state
      // could not be updated, so it must surface as STORAGE_UNAVAILABLE
      // rather than be disguised as a capacity/quota rejection. Propagate
      // it; the attempt keeps its recovery lease and is reconciled via
      // recovery.
      if (error instanceof DiscussionStorageUnavailableError) {
        throw error;
      }

      // Best-effort resolution for any other failure; lease-expiry recovery
      // reconciles the attempt if the store could not record this failure.
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

  /**
   * Selects the Transcript provided as synthesis context. Unlike the
   * per-Turn recent window this is normally the WHOLE debate: the synthesis
   * must weigh the strongest case for and against, so a truncated window
   * would bias it. Only an unusually verbose debate falls back to a bounded
   * newest-first selection.
   */
  private selectSynthesisTranscript(
    transcript: DiscussionState["transcript"],
  ): DiscussionState["transcript"] {
    if (
      transcript.reduce((sum, message) => sum + message.content.length, 0) <=
      this.budgets.synthesisTranscriptCharacterBudget
    ) {
      return transcript;
    }
    const selected = [] as DiscussionState["transcript"];
    let characterCount = 0;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const message = transcript[index];
      if (!message) continue;
      if (
        characterCount + message.content.length >
        this.budgets.synthesisTranscriptCharacterBudget
      ) {
        break;
      }
      selected.unshift(message);
      characterCount += message.content.length;
    }
    return selected;
  }

  /**
   * Server-owned completion step: produces the neutral synthesis of a
   * naturally completed Discussion, in-band with the final Turn POST (and,
   * through the same method, the dedicated synthesis retry seam). The
   * debate is already committed and durable (the caller passes the persisted
   * `completed` state), so every failure path — capacity rejection, quota
   * denial, provider failure, invalid output, policy block, output-limit,
   * timeout, or a concurrent retry taking over — returns an authoritative
   * state instead of throwing. Only storage failures propagate, so the
   * client can never lose the committed debate.
   */
  private async completeWithSynthesis(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
    completed: DiscussionState,
  ): Promise<DiscussionState | null> {
    const attemptId = RequestIdentifierSchema.parse(this.createAttemptId());
    // One transactional claim: an expired lease from a dead attempt is
    // recovered to retryable-failed and re-claimed inside the store
    // transaction, so the participant is never stranded until restart and a
    // stale late result from the dead attempt can never commit.
    const claimed = await this.store.claimSynthesis({
      ownerSessionId,
      discussionId,
      attemptId,
      updatedAt: this.now().toISOString(),
    });

    // A live attempt exists (another tab's in-band final Turn, or a
    // still-valid lease from before a restart): observe it and return the
    // current state; the participant polls or the request replays.
    if (claimed.kind === "in_progress") return claimed.discussion;
    if (claimed.kind === "already_present" || claimed.kind === "invalid_state") {
      return claimed.discussion;
    }
    if (claimed.kind === "not_found") return null;
    if (claimed.kind !== "claimed") {
      throw new DiscussionInvalidStateError();
    }

    if (!this.capacity.tryAcquire()) {
      // Capacity is per-instance: an honest rejection is reconciled into the
      // same retryable failure recovery would produce, so the browser's
      // retry resumes the synthesis without replaying the debate Turn.
      const failure: SynthesisFailure = {
        kind: "generation_failed",
        retryable: true,
      };
      const failed = await this.store.failSynthesis({
        ownerSessionId,
        discussionId,
        attemptId,
        failure,
        updatedAt: this.now().toISOString(),
      });
      if (failed.kind === "stale") return failed.discussion;
      if (failed.kind === "not_found") return null;
      return failed.discussion;
    }

    // Authoritative quota charge, made only once capacity is held and
    // immediately before provider work starts, mirroring the Turn path: a
    // capacity-rejected attempt never charges. The synthesis is a provider
    // generation like any Turn, so the one logical synthesis per Discussion
    // consumes one quota unit under the dedicated charge key
    // `discussionId/synthesis` — deliberately not a Turn request key, so a
    // client-supplied request identity can never collide with it and make
    // the synthesis appear already-charged. The same key is reused by every
    // attempt and retry of the logical synthesis, so HTTP retries, replays,
    // concurrent retries, and crash recovery are charged at most once. When
    // the window is exhausted, the fresh claim is reconciled into the same
    // retryable failed state recovery produces: the completed debate stays
    // intact, no provider work begins, and a retry after the window resets
    // charges the key from the fresh window and generates.
    const chargeOutcome = this.quota.attemptCharge(
      ownerSessionId,
      `${discussionId}/synthesis`,
    );
    if (chargeOutcome.kind === "quotaExceeded") {
      try {
        const failed = await this.store.failSynthesis({
          ownerSessionId,
          discussionId,
          attemptId,
          failure: { kind: "generation_failed", retryable: true },
          updatedAt: this.now().toISOString(),
        });
        if (failed.kind === "stale") return failed.discussion;
        if (failed.kind === "not_found") return null;
        return failed.discussion;
      } finally {
        // The slot is released on every path out of the quota denial,
        // including a storage-unavailability error during reconciliation
        // (which propagates and keeps the attempt's recovery lease).
        this.capacity.release();
      }
    }

    const active = this.createActiveGeneration({
      kind: "synthesis",
      ownerSessionId,
      discussionId,
      requestId,
      attemptId,
      turn: completed.turnCount,
    });
    try {
      const synthesisContext = this.selectSynthesisTranscript(
        completed.transcript,
      );
      const generationPromise = this.discussion.generateSynthesis({
        topic: completed.topic,
        transcript: synthesisContext,
        signal: active.controller.signal,
        maxOutputTokens: this.budgets.maxOutputTokens,
        maxOutputCharacters: this.budgets.maxOutputCharacters,
      });
      const generated = await Promise.race([
        generationPromise,
        active.cancellation,
      ]);
      if (active.controller.signal.aborted) {
        throw cancellationError(active.reason ?? "disconnect");
      }

      const parsed = GeneratedSynthesisSchema.safeParse(generated);
      if (!parsed.success) {
        throw new DiscussionGenerationError(
          "Discussion adapter returned an invalid synthesis payload",
        );
      }
      const content = parseSynthesisContent(parsed.data.content);
      const policyText = [
        content.strongestSupport,
        content.strongestOpposition,
        ...content.agreements,
        content.unresolved,
        ...content.claimsToVerify,
        content.takeaway,
      ].join("\n");
      // The synthesis rides the same output policy as every generated Turn:
      // any structured field that violates it blocks the whole synthesis.
      const policyOutcome = this.outputPolicy.evaluate(policyText);
      if (policyOutcome.decision === "blocked") {
        await this.store.failSynthesis({
          ownerSessionId,
          discussionId,
          attemptId,
          failure: {
            kind: "output_blocked",
            retryable: false,
            category: policyOutcome.category,
          },
          updatedAt: this.now().toISOString(),
        });
        this.generationTelemetry(active, {
          outcome: "failure",
          errorClass: "OUTPUT_BLOCKED",
          category: policyOutcome.category,
        });
        return this.requireOrNull(ownerSessionId, discussionId);
      }

      const committed = await this.store.completeSynthesis({
        ownerSessionId,
        discussionId,
        attemptId,
        content,
        ...(parsed.data.usage === undefined
          ? {}
          : { usage: parsed.data.usage }),
        outputPolicyOutcome: policyOutcome,
        updatedAt: this.now().toISOString(),
      });
      this.generationTelemetry(active, {
        outcome: "success",
        model: parsed.data.model,
        usage: parsed.data.usage,
      });
      if (committed.kind === "stale") return committed.discussion;
      if (committed.kind === "not_found") return null;
      return committed.discussion;
    } catch (error) {
      if (active.reason === "timeout") {
        // The hard timeout already persisted a synthesis failure; return the
        // authoritative state instead of a second, misleading error.
        this.synthesisTelemetryForFailure(active, "cancelled", error);
        return this.requireOrNull(ownerSessionId, discussionId);
      }
      if (active.reason === "stop") {
        throw new DiscussionStoppedError();
      }
      // Synthesis ignores client disconnect (the debate is already durable
      // and the synthesis must still commit), and a disconnect signal is
      // never wired to a synthesis attempt. Other failures (provider
      // errors, invalid output, output-limit) fold into the persisted
      // synthesis failure so a retry resumes the synthesis — never the
      // debate Turn.
      const failure = synthesisFailureForError(error);
      const persisted = await this.store.failSynthesis({
        ownerSessionId,
        discussionId,
        attemptId,
        failure,
        updatedAt: this.now().toISOString(),
      });
      if (persisted.kind === "stale") {
        this.synthesisTelemetryForFailure(active, "failure", error);
        return persisted.discussion;
      }
      if (persisted.kind === "not_found") return null;
      this.synthesisTelemetryForFailure(active, "failure", error);
      return persisted.discussion;
    } finally {
      // Synthesis capacity is released on every path: commit, failure,
      // timeout, policy block, and stale results.
      this.capacity.release();
    }
  }

  private async requireOrNull(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    return this.store.readOwned(ownerSessionId, discussionId);
  }

  /**
   * Resumes or retries the one logical synthesis of a naturally completed
   * Discussion, driven entirely by durable state: the signed session
   * establishes ownership, the Discussion id identifies the resource, and
   * the persisted `synthesis` sub-state decides the outcome. The caller
   * never supplies a Turn request identity, so recovering a failed or
   * missing synthesis does not depend on the browser retaining the HTTP
   * request that happened to commit the final debate Turn — a fresh tab
   * with only the canonical Discussion URL and the ownership cookie works.
   *
   * Outcomes (delegated to `completeWithSynthesis`):
   * - missing or retryable-failed synthesis: a fresh attempt is claimed and
   *   the synthesis is generated;
   * - generating with a valid lease: the current state is returned and no
   *   duplicate generation starts;
   * - completed: the committed synthesis is returned and nothing is
   *   regenerated;
   * - failed non-retryable: the state is returned and retry stays
   *   disallowed.
   *
   * Returns `null` when the caller does not own the Discussion; throws
   * `DiscussionInvalidStateError` when the Discussion is not naturally
   * debate-completed (synthesis retry must not be permitted there).
   */
  async retrySynthesis(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const id = DiscussionIdentifierSchema.parse(discussionId);
    const discussion = await this.store.readOwned(sessionId, id);
    if (!discussion) return null;
    if (discussion.status !== "completed") {
      throw new DiscussionInvalidStateError();
    }
    return this.completeWithSynthesis(
      sessionId,
      id,
      SYNTHESIS_REQUEST_ID,
      discussion,
    );
  }

  private createActiveGeneration(input: {
    kind?: "turn" | "synthesis";
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
      kind: input.kind ?? "turn",
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
      terminal =
        active.kind === "turn"
          ? await this.store.cancelTurn({
              ownerSessionId: active.ownerSessionId,
              discussionId: active.discussionId,
              requestId: active.requestId,
              attemptId: active.attemptId,
              expectedTurn: active.turn,
              reason,
              updatedAt: this.now().toISOString(),
            })
          : // The synthesis is never "stopped" and ignores client disconnect;
            // the only server-initiated cancellation is the hard timeout,
            // which folds into the persisted synthesis failure exactly like
            // any other generation failure.
            await this.store.failSynthesis({
              ownerSessionId: active.ownerSessionId,
              discussionId: active.discussionId,
              attemptId: active.attemptId,
              failure:
                reason === "timeout"
                  ? { kind: "timeout", retryable: false }
                  : { kind: "generation_failed", retryable: false },
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
        return;
      }
      if (active.kind === "synthesis") {
        // A concurrent retry replaced this attempt. Retire it: the late
        // provider result will be rejected as stale by the attempt guard,
        // and the driver returns the authoritative committed state.
        this.abortPersistedGeneration(active, "timeout");
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
      operation: active.kind === "synthesis" ? "synthesis" : "next-turn",
      durationMs: performance.now() - active.startedAt,
      ...(active.kind === "turn" ? { turn: active.turn } : {}),
      requestId: active.requestId,
      discussionId: active.discussionId,
      ...partial,
    });
  }

  /** Telemetry for a synthesis that failed without a committed content result. */
  private synthesisTelemetryForFailure(
    active: ActiveGeneration,
    outcome: Extract<
      TelemetryEvent,
      { event: "generation" }
    >["outcome"],
    error: unknown,
  ): void {
    // Classified into the closed telemetry vocabulary only — never the raw
    // error message, which is outside the strict schema (and could carry
    // provider payloads). A synthesis timeout mirrors the Turn timeout
    // classification. Records must validate against the strict telemetry
    // schema or they are dropped by the sink before they reach operators.
    const failure = synthesisFailureForError(error);
    const isTimeout = active.reason === "timeout";
    this.generationTelemetry(active, {
      outcome,
      errorClass: isTimeout
        ? "GENERATION_TIMEOUT"
        : failure.kind === "output_blocked"
          ? "OUTPUT_BLOCKED"
          : failure.kind === "output_limit_exceeded"
            ? "OUTPUT_LIMIT_EXCEEDED"
            : failure.kind === "invalid_response"
              ? "INVALID_RESPONSE"
              : "GENERATION_FAILED",
      ...(!isTimeout && failure.kind === "output_blocked"
        ? { category: failure.category }
        : {}),
      ...(!isTimeout && failure.kind === "generation_failed"
        ? { retryable: failure.retryable }
        : {}),
      ...(isTimeout ? { cancellationReason: "timeout" as const } : {}),
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
