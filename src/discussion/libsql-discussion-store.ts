import { createClient, LibsqlError, type Client, type Transaction } from "@libsql/client";
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
import type {
  ClaimSynthesisResult,
  ClaimTurnResult,
  CreateDiscussionResult,
  DiscussionStore,
  DurableDiscussionStore,
  RequestStatusResult,
  StopTurnResult,
  TurnFailure,
  TurnMutationResult,
} from "./discussion-service";
import {
  DiscussionStorageUnavailableError,
  TurnFailureSchema,
  copyFailure,
} from "./discussion-service";

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

/** Recovery outcome for a synthesis attempt abandoned by its owning process. */
const INTERRUPTED_SYNTHESIS_RECOVERY_FAILURE: SynthesisFailure = {
  kind: "generation_failed",
  retryable: true,
};

/**
 * libSQL error codes that mean the database itself cannot be reached or
 * used: remote transport failures (HTTP/WebSocket), server-side errors,
 * and storage-level SQLite failures (I/O errors, disk full, cannot open,
 * corrupt or not-a-database, read-only, busy/locked, out of memory,
 * permission or authorization denied). Everything else — `SQLITE_ERROR`
 * malformed SQL, `SQLITE_CONSTRAINT` violations, client misuse like
 * `CLIENT_CLOSED`/`TRANSACTION_CLOSED`, URL/config errors — is a
 * programming, data, or invariant error and must never be mislabeled as
 * an outage. See `isStorageUnavailableError` for the full classification
 * contract and its documented limitation.
 */
const STORAGE_UNAVAILABLE_LIBSQL_CODES = new Set<string>([
  "SERVER_ERROR",
  "HRANA_CLOSED_ERROR",
  "HRANA_WEBSOCKET_ERROR",
  "HRANA_PROTO_ERROR",
  "PROTOCOL_VERSION_ERROR",
  "INTERNAL_ERROR",
  "UNKNOWN",
  "SQLITE_IOERR",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_PERM",
  "SQLITE_AUTH",
]);

/**
 * Node system error codes (from `errno`) and libSQL HTTP-client fetch error
 * codes that mean the storage backend could not be reached. The libSQL
 * HTTP client surfaces transport failures as raw (non-`LibsqlError`)
 * errors — for example `TypeError: fetch failed` whose `cause` carries
 * `ECONNREFUSED` under Node, or an `Error` with `code: "ConnectionRefused"`
 * under Bun — so availability classification must also recognize these codes
 * written directly on the error itself: the HTTP client surfaces transport
 * failures as the error's own `code` (e.g. `ConnectionRefused` under Bun),
 * and the undici `TypeError("fetch failed")` signature is recognized by that
 * exact message. `cause` chains are intentionally never inspected (see
 * `isStorageUnavailableError`): a programming `TypeError` carrying a
 * system-error `cause` is never misclassified as an outage. `ERR_*`
 * Node.js-internal codes and ordinary programming `TypeError`s are never
 * matched.
 */
const STORAGE_TRANSPORT_CODES = new Set<string>([
  // Node errno codes (socket/HTTP transport) and TLS/IO failures:
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EIO",
  "EMFILE",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENFILE",
  "ENOSPC",
  "ENOTFOUND",
  "EPIPE",
  "EROFS",
  "ETIMEDOUT",
  // Bun libSQL HTTP fetch error codes:
  "ConnectionAborted",
  "ConnectionClosed",
  "ConnectionRefused",
  "ConnectionReset",
  "ConnectionTimedOut",
  "HostUnreachable",
  "NameResolution",
  "NetworkUnreachable",
  "Timeout",
]);

function hasOwnTransportCode(error: unknown): boolean {
  // Matches a recognized transport/system error code written *directly* on
  // the error itself (not via `cause`). This is how Bun's libSQL HTTP client
  // surfaces transport failures (`Error` with `code: "ConnectionRefused"`,
  // `"ConnectionReset"`, ...) and how Node surfaces system errors raised
  // directly. The cause chain is intentionally not inspected here: a
  // system error buried in `cause` of an otherwise ordinary error is not, on
  // its own, evidence of an outage, and only the undici
  // `TypeError("fetch failed")` signature is trusted for Node TypeErrors
  // (see `isStorageUnavailableError`).
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && STORAGE_TRANSPORT_CODES.has(code);
}

/**
 * Whether a store failure means the storage backend is unavailable.
 * Only classified transport/server/storage failures return true; malformed
 * SQL, constraint violations, client misuse, serialization, and programming
 * errors are deliberately not classified as outages.
 *
 * Classification is code/signature based, applied only at the store
 * (infrastructure) boundary: libSQL `LibsqlError` codes, the undici
 * `TypeError("fetch failed")` signature that Node uses for every HTTP
 * transport failure, and direct transport/system `code` values (Bun's
 * `ConnectionRefused`, Node system errors). The cause chain is not
 * recursed into, so a programming `TypeError` can never be rescued by an
 * unrelated system error attached as its `cause`.
 *
 * Classification limitation: undici reports every Node HTTP failure —
 * connection refused, reset, DNS, timeout, and TLS/certificate problems —
 * through the single `TypeError("fetch failed")` signature, so all of them
 * are treated as retryable `STORAGE_UNAVAILABLE`. This cannot be narrowed
 * to "only transient network errors" without cause-chain inspection, which
 * is rejected because it would over-classify programming TypeErrors; in
 * practice a TLS/cert problem is also a transient, retryable backend
 * reachability failure, so mapping it onto `STORAGE_UNAVAILABLE` is the
 * safe, non-leaky contract.
 */
export function isStorageUnavailableError(error: unknown): boolean {
  if (error instanceof LibsqlError) {
    return STORAGE_UNAVAILABLE_LIBSQL_CODES.has(error.code);
  }
  if (error instanceof TypeError) {
    // Node/undici surfaces every HTTP transport failure from the libSQL
    // client as `TypeError("fetch failed")`; recognize that signature
    // alone (no cause inspection) so the dominant Node runtime outage is
    // classified alongside Bun, while a programming TypeError such as
    // `TypeError("undefined value")` is never mistaken for a transport
    // failure, even if it carries a system-error cause.
    return error.message === "fetch failed";
  }
  return hasOwnTransportCode(error);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS discussion (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  creation_request_id TEXT
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
        if (parsed.data.status === "generating") {
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
          continue;
        }
        // A completed Discussion whose synthesis attempt is generating: the
        // debate Transcript is durable and must stay untouched; only the
        // synthesis attempt is reconciled. Same lease rule as Turns — an
        // attempt owned by a live instance is never recovered.
        if (
          parsed.data.status === "completed" &&
          parsed.data.synthesis?.status === "generating" &&
          this.isSynthesisLeaseExpired(parsed.data.synthesis)
        ) {
          await this.recoverSynthesisAttempt(
            tx,
            String(row.id),
            parsed.data,
            updatedAt,
          );
          recovered += 1;
        }
      }

      return recovered;
    });
  }

  async create(
    ownerSessionId: string,
    discussion: DiscussionState,
    creationRequestId?: string | null,
  ): Promise<CreateDiscussionResult> {
    await this.init();
    const owner = SessionIdentifierSchema.parse(ownerSessionId);
    const state = DiscussionStateSchema.parse(discussion);

    // The write transaction makes the idempotency check-and-insert atomic
    // against concurrent identical Starts from other instances sharing the
    // same database: `BEGIN IMMEDIATE` serializes writers, so exactly one
    // transaction inserts and every later one replays. The partial unique
    // index (`discussion_creation_request`) is the database-level backstop
    // that makes the guarantee authoritative rather than process-local.
    return this.withWriteTransaction(async (tx) => {
      if (creationRequestId !== undefined && creationRequestId !== null) {
        const requestId = RequestIdentifierSchema.parse(creationRequestId);
        const existing = await tx.execute({
          sql: "SELECT state FROM discussion WHERE owner_session_id = ? AND creation_request_id = ? LIMIT 1",
          args: [owner, requestId],
        });
        const row = existing.rows[0];
        if (row) {
          return {
            kind: "replayed",
            discussion: parseStateColumn(row.state),
          };
        }
        await tx.execute({
          sql: "INSERT INTO discussion (id, owner_session_id, creation_request_id, state, updated_at) VALUES (?, ?, ?, ?, ?)",
          args: [
            state.id,
            owner,
            requestId,
            JSON.stringify(state),
            state.updatedAt,
          ],
        });
        return { kind: "created" };
      }

      await tx.execute({
        sql: "INSERT INTO discussion (id, owner_session_id, state, updated_at) VALUES (?, ?, ?, ?)",
        args: [state.id, owner, JSON.stringify(state), state.updatedAt],
      });
      return { kind: "created" };
    });
  }

  async readOwned(
    ownerSessionId: string,
    discussionId: string,
  ): Promise<DiscussionState | null> {
    await this.init();
    return this.guardStorage(() =>
      this.readOwnedState(this.client, ownerSessionId, discussionId),
    );
  }

  async requestStatus(
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): Promise<RequestStatusResult> {
    await this.init();
    const owner = SessionIdentifierSchema.parse(ownerSessionId);
    // Ownership is enforced at the persistence boundary: a request is only
    // visible when its parent Discussion belongs to `ownerSessionId`, so a
    // caller can never observe another session's request lifecycle state.
    // This mirrors the ownership contract already enforced by `readOwned`
    // and the in-memory store; unowned lookups collapse to the same
    // "not visible/not found" answer (`unknown`).
    const request = await this.guardStorage(() =>
      this.readOwnedRequest(this.client, owner, discussionId, requestId),
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

  async claimSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    updatedAt: string;
  }): Promise<ClaimSynthesisResult> {
    await this.init();
    const ownerSessionId = SessionIdentifierSchema.parse(input.ownerSessionId);
    const discussionId = DiscussionIdentifierSchema.parse(input.discussionId);
    const attemptId = RequestIdentifierSchema.parse(input.attemptId);

    return this.withWriteTransaction(async (tx) => {
      const discussion = await this.readOwnedState(
        tx,
        ownerSessionId,
        discussionId,
      );
      if (!discussion) return { kind: "not_found" };

      const existing = discussion.synthesis;
      if (existing?.status === "completed") {
        return { kind: "already_present", discussion };
      }
      if (existing?.status === "generating") {
        // A generating attempt whose lease is still valid is owned by a live
        // instance: observe it, never claim a second attempt. An expired (or
        // absent) lease means the owning process disappeared: recover it
        // transactionally into the same retryable failed state recovery
        // produces, then fall through and claim a fresh attempt so the
        // participant is not stranded until the next restart.
        if (!this.isSynthesisLeaseExpired(existing)) {
          return { kind: "in_progress", discussion };
        }
        await this.recoverSynthesisAttempt(
          tx,
          discussionId,
          discussion,
          input.updatedAt,
        );
      }
      if (existing?.status === "failed" && !existing.failure.retryable) {
        return { kind: "invalid_state", discussion };
      }
      if (discussion.status !== "completed") {
        return { kind: "invalid_state", discussion };
      }

      const claimed: DiscussionState = {
        ...discussion,
        synthesis: {
          status: "generating",
          requestId: SYNTHESIS_REQUEST_ID,
          attemptId,
          startedAt: input.updatedAt,
          updatedAt: input.updatedAt,
          leaseOwnerId: this.leaseOwnerId,
          leaseExpiresAt: new Date(
            this.now().getTime() + this.leaseDurationMs,
          ).toISOString(),
        },
      };
      await this.writeState(tx, discussionId, claimed);
      return {
        kind: "claimed",
        discussion: DiscussionStateSchema.parse(claimed),
      };
    });
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
    await this.init();
    const content = SynthesisContentSchema.parse(input.content);
    return this.withWriteTransaction(async (tx) => {
      const stored = await this.requireCurrentSynthesisAttempt(tx, input);
      if ("result" in stored) return stored.result;
      const existing = stored.discussion.synthesis;
      if (existing?.status !== "generating") {
        // Defensive: the guard above requires a generating attempt.
        return { kind: "stale", discussion: stored.discussion };
      }

      const updated: DiscussionState = {
        ...stored.discussion,
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
      };
      await this.writeState(tx, input.discussionId, updated);
      return {
        kind: "updated",
        discussion: DiscussionStateSchema.parse(updated),
      };
    });
  }

  async failSynthesis(input: {
    ownerSessionId: string;
    discussionId: string;
    attemptId: string;
    failure: SynthesisFailure;
    updatedAt: string;
  }): Promise<TurnMutationResult> {
    await this.init();
    const failure = SynthesisFailureSchema.parse(input.failure);
    return this.withWriteTransaction(async (tx) => {
      const stored = await this.requireCurrentSynthesisAttempt(tx, input);
      if ("result" in stored) return stored.result;
      const existing = stored.discussion.synthesis;
      if (existing?.status !== "generating") {
        // Defensive: the guard above requires a generating attempt.
        return { kind: "stale", discussion: stored.discussion };
      }

      const updated: DiscussionState = {
        ...stored.discussion,
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
      };
      await this.writeState(tx, input.discussionId, updated);
      return {
        kind: "updated",
        discussion: DiscussionStateSchema.parse(updated),
      };
    });
  }

  private async createSchema(): Promise<void> {
    await this.client.executeMultiple(SCHEMA_SQL);
    await this.migrateRequestLeaseColumns();
    await this.migrateCreationRequestColumn();
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
   * Adds the Start-idempotency column to databases created before the
   * feature existed and creates the partial unique index that makes the
   * (owner session, creation request identity) mapping authoritative.
   * `CREATE TABLE IF NOT EXISTS` cannot alter an existing table, so this
   * checks `PRAGMA table_info` and adds only the missing column; existing
   * rows keep `NULL` (historical Discussions predate the feature and stay
   * valid — the partial index excludes them). Both operations are
   * idempotent and safe to run concurrently from multiple instances: a
   * lost `ALTER TABLE` race surfaces as a duplicate-column error, which is
   * re-checked and ignored.
   */
  private async migrateCreationRequestColumn(): Promise<void> {
    const columns = await this.client.execute(
      "PRAGMA table_info(discussion)",
    );
    const names = new Set(columns.rows.map((row) => String(row.name)));
    if (!names.has("creation_request_id")) {
      try {
        await this.client.execute(
          "ALTER TABLE discussion ADD COLUMN creation_request_id TEXT",
        );
      } catch (error) {
        const recheck = await this.client.execute(
          "PRAGMA table_info(discussion)",
        );
        if (
          !recheck.rows.some((row) => String(row.name) === "creation_request_id")
        ) {
          throw error;
        }
      }
    }
    // The partial index lives here (after the ALTER) because legacy
    // databases that predate the column must have it added first; for fresh
    // databases the column already exists and `IF NOT EXISTS` makes the
    // create a no-op re-run. Keeping a single creation site also avoids
    // referencing the column before it exists on legacy databases.
    await this.client.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS discussion_creation_request ON discussion (owner_session_id, creation_request_id) WHERE creation_request_id IS NOT NULL",
    );
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

    return this.guardStorage(async () => {
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
    }).finally(() => {
      release();
    });
  }

  /**
   * Normalizes failures at the storage boundary: errors that mean the
   * database itself is unavailable become a typed
   * `DiscussionStorageUnavailableError`; every other error is rethrown
   * unchanged, so programming, data, and invariant errors keep their own
   * semantics and are never mislabeled as outages. Applied around every
   * client interaction (`create`, `readOwned`, `requestStatus`, and the
   * write transaction used by claim/complete/fail/cancel/stop and
   * interrupted-generation recovery).
   */
  private async guardStorage<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isStorageUnavailableError(error)) {
        throw new DiscussionStorageUnavailableError(error);
      }
      throw error;
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
   * Lease rule for a generating synthesis attempt, mirroring Turns: absent
   * (in-memory/legacy) is treated as expired; a valid lease means a live
   * instance still owns the attempt and it must not be recovered.
   */
  private isSynthesisLeaseExpired(synthesis: Extract<
    DiscussionState["synthesis"],
    { status: "generating" }
  >): boolean {
    return (
      synthesis.leaseExpiresAt === null ||
      synthesis.leaseExpiresAt < this.now().toISOString()
    );
  }

  /**
   * Converts an abandoned generating synthesis attempt into a retryable
   * failed synthesis, leaving the completed debate Transcript untouched.
   * Must be called inside the write transaction that owns the row.
   */
  private async recoverSynthesisAttempt(
    tx: Transaction,
    discussionId: string,
    discussion: DiscussionState,
    updatedAt: string,
  ): Promise<void> {
    if (discussion.synthesis?.status !== "generating") return;
    const recoveredState: DiscussionState = {
      ...discussion,
      synthesis: {
        status: "failed",
        requestId: discussion.synthesis.requestId,
        attemptId: discussion.synthesis.attemptId,
        failure: INTERRUPTED_SYNTHESIS_RECOVERY_FAILURE,
        startedAt: discussion.synthesis.startedAt,
        updatedAt,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      },
    };
    await tx.execute({
      sql: "UPDATE discussion SET state = ?, updated_at = ? WHERE id = ?",
      args: [
        JSON.stringify(recoveredState),
        recoveredState.updatedAt,
        discussionId,
      ],
    });
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

  /**
   * Reads the owned Discussion and verifies the caller's synthesis attempt is
   * still the currently persisted one. Returns the not-found result, a stale
   * result, or the verified discussion.
   */
  private async requireCurrentSynthesisAttempt(
    tx: Transaction,
    input: {
      ownerSessionId: string;
      discussionId: string;
      attemptId: string;
    },
  ): Promise<
    | { result: TurnMutationResult }
    | { discussion: DiscussionState }
  > {
    const discussion = await this.readOwnedState(
      tx,
      input.ownerSessionId,
      input.discussionId,
    );
    if (!discussion) return { result: { kind: "not_found" } };
    if (
      discussion.synthesis?.status !== "generating" ||
      discussion.synthesis.attemptId !== input.attemptId ||
      discussion.status !== "completed"
    ) {
      return { result: { kind: "stale", discussion } };
    }
    return { discussion };
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

  /**
   * Ownership-scoped request lookup used by `requestStatus`. Joins the
   * request to its parent Discussion and filters by `owner_session_id` so a
   * request that belongs to another session is indistinguishable from one
   * that does not exist (`unknown`), avoiding any leakage of lifecycle
   * state across sessions. A single query enforces both scope and lookup.
   */
  private async readOwnedRequest(
    connection: { execute: Client["execute"] },
    ownerSessionId: string,
    discussionId: string,
    requestId: string,
  ): Promise<StoredRequest | null> {
    const result = await connection.execute({
      sql: "SELECT r.turn, r.attempt_id, r.status, r.failure, r.lease_owner_id, r.lease_expires_at FROM discussion_request AS r JOIN discussion AS d ON d.id = r.discussion_id WHERE r.discussion_id = ? AND r.request_id = ? AND d.owner_session_id = ?",
      args: [discussionId, requestId, ownerSessionId],
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
