import { z } from "zod";
import {
  DEFAULT_DISCUSSION_TURN_LIMIT,
  HARD_DISCUSSION_TURN_LIMIT,
  DiscussionMessageSchema,
  DiscussionStateSchema,
  DiscussionTopicSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  type DiscussionMessage,
  type DiscussionState,
  type DiscussionTerminalReason,
  type DiscussionTopic,
  type PolicyCategory,
  type PolicyOutcome,
} from "./contracts";
import { DiscussionPolicy } from "./policy";

export type TurnFailure =
  | { kind: "generation_failed"; retryable: boolean }
  | { kind: "invalid_response"; retryable: false }
  | {
      kind: "output_blocked";
      retryable: false;
      category: PolicyCategory;
    }
  | { kind: "timeout"; retryable: false }
  | { kind: "stopped"; retryable: false };

type TurnRequestRecord =
  | { status: "generating"; turn: number; attemptId: string }
  | { status: "succeeded"; turn: number }
  | { status: "failed"; turn: number; failure: TurnFailure };

interface OwnedDiscussion {
  ownerSessionId: string;
  state: DiscussionState;
  requests: Map<string, TurnRequestRecord>;
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

export type StopTurnResult =
  | { kind: "stopped"; discussion: DiscussionState }
  | { kind: "invalid_state" }
  | { kind: "not_found" };

export interface DiscussionStore {
  create(ownerSessionId: string, discussion: DiscussionState): void;
  readOwned(ownerSessionId: string, discussionId: string): DiscussionState | null;
  claimTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    updatedAt: string;
  }): ClaimTurnResult;
  completeTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    message: DiscussionMessage;
    updatedAt: string;
  }): TurnMutationResult;
  failTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
    updatedAt: string;
  }): TurnMutationResult;
  cancelTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">;
    updatedAt: string;
  }): TurnMutationResult;
  stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): StopTurnResult;
}

function copyDiscussion(discussion: DiscussionState): DiscussionState {
  return DiscussionStateSchema.parse(structuredClone(discussion));
}

function copyFailure(failure: TurnFailure): TurnFailure {
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

/** Explicit process-local store. Durable storage is introduced by the persistence ticket. */
export class InMemoryDiscussionStore implements DiscussionStore {
  private readonly discussions = new Map<string, OwnedDiscussion>();

  create(ownerSessionId: string, discussion: DiscussionState): void {
    this.discussions.set(discussion.id, {
      ownerSessionId: SessionIdentifierSchema.parse(ownerSessionId),
      state: copyDiscussion(discussion),
      requests: new Map(),
    });
  }

  readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): DiscussionState | null {
    const stored = ownedRecord(this.discussions, ownerSessionId, discussionId);
    return stored ? copyDiscussion(stored.state) : null;
  }

  claimTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    updatedAt: string;
  }): ClaimTurnResult {
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

  completeTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    message: DiscussionMessage;
    updatedAt: string;
  }): TurnMutationResult {
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

  failTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    failure: TurnFailure;
    updatedAt: string;
  }): TurnMutationResult {
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

  cancelTurn(input: {
    ownerSessionId: string;
    discussionId: string;
    requestId: string;
    attemptId: string;
    expectedTurn: number;
    reason: Extract<DiscussionTerminalReason, "disconnect" | "timeout">;
    updatedAt: string;
  }): TurnMutationResult {
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

  stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): StopTurnResult {
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
}

export class DiscussionPolicyBlockedError extends Error {
  constructor(readonly outcome: Extract<PolicyOutcome, { decision: "blocked" }>) {
    super("Discussion Topic was blocked by policy");
    this.name = "DiscussionPolicyBlockedError";
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

  start(ownerSessionId: string, untrustedTopic: unknown): DiscussionState {
    const sessionId = SessionIdentifierSchema.parse(ownerSessionId);
    const topic: DiscussionTopic = DiscussionTopicSchema.parse(untrustedTopic);
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

    this.store.create(sessionId, discussion);
    return copyDiscussion(discussion);
  }

  read(ownerSessionId: string, discussionId: string): DiscussionState | null {
    return this.store.readOwned(
      SessionIdentifierSchema.parse(ownerSessionId),
      discussionId,
    );
  }
}
