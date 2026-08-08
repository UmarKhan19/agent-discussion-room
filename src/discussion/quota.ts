/**
 * Per-session generation quota with a time-window lifecycle.
 *
 * The quota guards aggregate provider cost for anonymous sessions: each
 * signed session may charge at most `sessionQuota` unique logical
 * generations during one time window. A logical generation is one model
 * invocation — an ordinary next-Turn generation (charge key
 * `discussionId/requestId`) or the one completion synthesis of a naturally
 * completed Discussion (charge key `discussionId/synthesis`). When the
 * window elapses the charge keys are discarded and the session receives a
 * fresh allowance, so "try again later" is truthful.
 *
 * Memory lifecycle:
 *
 * - Each session entry carries its own `expiresAt` wall-clock reading (ms
 *   since epoch). Entries are checked for expiry on every access (lazy
 *   per-session expiration), so a returning session is always evaluated
 *   against the correct window.
 * - A full sweep of expired entries runs on an amortized cadence (every
 *   `QUOTA_SWEEP_INTERVAL` operations), so sessions that never return again
 *   are still reclaimed from process memory — not merely lazily expired on
 *   their next visit. This is the mechanism that bounds the outer Map for
 *   abandoned anonymous sessions.
 * - A hard entry cap (`MAX_SESSION_QUOTA_ENTRIES`) is a last-resort safety
 *   valve: when the table is at capacity, an immediate sweep of expired
 *   entries runs, and only if space is still unavailable is the least
 *   recently inserted entry evicted (never the one currently being
 *   processed). Because the cap matches the rate limiter's table bound,
 *   eviction only occurs under extreme spoofed-session pressure.
 *
 * These mechanics mirror {@link FixedWindowRateLimiter} so the two
 * protections share one tested cleanup pattern without coupling their
 * semantics: rate limiting guards HTTP burst frequency, while this quota
 * guards per-session generation cost.
 *
 * The synthesis charge key is deliberately not a Turn request key: the
 * same logical synthesis retried, replayed, or resumed after a restart
 * always reuses `discussionId/synthesis`, so it is charged at most once
 * per Discussion while retries never double-charge.
 */

/** Bound on retained session quota entries (matches the rate limiter cap). */
export const MAX_SESSION_QUOTA_ENTRIES = 10_000;

/** Sweep expired entries every this many operations (amortized O(1) per call). */
export const QUOTA_SWEEP_INTERVAL = 128;

/** A single session's quota state within one time window. */
export interface SessionQuotaEntry {
  /** Wall-clock time (ms since epoch) when this entry's window expires. */
  expiresAt: number;
  /** Charge keys charged in the current window: `discussionId/requestId`. */
  chargedKeys: Set<string>;
}

export type QuotaCheckResult =
  | { kind: "allowed" }
  | { kind: "exhausted"; retryAfterSeconds: number };

/**
 * Result of an atomic charge attempt. The final mutation that records a
 * charge is authoritative: it re-validates the session's current window
 * state and never exceeds the configured quota.
 */
export type QuotaChargeResult =
  | { kind: "charged" }
  | { kind: "alreadyCharged" }
  | { kind: "quotaExceeded"; retryAfterSeconds: number };

/**
 * Process-local, time-windowed generation quota tracker for anonymous
 * sessions. A session may charge at most `sessionQuota` unique keys per
 * `windowMs`; expired windows and abandoned sessions are reclaimed
 * automatically.
 */
export class SessionGenerationQuota {
  private readonly sessions = new Map<string, SessionQuotaEntry>();
  private sweepCounter = 0;

  constructor(
    private readonly sessionQuota: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(sessionQuota) || sessionQuota < 1) {
      throw new TypeError("sessionQuota must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError("windowMs must be a positive integer");
    }
  }

  /** Number of tracked sessions; a diagnostics aid. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Number of charge keys recorded for `sessionId` in its current window;
   * 0 when the session is unknown or its window has expired. A diagnostics
   * aid for tests and observability, never used for enforcement.
   */
  chargedCount(sessionId: string): number {
    const nowMs = this.now();
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.expiresAt <= nowMs) return 0;
    return entry.chargedKeys.size;
  }

  /**
   * Checks whether `chargeKey` may be charged for `sessionId` without
   * exceeding the per-session quota in the current window.
   *
   * - A session whose window has expired (or that was never seen) has a
   *   full allowance and may always charge.
   * - A key already charged in the current window is idempotent: it returns
   *   "allowed" without consuming additional allowance, so retried and
   *   replayed requests are never double-charged.
   * - When the session has exhausted its quota and the key is new, the
   *   result is "exhausted" with a `retryAfterSeconds` hint until the
   *   window resets.
   *
   * This method never creates an entry for the queried session and never
   * records a charge, so a quota check that is later rejected (e.g. by
   * capacity exhaustion) leaves no quota bookkeeping behind. It is an
   * advisory fast-path: the authoritative decision is made atomically by
   * {@link attemptCharge}, which re-validates the current window state
   * after capacity has been acquired.
   */
  check(sessionId: string, chargeKey: string): QuotaCheckResult {
    const nowMs = this.now();
    this.maybeSweep(nowMs);
    this.enforceCapacity(nowMs, sessionId);

    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.expiresAt <= nowMs) {
      return { kind: "allowed" };
    }

    // Already charged in this window — idempotent replay.
    if (entry.chargedKeys.has(chargeKey)) {
      return { kind: "allowed" };
    }

    if (entry.chargedKeys.size >= this.sessionQuota) {
      return {
        kind: "exhausted",
        retryAfterSeconds: this.retryAfterSeconds(entry, nowMs),
      };
    }

    return { kind: "allowed" };
  }

  /**
   * Atomically re-validates the session's current window state and, when a
   * charge is due, records it. This is the authoritative quota mutation:
   * it must be called after generation capacity has been acquired and
   * immediately before provider work starts, so rejected and replayed
   * attempts never consume quota and the final slot can never be over-
   * committed by a concurrent request whose earlier {@link check} observed
   * stale state.
   *
   * Results:
   *
   * - `charged` — the key was new and the charge was recorded.
   * - `alreadyCharged` — the key was already charged in the current
   *   window; an idempotent retry that proceeds without consuming
   *   additional allowance.
   * - `quotaExceeded` — the session is at its allowance and the key is
   *   new; nothing was recorded. The caller must not start provider work
   *   and should report the quota error with the given retry hint.
   *
   * A window that expired between {@link check} and `attemptCharge` starts
   * a fresh window automatically (and charges there).
   */
  attemptCharge(sessionId: string, chargeKey: string): QuotaChargeResult {
    const nowMs = this.now();
    this.maybeSweep(nowMs);
    this.enforceCapacity(nowMs, sessionId);

    const current = this.sessions.get(sessionId);
    if (current === undefined || current.expiresAt <= nowMs) {
      this.sessions.set(sessionId, {
        expiresAt: nowMs + this.windowMs,
        chargedKeys: new Set([chargeKey]),
      });
      return { kind: "charged" };
    }

    // Already charged in this window — idempotent retry, no new charge.
    if (current.chargedKeys.has(chargeKey)) {
      return { kind: "alreadyCharged" };
    }

    if (current.chargedKeys.size >= this.sessionQuota) {
      return {
        kind: "quotaExceeded",
        retryAfterSeconds: this.retryAfterSeconds(current, nowMs),
      };
    }

    current.chargedKeys.add(chargeKey);
    return { kind: "charged" };
  }

  private retryAfterSeconds(entry: SessionQuotaEntry, nowMs: number): number {
    return Math.max(1, Math.ceil((entry.expiresAt - nowMs) / 1000));
  }

  /** Resets all state. Intended for test isolation only. */
  clear(): void {
    this.sessions.clear();
    this.sweepCounter = 0;
  }

  /**
   * Amortized periodic sweep: every `QUOTA_SWEEP_INTERVAL` operations,
   * expired entries are removed. This reclaims abandoned sessions that
   * never return, bounding the outer Map below the hard cap.
   */
  private maybeSweep(nowMs: number): void {
    this.sweepCounter += 1;
    if (this.sweepCounter >= QUOTA_SWEEP_INTERVAL) {
      this.sweepCounter = 0;
      this.sweepExpired(nowMs);
    }
  }

  /**
   * Hard-cap safety valve. When the table is at capacity, expired entries
   * are swept first (they are pure waste). If space is still unavailable,
   * the oldest non-current entry is evicted so a new caller always fits.
   * This mirrors {@link FixedWindowRateLimiter.check}.
   */
  private enforceCapacity(nowMs: number, exceptSessionId: string): void {
    if (this.sessions.size < MAX_SESSION_QUOTA_ENTRIES) return;

    this.sweepExpired(nowMs);
    if (this.sessions.size < MAX_SESSION_QUOTA_ENTRIES) return;

    // Still at capacity: evict the oldest entry (insertion order), skipping
    // the session currently being processed.
    for (const sessionId of this.sessions.keys()) {
      if (sessionId !== exceptSessionId) {
        this.sessions.delete(sessionId);
        return;
      }
    }
  }

  /** Removes every entry whose time window has elapsed. */
  private sweepExpired(nowMs: number): void {
    for (const [sessionId, entry] of this.sessions) {
      if (nowMs >= entry.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
