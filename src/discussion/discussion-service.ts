import { z } from "zod";
import {
  DEFAULT_DISCUSSION_TURN_LIMIT,
  HARD_DISCUSSION_TURN_LIMIT,
  DiscussionMessageSchema,
  DiscussionStateSchema,
  DiscussionTopicSchema,
  PolicyCategorySchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  SYNTHESIS_REQUEST_ID,
  SynthesisContentSchema,
  SynthesisFailureSchema,
  type AllowedPolicyOutcome,
  type DiscussionMessage,
  type DiscussionState,
  type DiscussionTerminalReason,
  type DiscussionTopic,
  type GenerationUsage,
  type PolicyOutcome,
  type SynthesisContent,
  type SynthesisFailure,
} from "./contracts";
import { DiscussionPolicy } from "./policy";

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

type TurnRequestRecord =
  | { status: "generating"; turn: number; attemptId: string }
  | { status: "succeeded"; turn: number }
  | { status: "failed"; turn: number; failure: TurnFailure };

interface OwnedDiscussion {
  ownerSessionId: string;
  state: DiscussionState;
  requests: Map<string, TurnRequestRecord>;
  /** Durable identity of the Start request that created this Discussion; null for legacy rows. */
  creationRequestId: string | null;
}

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

function copyDiscussion(discussion: DiscussionState): DiscussionState {
  return DiscussionStateSchema.parse(structuredClone(discussion));
}

export function copyFailure(failure: TurnFailure): TurnFailure {
  return structuredClone(failure);
}

function ownedRecord(
  discussions: Map<string, OwnedDiscussion>,
  ownerSessionId: string,
  discussionId: string,
): OwnedDiscussion | null {
  const stored = discussions.get(discussionId);
  return stored?.ownerSessionId === ownerSessionId ? stored : null;
}

interface TurnRequestIdentity {
  requestId: string;
  attemptId: string;
  expectedTurn: number;
}

/** Guards the one-Turn boundary: only the currently persisted attempt may mutate. */
function isCurrentAttempt(
  stored: OwnedDiscussion,
  identity: TurnRequestIdentity,
): boolean {
  const request = stored.requests.get(identity.requestId);
  return (
    request?.status === "generating" &&
    request.attemptId === identity.attemptId &&
    request.turn === identity.expectedTurn &&
    stored.state.status === "generating" &&
    stored.state.turnCount === identity.expectedTurn - 1
  );
}

/** Explicit process-local store. Durable storage is the production path; see LibSQLDiscussionStore. */
export class InMemoryDiscussionStore implements DiscussionStore {
  private readonly discussions = new Map<string, OwnedDiscussion>();

  async create(
    ownerSessionId: string,
    discussion: DiscussionState,
    creationRequestId?: string | null,
  ): Promise<CreateDiscussionResult> {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    if (creationRequestId !== undefined && creationRequestId !== null) {
      const requestId = RequestIdentifierSchema.parse(creationRequestId);
      for (const stored of this.discussions.values()) {
        if (
          stored.ownerSessionId === sessionId &&
          stored.creationRequestId === requestId
        ) {
          return {
            kind: "replayed",
            discussion: copyDiscussion(stored.state),
          };
        }
      }
    }
    this.discussions.set(discussion.id, {
      ownerSessionId: sessionId,
      state: copyDiscussion(discussion),
      requests: new Map(),
      creationRequestId: creationRequestId ?? null,
    });
    return { kind: "created" };
  }

  async readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    const stored = ownedRecord(this.discussions, ownerSessionId, discussionId);
    return stored ? copyDiscussion(stored.state) : null;
  }

  async requestStatus(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): Promise<RequestStatusResult> {
    const stored = ownedRecord(
      this.discussions,
      SessionIdentifierSchema.parse(ownerSessionId),
      discussionId,
    );
    const request = stored?.requests.get(
      RequestIdentifierSchema.parse(requestId),
    );
    if (!request) return { kind: "unknown" };
    if (request.status === "succeeded") return { kind: "succeeded" };
    if (request.status === "generating") return { kind: "generating" };
    return { kind: "failed", retryable: request.failure.retryable };
  }

  async claimTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimTurnResult> {
    const stored = ownedRecord(
      this.discussions,
      SessionIdentifierSchema.parse(input.ownerSessionId),
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    const requestId = RequestIdentifierSchema.parse(input.requestId);
    const attemptId = RequestIdentifierSchema.parse(input.attemptId);
    const existing = stored.requests.get(requestId);

    if (existing?.status === "succeeded") {
      return { kind: "replay", discussion: copyDiscussion(stored.state) };
    }
    if (existing?.status === "generating") {
      return { kind: "request_in_progress" };
    }
    if (existing?.status === "failed" && !existing.failure.retryable) {
      return { kind: "failed", failure: copyFailure(existing.failure) };
    }

    const activeRequest = [...stored.requests.values()].find(
      (request) => request.status === "generating",
    );
    if (activeRequest) return { kind: "turn_in_progress" };

    if (stored.state.status === "completed") return { kind: "completed" };

    const isRetry = existing?.status === "failed" && existing.failure.retryable;
    const eligibleStatus = isRetry
      ? stored.state.status === "failed" && stored.state.terminalReason === null
      : stored.state.status === "idle";
    const turn = isRetry ? existing.turn : stored.state.turnCount + 1;
    if (
      !eligibleStatus ||
      stored.state.turnCount >= stored.state.turnLimit ||
      turn !== stored.state.turnCount + 1
    ) {
      return { kind: "invalid_state" };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      status: "generating",
      terminalReason: null,
      updatedAt: input.updatedAt,
    });
    stored.requests.set(requestId, {
      status: "generating",
      turn,
      attemptId,
    });

    return {
      kind: "claimed",
      discussion: copyDiscussion(stored.state),
      turn,
      attemptId,
    };
  }

  async completeTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    message: DiscussionMessage;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    const message = DiscussionMessageSchema.parse(input.message);
    if (!isCurrentAttempt(stored, input)) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }
    if (
      message.turn !== input.expectedTurn ||
      message.generation.requestId !== input.requestId
    ) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      status:
        input.expectedTurn === stored.state.turnLimit ? "completed" : "idle",
      terminalReason: null,
      turnCount: input.expectedTurn,
      updatedAt: input.updatedAt,
      transcript: [...stored.state.transcript, message],
    });
    stored.requests.set(input.requestId, {
      status: "succeeded",
      turn: input.expectedTurn,
    });
    return { kind: "updated", discussion: copyDiscussion(stored.state) };
  }

  async failTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    if (!isCurrentAttempt(stored, input)) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      status: "failed",
      terminalReason: null,
      updatedAt: input.updatedAt,
    });
    stored.requests.set(input.requestId, {
      status: "failed",
      turn: input.expectedTurn,
      failure: copyFailure(input.failure),
    });
    return { kind: "updated", discussion: copyDiscussion(stored.state) };
  }

  async cancelTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    if (!isCurrentAttempt(stored, input)) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      status: input.reason === "timeout" ? "failed" : "stopped",
      terminalReason: input.reason,
      updatedAt: input.updatedAt,
    });
    stored.requests.set(input.requestId, {
      status: "failed",
      turn: input.expectedTurn,
      failure:
        input.reason === "timeout"
          ? { kind: "timeout", retryable: false }
          : { kind: "stopped", retryable: false },
    });
    return { kind: "updated", discussion: copyDiscussion(stored.state) };
  }

  async stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): Promise<StopTurnResult> {
    const stored = ownedRecord(this.discussions, ownerSessionId, discussionId);
    if (!stored) return { kind: "not_found" };
    if (stored.state.status === "stopped") {
      return { kind: "stopped", discussion: copyDiscussion(stored.state) };
    }
    if (stored.state.status !== "generating") {
      return { kind: "invalid_state" };
    }

    const activeEntry = [...stored.requests.entries()].find(
      ([, request]) => request.status === "generating",
    );
    if (!activeEntry) return { kind: "invalid_state" };

    const [requestId, request] = activeEntry;
    stored.state = copyDiscussion({
      ...stored.state,
      status: "stopped",
      terminalReason: "stop",
      updatedAt,
    });
    stored.requests.set(requestId, {
      status: "failed",
      turn: request.turn,
      failure: { kind: "stopped", retryable: false },
    });
    return { kind: "stopped", discussion: copyDiscussion(stored.state) };
  }

  async claimSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimSynthesisResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    const attemptId = RequestIdentifierSchema.parse(input.attemptId);
    const existing = stored.state.synthesis;
    if (existing?.status === "completed") {
      return { kind: "already_present", discussion: copyDiscussion(stored.state) };
    }
    if (existing?.status === "generating") {
      // In-memory state cannot outlive its process, so a generating attempt
      // is always owned by a live runner in this process; observe it.
      return { kind: "in_progress", discussion: copyDiscussion(stored.state) };
    }
    if (existing?.status === "failed" && !existing.failure.retryable) {
      return { kind: "invalid_state", discussion: copyDiscussion(stored.state) };
    }
    if (stored.state.status !== "completed") {
      return { kind: "invalid_state", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      synthesis: {
        status: "generating",
        requestId: SYNTHESIS_REQUEST_ID,
        attemptId,
        startedAt: input.updatedAt,
        updatedAt: input.updatedAt,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    });
    return { kind: "claimed", discussion: copyDiscussion(stored.state) };
  }

  async completeSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    content: SynthesisContent;
    usage?: GenerationUsage;
    outputPolicyOutcome: AllowedPolicyOutcome;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    const content = SynthesisContentSchema.parse(input.content);
    const existing = stored.state.synthesis;
    if (
      stored.state.status !== "completed" ||
      existing?.status !== "generating" ||
      existing.attemptId !== input.attemptId
    ) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      synthesis: {
        status: "completed",
        requestId: SYNTHESIS_REQUEST_ID,
        attemptId: input.attemptId,
        content,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        outputPolicyOutcome: input.outputPolicyOutcome,
        startedAt: existing.startedAt,
        updatedAt: input.updatedAt,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    });
    return { kind: "updated", discussion: copyDiscussion(stored.state) };
  }

  async failSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    failure: SynthesisFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    const stored = ownedRecord(
      this.discussions,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!stored) return { kind: "not_found" };

    const failure = SynthesisFailureSchema.parse(input.failure);
    const existing = stored.state.synthesis;
    if (
      stored.state.status !== "completed" ||
      existing?.status !== "generating" ||
      existing.attemptId !== input.attemptId
    ) {
      return { kind: "stale", discussion: copyDiscussion(stored.state) };
    }

    stored.state = copyDiscussion({
      ...stored.state,
      synthesis: {
        status: "failed",
        requestId: SYNTHESIS_REQUEST_ID,
        attemptId: input.attemptId,
        failure,
        startedAt: existing.startedAt,
        updatedAt: input.updatedAt,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    });
    return { kind: "updated", discussion: copyDiscussion(stored.state) };
  }
}

export class DiscussionPolicyBlockedError extends Error {
  constructor(readonly outcome: Extract<PolicyOutcome, { decision: "blocked" }>) {
    super("Discussion Topic was blocked by policy");
    this.name = "DiscussionPolicyBlockedError";
  }
}

/**
 * A Start request identity was already used to create a different
 * Discussion in the same session. The persisted mapping is authoritative,
 * so the reused identity cannot silently create a second Discussion for a
 * semantically different payload; the participant must start with a fresh
 * identity instead.
 */
export class DiscussionStartConflictError extends Error {
  constructor() {
    super("Start request identity was already used with a different Topic");
    this.name = "DiscussionStartConflictError";
  }
}

export interface DiscussionServiceOptions {
  store?: DiscussionStore;
  policy?: DiscussionPolicy;
  turnLimit?: number;
  now?: () => Date;
  createId?: () => string;
}

const TurnLimitSchema = z
  .number()
  .int()
  .positive()
  .max(HARD_DISCUSSION_TURN_LIMIT);

/** Owns creation and ownership-aware reads of Discussion state. */
export class DiscussionService {
  private readonly store: DiscussionStore;
  private readonly policy: DiscussionPolicy;
  private readonly turnLimit: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: DiscussionServiceOptions = {}) {
    this.store = options.store ?? new InMemoryDiscussionStore();
    this.policy = options.policy ?? new DiscussionPolicy(options.now);
    this.turnLimit = TurnLimitSchema.parse(
      options.turnLimit ?? DEFAULT_DISCUSSION_TURN_LIMIT,
    );
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async start(
    ownerSessionId: string,
    untrustedTopic: unknown,
    creationRequestId: string,
  ): Promise<DiscussionState> {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const topic: DiscussionTopic = DiscussionTopicSchema.parse(untrustedTopic);
    const requestId = RequestIdentifierSchema.parse(creationRequestId);
    const policyOutcome = this.policy.evaluate(topic);

    if (policyOutcome.decision === "blocked") {
      throw new DiscussionPolicyBlockedError(policyOutcome);
    }

    const timestamp = this.now().toISOString();
    const discussion = DiscussionStateSchema.parse({
      id: this.createId(),
      topic,
      status: "idle",
      terminalReason: null,
      turnLimit: this.turnLimit,
      turnCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      policyOutcome,
      transcript: [],
    });

    const result = await this.store.create(
      sessionId,
      discussion,
      requestId,
    );
    if (result.kind === "replayed") {
      // The idempotency key was already used in this session. The stored
      // mapping is authoritative: an exact retry (same Topic) replays the
      // original Discussion, while a reused identity with a different Topic
      // is a conflict, never a silently created second Discussion.
      if (result.discussion.topic !== topic) {
        throw new DiscussionStartConflictError();
      }
      return copyDiscussion(result.discussion);
    }
    return copyDiscussion(discussion);
  }

  async read(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    return this.store.readOwned(
      SessionIdentifierSchema.parse(ownerSessionId),
      discussionId,
    );
  }
}
