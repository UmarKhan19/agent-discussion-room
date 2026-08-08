import { z } from "zod";
import {
  DiscussionStateSchema,
  PolicyCategorySchema,
  type AllowedPolicyOutcome,
  type DiscussionMessage,
  type DiscussionState,
  type DiscussionTerminalReason,
  type GenerationUsage,
  type SynthesisContent,
  type SynthesisFailure,
} from "./contracts";

export const TurnFailureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("generation_failed"),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal("invalid_response"), retryable: z.literal(false) })
    .strict(),
  z
    .object({
      kind: z.literal("output_blocked"),
      retryable: z.literal(false),
      category: PolicyCategorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("output_limit_exceeded"),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({ kind: z.literal("timeout"), retryable: z.literal(false) })
    .strict(),
  z
    .object({ kind: z.literal("stopped"), retryable: z.literal(false) })
    .strict(),
]);

export type TurnFailure = z.infer<typeof TurnFailureSchema>;

export type ClaimTurnResult =
  | {
      kind: "claimed";
      discussion: DiscussionState;
      turn: number;
      attemptId: string;
    }
  | { kind: "replay"; discussion: DiscussionState }
  | { kind: "request_in_progress" }
  | { kind: "turn_in_progress" }
  | { kind: "failed"; failure: TurnFailure }
  | { kind: "completed" }
  | { kind: "invalid_state" }
  | { kind: "not_found" };

export type TurnMutationResult =
  | { kind: "updated"; discussion: DiscussionState }
  | { kind: "stale"; discussion: DiscussionState }
  | { kind: "not_found" };

export type ClaimSynthesisResult =
  | { kind: "claimed"; discussion: DiscussionState }
  /** A synthesis is already committed; the caller must not generate again. */
  | { kind: "already_present"; discussion: DiscussionState }
  /** Another live attempt owns the synthesis (valid lease); observe, don't claim. */
  | { kind: "in_progress"; discussion: DiscussionState }
  /** The synthesis exists in a terminal non-retryable failure, or the state forbids one. */
  | { kind: "invalid_state"; discussion: DiscussionState }
  | { kind: "not_found" };

export type StopTurnResult =
  | { kind: "stopped"; discussion: DiscussionState }
  | { kind: "invalid_state" }
  | { kind: "not_found" };

/**
 * Non-mutating view of one request identity, used to decide whether a
 * next-Turn call can start a generation or only observe prior work.
 */
export type RequestStatusResult =
  | { kind: "succeeded" }
  | { kind: "generating" }
  | { kind: "failed"; retryable: boolean }
  | { kind: "unknown" };

export type CreateDiscussionResult =
  | { kind: "created" }
  | { kind: "replayed"; discussion: DiscussionState };

/**
 * The persistence contract between the Discussion domain and its storage
 * backends (in-memory for tests/dev, LibSQL for production). Every store
 * mutation is attempt-aware: the caller presents the attempt identity it
 * claimed, and the store refuses any mutation that does not match the
 * currently persisted attempt, so a stale late result can never commit.
 */
export interface DiscussionStore {
  /**
   * Persists a new Discussion. When `creationRequestId` is provided, the
   * (owner session, creation request identity) pair is the idempotency key:
   * a second create for an already-persisted pair replays the original
   * Discussion instead of inserting a duplicate (database-enforced, so it
   * holds across instances and restarts). Null performs a plain create for
   * legacy/test paths.
   */
  create(
    ownerSessionId: string,
    discussion: DiscussionState,
    creationRequestId?: string | null,
  ): Promise<CreateDiscussionResult>;
  readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null>;
  requestStatus(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): Promise<RequestStatusResult>;
  claimTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimTurnResult>;
  completeTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    message: DiscussionMessage;
    updatedAt: string;
  }): Promise<TurnMutationResult>;
  failTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult>;
  cancelTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">;
    updatedAt: string;
  }): Promise<TurnMutationResult>;
  stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): Promise<StopTurnResult>;
  /**
   * Claims the one logical synthesis of a completed Discussion. Exactly one
   * attempt can ever be `generating`: an existing committed synthesis is
   * `already_present`, a live attempt (valid lease) is `in_progress`, and a
   * terminal non-retryable failure is `invalid_state`. Retrying after a
   * retryable failure (or after crash recovery) claims a fresh attempt with
   * a new attempt identity, so a stale late result can never commit.
   */
  claimSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimSynthesisResult>;
  /** Commits the validated synthesis content for the exact claimed attempt. */
  completeSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    content: SynthesisContent;
    usage?: GenerationUsage;
    outputPolicyOutcome: AllowedPolicyOutcome;
    updatedAt: string;
  }): Promise<TurnMutationResult>;
  /** Records a synthesis failure for the exact claimed attempt. */
  failSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    failure: SynthesisFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult>;
}

/**
 * Optional capability of stores that persist across process restarts.
 * In-memory stores never hold state from a previous process, so they do not
 * need initialization or interrupted-generation reconciliation.
 */
export interface DurableDiscussionStore extends DiscussionStore {
  /** Creates the store schema; must complete before any other method. */
  init(): Promise<void>;
  /**
   * Reconciles Discussions whose generation attempt was abandoned: a
   * generating attempt whose recovery lease has expired (or a legacy row
   * without a lease) becomes a retryable failed state so the participant
   * can resume with the same request identity. Attempts whose lease is
   * still valid are owned by a live instance and are never recovered.
   */
  recoverInterrupted(): Promise<number>;
}

export function isDurableDiscussionStore(
  store: DiscussionStore,
): store is DurableDiscussionStore {
  return typeof (store as DurableDiscussionStore).recoverInterrupted === "function";
}

/**
 * First-class storage-unavailability error, thrown by durable stores when
 * the required storage operation cannot be performed because the database
 * itself is unavailable (connection/network outage, remote server error,
 * storage-level I/O failure). HTTP handlers map it to the stable
 * `STORAGE_UNAVAILABLE` product envelope; the original error stays
 * available as `cause` for internal diagnostics and is never shown to
 * participants. Programming and data errors (malformed SQL, constraint
 * violations, state invariants, serialization bugs) are never converted
 * into this class.
 */
export class DiscussionStorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Discussion storage is unavailable");
    this.name = "DiscussionStorageUnavailableError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function copyFailure(failure: TurnFailure): TurnFailure {
  return structuredClone(failure);
}

/** Deep, schema-validated copy of a Discussion state, so callers never alias store-held state. */
export function copyDiscussion(discussion: DiscussionState): DiscussionState {
  return DiscussionStateSchema.parse(structuredClone(discussion));
}
