import { z } from "zod";
import {
  DEFAULT_DISCUSSION_TURN_LIMIT,
  HARD_DISCUSSION_TURN_LIMIT,
  DiscussionStateSchema,
  DiscussionTopicSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  type DiscussionState,
  type DiscussionTopic,
  type PolicyOutcome,
} from "./contracts";
import { type DiscussionStore, copyDiscussion } from "./discussion-store";
import { InMemoryDiscussionStore } from "./in-memory-discussion-store";
import { DiscussionPolicy } from "./policy";

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
