import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  DiscussionIdentifierSchema,
  DiscussionMessageSchema,
  DiscussionStateSchema,
  RequestIdentifierSchema,
  SessionIdentifierSchema,
  type DiscussionMessage,
  type DiscussionState,
  type DiscussionTerminalReason,
} from "./contracts";
import type {
  ClaimTurnResult,
  DiscussionStore,
  DurableDiscussionStore,
  RequestStatusResult,
  StopTurnResult,
  TurnFailure,
  TurnMutationResult,
} from "./discussion-service";
import { TurnFailureSchema, copyFailure } from "./discussion-service";

export interface LibSQLDiscussionStoreOptions {
  /** libSQL URL: file:, libsql:, http(s):, or ws(s):. */
  url: string;
  /** Authentication token for remote libSQL databases. */
  authToken?: string;
  /** Injectable clock for deterministic tests; defaults to Date. */
  now?: () => Date;
}

const INTERRUPTED_RECOVERY_FAILURE: TurnFailure = {
  kind: "generation_failed",
  retryable: true,
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS discussion (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discussion_owner_session
  ON discussion (owner_session_id);
CREATE TABLE IF NOT EXISTS discussion_request (
  discussion_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating', 'succeeded', 'failed')),
  failure TEXT,
  PRIMARY KEY (discussion_id, request_id)
);
CREATE INDEX IF NOT EXISTS discussion_request_status
  ON discussion_request (discussion_id, status);
`;

type StoredRequest =
  | { turn: number; attemptId: string; status: "generating" }
  | { turn: number; attemptId: string; status: "succeeded" }
  | { turn: number; attemptId: string; status: "failed"; failure: TurnFailure };

function parseStateColumn(raw: unknown): DiscussionState {
  return DiscussionStateSchema.parse(JSON.parse(String(raw)));
}

function parseRequestRow(raw: unknown): StoredRequest {
  const row = raw as Record<string, unknown>;
  const base = {
    turn: Number(row.turn),
    attemptId: String(row.attempt_id),
  };
  const status = String(row.status) as StoredRequest["status"];
  if (status === "failed") {
    return {
      ...base,
      status,
      failure: TurnFailureSchema.parse(JSON.parse(String(row.failure))),
    };
  }
  return { ...base, status };
}

function serializeFailure(failure: TurnFailure): string {
  return JSON.stringify(copyFailure(failure));
}

interface CurrentAttemptInput {
  ownerSessionId: string;
  discussionId: string;
  requestId: string;
  attemptId: string;
  expectedTurn: number;
}

function isCurrentAttempt(
  discussion: DiscussionState,
  request: StoredRequest,
  input: CurrentAttemptInput,
): boolean {
  return (
    request.status === "generating" &&
    request.attemptId === input.attemptId &&
    request.turn === input.expectedTurn &&
    discussion.status === "generating" &&
    discussion.turnCount === input.expectedTurn - 1
  );
}

/**
 * Durable Discussion store backed by libSQL (SQLite-compatible). The store
 * is the Discussion system of record: ownership, the full runtime-validated
 * state document, and per-request identity records are persisted here, never
 * in raw provider traces.
 *
 * Every mutation runs in a write transaction so the one-Turn boundary and
 * idempotent request outcomes hold across restarts and concurrent callers.
 * Recovery (`recoverInterrupted`) assumes a single process owns the store:
 * a Discussion left generating after a process exit becomes a retryable
 * failed state that the participant can resume with the same request
 * identity.
 */
export class LibSQLDiscussionStore
  implements DiscussionStore, DurableDiscussionStore
{
  private readonly client: Client;
  private readonly now: () => Date;
  private initPromise: Promise<void> | null = null;
  /**
   * Serializes write transactions inside this process. The libSQL client
   * opens a fresh connection per transaction, so overlapping transactions
   * on the same store would contend on the SQLite file lock; a single
   * writer queue keeps mutations deterministic without depending on driver
   * busy-timeout behavior.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: LibSQLDiscussionStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.client = createClient({
      url: options.url,
      ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
      ...(isLocalUrl(options.url) ? { timeout: 5_000 } : {}),
    });
  }

  init(): Promise<void> {
    this.initPromise ??= this.createSchema();
    return this.initPromise;
  }

  close(): void {
    this.client.close();
  }

  async recoverInterrupted(): Promise<number> {
    await this.init();

    return this.withWriteTransaction(async (tx) => {
      const result = await tx.execute("SELECT id, state FROM discussion");
      let recovered = 0;

      for (const row of result.rows) {
        const parsed = DiscussionStateSchema.safeParse(
          JSON.parse(String(row.state)),
        );
        if (!parsed.success) {
          console.error(
            "[discussion] Skipping unreadable persisted Discussion during recovery:",
            row.id,
          );
          continue;
        }
        if (parsed.data.status !== "generating") continue;

        const recoveredState: DiscussionState = {
          ...parsed.data,
          status: "failed",
          updatedAt: this.now().toISOString(),
        };
        await tx.execute({
          sql: "UPDATE discussion SET state = ?, updated_at = ? WHERE id = ?",
          args: [JSON.stringify(recoveredState), recoveredState.updatedAt, row.id],
        });
        await tx.execute({
          sql: "UPDATE discussion_request SET status = 'failed', failure = ? WHERE discussion_id = ? AND status = 'generating'",
          args: [serializeFailure(INTERRUPTED_RECOVERY_FAILURE), row.id],
        });
        recovered += 1;
      }

      return recovered;
    });
  }

  async create(
    ownerSessionId: string,
    discussion: DiscussionState,
  ): Promise<void> {
    await this.init();
    const owner = SessionIdentifierSchema.parse(ownerSessionId);
    const state = DiscussionStateSchema.parse(discussion);
    await this.client.execute({
      sql: "INSERT INTO discussion (id, owner_session_id, state, updated_at) VALUES (?, ?, ?, ?)",
      args: [state.id, owner, JSON.stringify(state), state.updatedAt],
    });
  }

  async readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    await this.init();
    const state = await this.readOwnedState(
      this.client,
      ownerSessionId,
      discussionId,
    );
    return state;
  }

  async requestStatus(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): Promise<RequestStatusResult> {
    await this.init();
    const request = await this.readRequest(
      this.client,
      discussionId,
      requestId,
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
    await this.init();
    const ownerSessionId = SessionIdentifierSchema.parse(input.ownerSessionId);
    const discussionId = DiscussionIdentifierSchema.parse(input.discussionId);
    const requestId = RequestIdentifierSchema.parse(input.requestId);
    const attemptId = RequestIdentifierSchema.parse(input.attemptId);

    return this.withWriteTransaction(async (tx) => {
      const discussion = await this.readOwnedState(
        tx,
        ownerSessionId,
        discussionId,
      );
      if (!discussion) return { kind: "not_found" };

      const existing = await this.readRequest(tx, discussionId, requestId);
      if (existing?.status === "succeeded") {
        return { kind: "replay", discussion };
      }
      if (existing?.status === "generating") {
        return { kind: "request_in_progress" };
      }
      if (existing?.status === "failed" && !existing.failure.retryable) {
        return { kind: "failed", failure: copyFailure(existing.failure) };
      }

      const activeRequest = await this.readGeneratingRequest(tx, discussionId);
      if (activeRequest) return { kind: "turn_in_progress" };

      if (discussion.status === "completed") return { kind: "completed" };

      const isRetry =
        existing?.status === "failed" && existing.failure.retryable;
      const eligibleStatus = isRetry
        ? discussion.status === "failed" && discussion.terminalReason === null
        : discussion.status === "idle";
      const turn = isRetry ? existing.turn : discussion.turnCount + 1;
      if (
        !eligibleStatus ||
        discussion.turnCount >= discussion.turnLimit ||
        turn !== discussion.turnCount + 1
      ) {
        return { kind: "invalid_state" };
      }

      const claimed: DiscussionState = {
        ...discussion,
        status: "generating",
        terminalReason: null,
        updatedAt: input.updatedAt,
      };
      await this.writeState(tx, discussionId, claimed);
      await this.upsertRequest(tx, {
        discussionId,
        requestId,
        turn,
        attemptId,
        status: "generating",
        failure: null,
      });

      return {
        kind: "claimed",
        discussion: DiscussionStateSchema.parse(claimed),
        turn,
        attemptId,
      };
    });
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
    await this.init();
    const message = DiscussionMessageSchema.parse(input.message);
    return this.withWriteTransaction(async (tx) => {
      const stored = await this.requireCurrentAttempt(tx, input);
      if ("result" in stored) return stored.result;

      if (
        message.turn !== input.expectedTurn ||
        message.generation.requestId !== input.requestId
      ) {
        return { kind: "stale", discussion: stored.discussion };
      }

      const updated: DiscussionState = {
        ...stored.discussion,
        status:
          input.expectedTurn === stored.discussion.turnLimit
            ? "completed"
            : "idle",
        terminalReason: null,
        turnCount: input.expectedTurn,
        updatedAt: input.updatedAt,
        transcript: [...stored.discussion.transcript, message],
      };
      await this.writeState(tx, input.discussionId, updated);
      await this.updateRequest(tx, input.discussionId, input.requestId, {
        status: "succeeded",
        failure: null,
      });
      return {
        kind: "updated",
        discussion: DiscussionStateSchema.parse(updated),
      };
    });
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
    await this.init();
    const failure = TurnFailureSchema.parse(input.failure);
    return this.withWriteTransaction(async (tx) => {
      const stored = await this.requireCurrentAttempt(tx, input);
      if ("result" in stored) return stored.result;

      const updated: DiscussionState = {
        ...stored.discussion,
        status: "failed",
        terminalReason: null,
        updatedAt: input.updatedAt,
      };
      await this.writeState(tx, input.discussionId, updated);
      await this.updateRequest(tx, input.discussionId, input.requestId, {
        status: "failed",
        failure,
      });
      return {
        kind: "updated",
        discussion: DiscussionStateSchema.parse(updated),
      };
    });
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
    await this.init();
    return this.withWriteTransaction(async (tx) => {
      const stored = await this.requireCurrentAttempt(tx, input);
      if ("result" in stored) return stored.result;

      const failure: TurnFailure =
        input.reason === "timeout"
          ? { kind: "timeout", retryable: false }
          : { kind: "stopped", retryable: false };
      const updated: DiscussionState = {
        ...stored.discussion,
        status: input.reason === "timeout" ? "failed" : "stopped",
        terminalReason: input.reason,
        updatedAt: input.updatedAt,
      };
      await this.writeState(tx, input.discussionId, updated);
      await this.updateRequest(tx, input.discussionId, input.requestId, {
        status: "failed",
        failure,
      });
      return {
        kind: "updated",
        discussion: DiscussionStateSchema.parse(updated),
      };
    });
  }

  async stopOwned(
    ownerSessionId: string,
    discussionId: string,
    updatedAt: string,
  ): Promise<StopTurnResult> {
    await this.init();
    return this.withWriteTransaction(async (tx) => {
      const discussion = await this.readOwnedState(
        tx,
        ownerSessionId,
        discussionId,
      );
      if (!discussion) return { kind: "not_found" };
      if (discussion.status === "stopped") {
        return { kind: "stopped", discussion };
      }
      if (discussion.status !== "generating") {
        return { kind: "invalid_state" };
      }

      const active = await this.readGeneratingRequest(tx, discussionId);
      if (!active) return { kind: "invalid_state" };

      const stopped: DiscussionState = {
        ...discussion,
        status: "stopped",
        terminalReason: "stop",
        updatedAt,
      };
      await this.writeState(tx, discussionId, stopped);
      await this.updateRequest(tx, discussionId, active.requestId, {
        status: "failed",
        failure: { kind: "stopped", retryable: false },
      });
      return {
        kind: "stopped",
        discussion: DiscussionStateSchema.parse(stopped),
      };
    });
  }

  private async createSchema(): Promise<void> {
    await this.client.executeMultiple(SCHEMA_SQL);
    if (this.client.protocol === "file") {
      try {
        await this.client.execute("PRAGMA journal_mode = WAL");
      } catch {
        // WAL is a durability optimization; a store that cannot switch is
        // still correct under the in-process writer queue.
      }
    }
  }

  private async withWriteTransaction<T>(
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const tx = await this.client.transaction("write");
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          tx.close();
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  private async readOwnedState(
    connection: { execute: Client["execute"] },
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    const result = await connection.execute({
      sql: "SELECT state FROM discussion WHERE id = ? AND owner_session_id = ?",
      args: [discussionId, ownerSessionId],
    });
    const row = result.rows[0];
    return row ? parseStateColumn(row.state) : null;
  }

  private async readRequest(
    connection: { execute: Client["execute"] },
    discussionId: string,
    requestId: string,
  ): Promise<StoredRequest | null> {
    const result = await connection.execute({
      sql: "SELECT turn, attempt_id, status, failure FROM discussion_request WHERE discussion_id = ? AND request_id = ?",
      args: [discussionId, requestId],
    });
    const row = result.rows[0];
    return row ? parseRequestRow(row) : null;
  }

  private async readGeneratingRequest(
    connection: { execute: Client["execute"] },
    discussionId: string,
  ): Promise<StoredRequest & { requestId: string } | null> {
    const result = await connection.execute({
      sql: "SELECT request_id, turn, attempt_id, status, failure FROM discussion_request WHERE discussion_id = ? AND status = 'generating' LIMIT 1",
      args: [discussionId],
    });
    const row = result.rows[0];
    if (!row) return null;
    const parsed = parseRequestRow(row);
    return { requestId: String(row.request_id), ...parsed };
  }

  private async writeState(
    tx: Transaction,
    discussionId: string,
    state: DiscussionState,
  ): Promise<void> {
    await tx.execute({
      sql: "UPDATE discussion SET state = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify(state), state.updatedAt, discussionId],
    });
  }

  private async upsertRequest(
    tx: Transaction,
    request: {
      discussionId: string;
      requestId: string;
      turn: number;
      attemptId: string;
      status: StoredRequest["status"];
      failure: TurnFailure | null;
    },
  ): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO discussion_request (discussion_id, request_id, turn, attempt_id, status, failure)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (discussion_id, request_id) DO UPDATE SET
          turn = excluded.turn,
          attempt_id = excluded.attempt_id,
          status = excluded.status,
          failure = excluded.failure`,
      args: [
        request.discussionId,
        request.requestId,
        request.turn,
        request.attemptId,
        request.status,
        request.failure === null ? null : serializeFailure(request.failure),
      ],
    });
  }

  private async updateRequest(
    tx: Transaction,
    discussionId: string,
    requestId: string,
    update: { status: StoredRequest["status"]; failure: TurnFailure | null },
  ): Promise<void> {
    await tx.execute({
      sql: "UPDATE discussion_request SET status = ?, failure = ? WHERE discussion_id = ? AND request_id = ?",
      args: [
        update.status,
        update.failure === null ? null : serializeFailure(update.failure),
        discussionId,
        requestId,
      ],
    });
  }

  /**
   * Reads the owned Discussion and its request record and verifies the
   * caller's attempt is still the currently persisted one. Returns the
   * not-found result, a stale result, or the verified pair.
   */
  private async requireCurrentAttempt(
    tx: Transaction,
    input: CurrentAttemptInput,
  ): Promise<
    | { result: TurnMutationResult }
    | { discussion: DiscussionState; request: StoredRequest }
  > {
    const discussion = await this.readOwnedState(
      tx,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!discussion) return { result: { kind: "not_found" } };

    const request = await this.readRequest(
      tx,
      input.discussionId,
      input.requestId,
    );
    if (!request || !isCurrentAttempt(discussion, request, input)) {
      return { result: { kind: "stale", discussion } };
    }
    return { discussion, request };
  }
}

function isLocalUrl(url: string): boolean {
  return url.startsWith("file:");
}
