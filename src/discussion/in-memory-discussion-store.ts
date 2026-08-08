import {
  DiscussionMessageSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  SYNTHESIS_REQUEST_ID,
  SynthesisContentSchema,
  SynthesisFailureSchema,
  type AllowedPolicyOutcome,
  type DiscussionMessage,
  type DiscussionState,
  type DiscussionTerminalReason,
  type GenerationUsage,
  type SynthesisContent,
  type SynthesisFailure,
} from "./contracts";
import {
  type ClaimSynthesisResult,
  type ClaimTurnResult,
  type CreateDiscussionResult,
  type DiscussionStore,
  type RequestStatusResult,
  type StopTurnResult,
  type TurnFailure,
  type TurnMutationResult,
  copyDiscussion,
  copyFailure,
} from "./discussion-store";

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
