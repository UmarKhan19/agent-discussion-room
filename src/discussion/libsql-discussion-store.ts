import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  HARD_GENERATION_TIMEOUT_MS,
  deriveLeaseDurationMs,
} from "./budgets";
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
  /**
   * Stable identifier of this application instance. Written as the lease
   * owner of every generation this instance claims, so operators can tell
   * which instance owned an attempt. Defaults to a fresh random UUID per
   * store; inject a fixed value in tests. Not authentication and never
   * exposed to clients.
   */
  leaseOwnerId?: string;
  /**
   * The generation timeout configured on the DiscussionRunner that will
   * use this store. The recovery lease of a claimed attempt is derived
   * from this value (timeout + `RECOVERY_LEASE_GRACE_MS`, via
   * `deriveLeaseDurationMs`), so a live instance's own hard timeout always
   * fires before another instance may recover the attempt. Required: there
   * is deliberately no silent default, so a store and its Runner can never
   * drift apart by omission — pass the same budget value to both.
   */
  generationTimeoutMs: number;
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
  lease_owner_id TEXT,
  lease_expires_at TEXT,
  PRIMARY KEY (discussion_id, request_id)
);
CREATE INDEX IF NOT EXISTS discussion_request_status
  ON discussion_request (discussion_id, status);
`;

type StoredRequest =
  | {
      turn: number;
      attemptId: string;
      status: "generating";
      /** Instance that claimed this attempt; null only for legacy rows. */
      leaseOwnerId: string | null;
      /** ISO instant after which the attempt may be recovered; null only for legacy rows. */
      leaseExpiresAt: string | null;
    }
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
  if (status === "generating") {
    return {
      ...base,
      status,
      leaseOwnerId:
        row.lease_owner_id === null || row.lease_owner_id === undefined
          ? null
          : String(row.lease_owner_id),
      leaseExpiresAt:
        row.lease_expires_at === null || row.lease_expires_at === undefined
          ? null
          : String(row.lease_expires_at),
    };
  }
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
 * Every mutation runs in a write transaction (`BEGIN IMMEDIATE`), so the
 * one-Turn boundary and idempotent request outcomes hold across restarts
 * and concurrent callers, including multiple application instances sharing
 * one remote libSQL database.
 *
 * Each claimed attempt carries a recovery lease (`lease_owner_id`,
 * `lease_expires_at`). Recovery (`recoverInterrupted`, and the lazy recovery
 * inside `claimTurn`) reconciles a Discussion left generating only when its
 * lease has expired or is absent (legacy rows): a generation actively owned
 * by a live instance is never recovered, while a generation whose owning
 * process disappeared becomes a retryable failed state that the participant
 * can resume with the same request identity.
 */
export class LibSQLDiscussionStore
  implements DiscussionStore, DurableDiscussionStore
{
  private readonly client: Client;
  private readonly now: () => Date;
  /** This application instance's lease-owner identifier. */
  private readonly leaseOwnerId: string;
  /**
   * Maximum time one claimed attempt may remain generating: the configured
   * generation timeout plus the fixed recovery margin (derived through
   * `deriveLeaseDurationMs`).
   */
  private readonly leaseDurationMs: number;
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
    if (
      !Number.isInteger(options.generationTimeoutMs) ||
      options.generationTimeoutMs <= 0 ||
      options.generationTimeoutMs > HARD_GENERATION_TIMEOUT_MS
    ) {
      throw new Error(
        `generationTimeoutMs must be a positive integer at most HARD_GENERATION_TIMEOUT_MS (${HARD_GENERATION_TIMEOUT_MS}); received ${String(options.generationTimeoutMs)}`,
      );
    }
    this.now = options.now ?? (() => new Date());
    this.leaseOwnerId = options.leaseOwnerId ?? crypto.randomUUID();
    this.leaseDurationMs = deriveLeaseDurationMs(options.generationTimeoutMs);
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
      const updatedAt = this.now().toISOString();

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

        // A generating Discussion whose lease is still valid is owned by a
        // live instance and must never be recovered. Rows without a lease
        // are legacy rows from before leasing; they are treated as expired
        // so an upgrade never strands them permanently.
        const request = await this.readGeneratingRequest(tx, String(row.id));
        if (request && !this.isLeaseExpired(request)) continue;

        await this.recoverAttempt(
          tx,
          String(row.id),
          parsed.data,
          request ?? null,
          updatedAt,
        );
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
    if (request.status === "failed") {
      return { kind: "failed", retryable: request.failure.retryable };
    }
    // An attempt whose lease has expired is no longer owned by a live
    // instance; report it as the retryable failure it will be recovered
    // into, so callers observe the recoverable state instead of a stuck
    // "generating" answer.
    if (this.isLeaseExpired(request)) {
      return { kind: "failed", retryable: true };
    }
    return { kind: "generating" };
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
      if (existing?.status === "failed" && !existing.failure.retryable) {
        return { kind: "failed", failure: copyFailure(existing.failure) };
      }

      const activeRequest = await this.readGeneratingRequest(tx, discussionId);
      let recoveredOwnIdentity: StoredRequest | null = null;
      if (activeRequest && !this.isLeaseExpired(activeRequest)) {
        // The attempt is still owned by a live instance: conflicts are
        // reported exactly as before, whether or not it is the same request
        // identity.
        return existing?.status === "generating"
          ? { kind: "request_in_progress" }
          : { kind: "turn_in_progress" };
      }
      if (activeRequest) {
        // The generating attempt's lease has expired (or it is a legacy row
        // without a lease): the owning instance is presumed gone. Recover it
        // transactionally before claiming, so the abandoned Turn is
        // reclaimed atomically and at most one attempt is ever active.
        await this.recoverAttempt(
          tx,
          discussionId,
          discussion,
          activeRequest,
          input.updatedAt,
        );
        if (activeRequest.requestId === requestId) {
          // The abandoned attempt was this identity's own; it now reads as
          // a retryable failed request, which is exactly the retry path.
          const refreshed = await this.readRequest(tx, discussionId, requestId);
          if (refreshed?.status === "failed") {
            recoveredOwnIdentity = refreshed;
          }
        }
      }

      if (discussion.status === "completed") return { kind: "completed" };

      const retryRequest = recoveredOwnIdentity ?? existing;
      const recoveredActive = activeRequest !== null;
      const isRetry =
        retryRequest?.status === "failed" && retryRequest.failure.retryable;
      // A Discussion whose abandoned attempt was just recovered is claimable
      // by any request identity (the participant may have lost the original
      // identity); otherwise only the same identity may retry a failed Turn.
      // After an in-transaction recovery the Discussion is failed with a
      // null terminal reason by construction.
      const eligibleDiscussion = recoveredActive
        ? { ...discussion, status: "failed", terminalReason: null }
        : discussion;
      const eligibleStatus = isRetry || recoveredActive
        ? eligibleDiscussion.status === "failed" &&
          eligibleDiscussion.terminalReason === null
        : eligibleDiscussion.status === "idle";
      const turn = isRetry
        ? retryRequest.turn
        : eligibleDiscussion.turnCount + 1;
      if (
        !eligibleStatus ||
        eligibleDiscussion.turnCount >= eligibleDiscussion.turnLimit ||
        turn !== eligibleDiscussion.turnCount + 1
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
        leaseOwnerId: this.leaseOwnerId,
        leaseExpiresAt: new Date(
          this.now().getTime() + this.leaseDurationMs,
        ).toISOString(),
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
    await this.migrateRequestLeaseColumns();
    if (this.client.protocol === "file") {
      try {
        await this.client.execute("PRAGMA journal_mode = WAL");
      } catch {
        // WAL is a durability optimization; a store that cannot switch is
        // still correct under the in-process writer queue.
      }
    }
  }

  /**
   * Adds the recovery-lease columns to databases created before leasing
   * existed. `CREATE TABLE IF NOT EXISTS` cannot alter an existing table,
   * so this checks `PRAGMA table_info` and adds only missing columns;
   * legacy rows keep `NULL` leases, which recovery treats as expired. The
   * operation is idempotent and safe to run concurrently from multiple
   * instances: a lost `ALTER TABLE` race surfaces as a duplicate-column
   * error, which is re-checked and ignored.
   */
  private async migrateRequestLeaseColumns(): Promise<void> {
    const columns = await this.client.execute(
      "PRAGMA table_info(discussion_request)",
    );
    const names = new Set(columns.rows.map((row) => String(row.name)));
    for (const column of ["lease_owner_id", "lease_expires_at"]) {
      if (names.has(column)) continue;
      try {
        await this.client.execute(
          `ALTER TABLE discussion_request ADD COLUMN ${column} TEXT`,
        );
      } catch (error) {
        const recheck = await this.client.execute(
          "PRAGMA table_info(discussion_request)",
        );
        if (!recheck.rows.some((row) => String(row.name) === column)) {
          throw error;
        }
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

  /**
   * Whether a generating attempt may be recovered: its lease is absent
   * (legacy row, treated as expired) or has passed. ISO-8601 UTC strings
   * from `toISOString()` compare chronologically under `<`.
   */
  private isLeaseExpired(request: StoredRequest): boolean {
    if (request.status !== "generating") return false;
    return (
      request.leaseExpiresAt === null ||
      request.leaseExpiresAt < this.now().toISOString()
    );
  }

  /**
   * Converts one abandoned generating attempt into a retryable failed
   * state, both in the Discussion document and in its request record.
   * Must be called inside the write transaction that owns the row.
   */
  private async recoverAttempt(
    tx: Transaction,
    discussionId: string,
    discussion: DiscussionState,
    request: (StoredRequest & { requestId: string }) | null,
    updatedAt: string,
  ): Promise<void> {
    const recoveredState: DiscussionState = {
      ...discussion,
      status: "failed",
      terminalReason: null,
      updatedAt,
    };
    await tx.execute({
      sql: "UPDATE discussion SET state = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify(recoveredState), recoveredState.updatedAt, discussionId],
    });
    if (request) {
      await tx.execute({
        sql: "UPDATE discussion_request SET status = 'failed', failure = ? WHERE discussion_id = ? AND request_id = ? AND status = 'generating'",
        args: [serializeFailure(INTERRUPTED_RECOVERY_FAILURE), discussionId, request.requestId],
      });
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
      sql: "SELECT turn, attempt_id, status, failure, lease_owner_id, lease_expires_at FROM discussion_request WHERE discussion_id = ? AND request_id = ?",
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
      sql: "SELECT request_id, turn, attempt_id, status, failure, lease_owner_id, lease_expires_at FROM discussion_request WHERE discussion_id = ? AND status = 'generating' LIMIT 1",
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
      /** Recovery lease; only meaningful for the generating status. */
      leaseOwnerId?: string;
      leaseExpiresAt?: string;
    },
  ): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO discussion_request (discussion_id, request_id, turn, attempt_id, status, failure, lease_owner_id, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (discussion_id, request_id) DO UPDATE SET
          turn = excluded.turn,
          attempt_id = excluded.attempt_id,
          status = excluded.status,
          failure = excluded.failure,
          lease_owner_id = excluded.lease_owner_id,
          lease_expires_at = excluded.lease_expires_at`,
      args: [
        request.discussionId,
        request.requestId,
        request.turn,
        request.attemptId,
        request.status,
        request.failure === null ? null : serializeFailure(request.failure),
        request.leaseOwnerId ?? null,
        request.leaseExpiresAt ?? null,
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
