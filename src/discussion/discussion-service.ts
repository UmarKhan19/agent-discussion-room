import { z } from "zod";
import {
  DiscussionStateSchema,
  DiscussionTopicSchema,
  SessionIdentifierSchema,
  type DiscussionState,
  type DiscussionTopic,
  type PolicyOutcome,
} from "./contracts";
import { DiscussionPolicy } from "./policy";

interface OwnedDiscussion {
  ownerSessionId: string;
  state: DiscussionState;
}

export interface DiscussionStore {
  create(ownerSessionId: string, discussion: DiscussionState): void;
  readOwned(ownerSessionId: string, discussionId: string): DiscussionState | null;
}

function copyDiscussion(discussion: DiscussionState): DiscussionState {
  return DiscussionStateSchema.parse(structuredClone(discussion));
}

/** Explicit process-local store. Durable storage is introduced by the persistence ticket. */
export class InMemoryDiscussionStore implements DiscussionStore {
  private readonly discussions = new Map<string, OwnedDiscussion>();

  create(ownerSessionId: string, discussion: DiscussionState): void {
    this.discussions.set(discussion.id, {
      ownerSessionId: SessionIdentifierSchema.parse(ownerSessionId),
      state: copyDiscussion(discussion),
    });
  }

  readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): DiscussionState | null {
    const stored = this.discussions.get(discussionId);
    if (!stored || stored.ownerSessionId !== ownerSessionId) {
      return null;
    }

    return copyDiscussion(stored.state);
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

const TurnLimitSchema = z.number().int().positive().max(100);

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
    this.turnLimit = TurnLimitSchema.parse(options.turnLimit ?? 12);
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
