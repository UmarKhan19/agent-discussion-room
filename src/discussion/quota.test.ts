import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SESSION_QUOTA_ENTRIES,
  QUOTA_SWEEP_INTERVAL,
  SessionGenerationQuota,
} from "./quota";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUOTA = 3;
const WINDOW_MS = 60_000; // 1 minute for fast tests

describe("SessionGenerationQuota", () => {
  let nowMs: number;
  const clock = () => nowMs;

  afterEach(() => {
    nowMs = 0;
  });

  function createQuota(): SessionGenerationQuota {
    return new SessionGenerationQuota(QUOTA, WINDOW_MS, clock);
  }

  describe("unique generations consume quota", () => {
    it("allows up to the configured quota, then exhausts", () => {
      nowMs = 0;
      const quota = createQuota();

      // First QUOTA unique keys are allowed.
      for (let turn = 0; turn < QUOTA; turn += 1) {
        expect(quota.check(SESSION_ID, `discussion-${turn}/request-${turn}`)).toEqual({
          kind: "allowed",
        });
        quota.attemptCharge(SESSION_ID, `discussion-${turn}/request-${turn}`);
      }

      // The (QUOTA+1)th unique key is exhausted.
      const exhausted = quota.check(
        SESSION_ID,
        "discussion-99/request-99",
      );
      expect(exhausted).toMatchObject({ kind: "exhausted" });
      expect(exhausted).toHaveProperty("retryAfterSeconds");
      expect(
        (exhausted as { kind: "exhausted"; retryAfterSeconds: number })
          .retryAfterSeconds,
      ).toBeGreaterThan(0);
    });

    it("reports a positive retry-after up to the remaining window", () => {
      // Charge at t=0 (window expires at WINDOW_MS).
      nowMs = 0;
      const quota = createQuota();

      for (let turn = 0; turn < QUOTA; turn += 1) {
        quota.attemptCharge(SESSION_ID, `key-${turn}`);
      }

      // 10 seconds into the window: ~50s remaining.
      nowMs = 10_000;
      const result = quota.check(SESSION_ID, "new-key");
      expect(result).toMatchObject({ kind: "exhausted" });
      // Window started at t=0, so ~50s remaining → retryAfterSeconds ~50.
      expect(
        (result as { kind: "exhausted"; retryAfterSeconds: number })
          .retryAfterSeconds,
      ).toBeGreaterThanOrEqual(49);
      expect(
        (result as { kind: "exhausted"; retryAfterSeconds: number })
          .retryAfterSeconds,
      ).toBeLessThanOrEqual(50);
    });

    it("never reports a zero or negative retry interval", () => {
      // Charge at t=0 so the window expires at WINDOW_MS.
      nowMs = 0;
      const quota = createQuota();

      for (let turn = 0; turn < QUOTA; turn += 1) {
        quota.attemptCharge(SESSION_ID, `key-${turn}`);
      }

      // 500ms before expiry: retry-after must still round up to at least 1.
      nowMs = WINDOW_MS - 500;
      const result = quota.check(SESSION_ID, "new-key");
      expect(
        (result as { kind: "exhausted"; retryAfterSeconds: number })
          .retryAfterSeconds,
      ).toBe(1);
    });
  });

  describe("same logical request is charged once", () => {
    it("allows replaying an already-charged key without consuming allowance", () => {
      nowMs = 0;
      const quota = createQuota();

      quota.attemptCharge(SESSION_ID, "discussion-1/request-1");
      quota.attemptCharge(SESSION_ID, "discussion-1/request-1"); // same key, no-op
      quota.attemptCharge(SESSION_ID, "discussion-1/request-2");
      quota.attemptCharge(SESSION_ID, "discussion-1/request-3");

      // Already charged — idempotent, no new allowance consumed.
      expect(quota.check(SESSION_ID, "discussion-1/request-1")).toEqual({
        kind: "allowed",
      });
      // Quota (3) is now exhausted; a new key is blocked.
      expect(
        quota.check(SESSION_ID, "discussion-1/request-4"),
      ).toMatchObject({
        kind: "exhausted",
      });
    });

    it("check does not create a session entry, so a rejected-then-retried path stays clean", () => {
      nowMs = 0;
      const quota = createQuota();

      // Multiple checks without any charges leave the Map empty.
      quota.check(SESSION_ID, "key-1");
      quota.check(SESSION_ID, "key-1");
      quota.check(SESSION_ID, "key-2");

      expect(quota.size).toBe(0);

      // Charging creates exactly one entry.
      quota.attemptCharge(SESSION_ID, "key-1");
      expect(quota.size).toBe(1);
    });
  });

  describe("attemptCharge is the authoritative mutation", () => {
    it("commits a fresh key as charged and never exceeds the quota", () => {
      nowMs = 0;
      const quota = createQuota();

      // Fill the quota, then race two new keys for the (now zero) remaining
      // slots. The first commits; the second is rejected by the atomic
      // re-check even though no separate check() call happened.
      for (let turn = 0; turn < QUOTA; turn += 1) {
        expect(
          quota.attemptCharge(SESSION_ID, `key-${turn}`),
        ).toEqual({ kind: "charged" });
      }

      const winner = quota.attemptCharge(SESSION_ID, "winner");
      const loser = quota.attemptCharge(SESSION_ID, "loser");
      expect(winner).toMatchObject({ kind: "quotaExceeded" });
      expect(loser).toMatchObject({ kind: "quotaExceeded" });
      expect(quota.chargedCount(SESSION_ID)).toBe(QUOTA);
    });

    it("with one slot remaining, at most one of two new keys is charged", () => {
      nowMs = 0;
      const quota = createQuota();

      // Charge QUOTA - 1 keys: exactly one slot remains.
      for (let turn = 0; turn < QUOTA - 1; turn += 1) {
        expect(
          quota.attemptCharge(SESSION_ID, `key-${turn}`),
        ).toEqual({ kind: "charged" });
      }

      // Two new unique keys race for the final slot: the first commits,
      // the second is atomically rejected — exactly like two concurrent
      // requests that both passed the advisory check.
      const first = quota.attemptCharge(SESSION_ID, "race-a");
      const second = quota.attemptCharge(SESSION_ID, "race-b");
      expect(first).toEqual({ kind: "charged" });
      expect(second).toMatchObject({ kind: "quotaExceeded" });
      expect(quota.chargedCount(SESSION_ID)).toBe(QUOTA);
    });

    it("alreadyCharged is idempotent and consumes no allowance", () => {
      nowMs = 0;
      const quota = createQuota();

      expect(quota.attemptCharge(SESSION_ID, "key-1")).toEqual({
        kind: "charged",
      });
      // Same key again — idempotent retry, no new charge.
      expect(quota.attemptCharge(SESSION_ID, "key-1")).toEqual({
        kind: "alreadyCharged",
      });
      expect(quota.chargedCount(SESSION_ID)).toBe(1);

      // Fill the remaining allowance; an already-charged key still passes.
      for (let turn = 2; turn <= QUOTA; turn += 1) {
        quota.attemptCharge(SESSION_ID, `key-${turn}`);
      }
      expect(quota.chargedCount(SESSION_ID)).toBe(QUOTA);
      expect(quota.attemptCharge(SESSION_ID, "key-1")).toEqual({
        kind: "alreadyCharged",
      });
      // ...while a genuinely new key is rejected.
      expect(quota.attemptCharge(SESSION_ID, "new-key")).toMatchObject({
        kind: "quotaExceeded",
      });
    });

    it("chargedCount reports 0 for unknown or expired sessions", () => {
      nowMs = 0;
      const quota = createQuota();

      expect(quota.chargedCount(SESSION_ID)).toBe(0);
      quota.attemptCharge(SESSION_ID, "key-1");
      expect(quota.chargedCount(SESSION_ID)).toBe(1);

      nowMs += WINDOW_MS + 1;
      expect(quota.chargedCount(SESSION_ID)).toBe(0);
    });
  });

  describe("window expiration restores quota", () => {
    it("restores the full allowance once the window elapses", () => {
      nowMs = 0;
      const quota = createQuota();

      for (let turn = 0; turn < QUOTA; turn += 1) {
        quota.attemptCharge(SESSION_ID, `key-${turn}`);
      }

      // Exhausted in the current window.
      expect(quota.check(SESSION_ID, "key-new")).toMatchObject({
        kind: "exhausted",
      });

      // Advance past the window.
      nowMs += WINDOW_MS + 1;

      // Fresh window — full allowance restored.
      expect(quota.check(SESSION_ID, "key-new")).toEqual({ kind: "allowed" });
      quota.attemptCharge(SESSION_ID, "key-new");
      expect(quota.check(SESSION_ID, "key-newer")).toEqual({
        kind: "allowed",
      });
      quota.attemptCharge(SESSION_ID, "key-newer");
      expect(quota.check(SESSION_ID, "key-newest")).toEqual({
        kind: "allowed",
      });
      quota.attemptCharge(SESSION_ID, "key-newest");
      // Quota (3) is now exhausted in the fresh window.
      expect(quota.check(SESSION_ID, "key-overflow")).toMatchObject({
        kind: "exhausted",
      });
    });

    it("old charge keys from the previous window no longer consume memory or quota", () => {
      nowMs = 0;
      const quota = createQuota();

      for (let turn = 0; turn < QUOTA; turn += 1) {
        quota.attemptCharge(SESSION_ID, `key-${turn}`);
      }
      expect(quota.size).toBe(1);

      nowMs += WINDOW_MS + 1;

      // A new charge in the fresh window replaces the entry, discarding
      // the old Set of charge keys.
      quota.attemptCharge(SESSION_ID, "new-key");
      expect(quota.size).toBe(1);
    });

    it("resets quota independently per session", () => {
      nowMs = 0;
      const quota = createQuota();

      // Session A exhausts its quota at t=0 (window: 0 -> 60s).
      quota.attemptCharge(SESSION_ID, "a-key-1");
      quota.attemptCharge(SESSION_ID, "a-key-2");
      quota.attemptCharge(SESSION_ID, "a-key-3");

      // Session B charges one key at t=30s (window: 30s -> 90s).
      nowMs = 30_000;
      quota.attemptCharge(OTHER_SESSION, "b-key-1");

      // At t=30s: A is exhausted (3 keys, window not expired), B has room.
      expect(quota.check(SESSION_ID, "a-key-4")).toMatchObject({
        kind: "exhausted",
      });
      expect(quota.check(OTHER_SESSION, "b-key-2")).toEqual({
        kind: "allowed",
      });

      // Advance to t=60s+1: A's window expired, B's window still active.
      nowMs = WINDOW_MS + 1;

      // A: fresh window, full allowance.
      expect(quota.check(SESSION_ID, "a-key-4")).toEqual({
        kind: "allowed",
      });
      // B: still in its window (30s -> 90s), room available.
      expect(quota.check(OTHER_SESSION, "b-key-2")).toEqual({
        kind: "allowed",
      });
    });
  });

  describe("memory cleanup", () => {
    it("active session is not cleaned up by another session's sweep", () => {
      nowMs = 0;
      const quota = createQuota();

      quota.attemptCharge(SESSION_ID, "key-1");
      quota.attemptCharge(OTHER_SESSION, "key-1");
      expect(quota.size).toBe(2);

      // Advance time but NOT past the window — entries are still active.
      nowMs += WINDOW_MS - 1;

      // Trigger a sweep via maybeSweep (reaches the interval).
      for (let i = 0; i < QUOTA_SWEEP_INTERVAL; i += 1) {
        quota.check(`dummy-${i}`, `dummy-key-${i}`);
      }

      // Both sessions still present — the sweep should not have removed
      // entries whose window is still valid.
      expect(quota.size).toBe(2);
    });

    it("abandoned sessions are swept after the window elapses", () => {
      nowMs = 0;
      const quota = createQuota();

      // Create sessions with charge keys.
      for (let i = 0; i < 100; i += 1) {
        quota.attemptCharge(`session-${i}`, `key-${i}`);
      }
      expect(quota.size).toBe(100);

      // All windows expire.
      nowMs += WINDOW_MS + 1;

      // Trigger a periodic sweep.
      for (let i = 0; i < QUOTA_SWEEP_INTERVAL; i += 1) {
        quota.check(`dummy-${i}`, `dummy-key-${i}`);
      }

      expect(quota.size).toBe(0);
    });

    it("periodically sweeps expired entries even below the hard cap", () => {
      nowMs = 0;
      const quota = createQuota();

      // Create 50 sessions (well below MAX = 10_000). Charges count as
      // operations toward the amortized sweep cadence, so the counter is at
      // 50 after this loop.
      for (let i = 0; i < 50; i += 1) {
        quota.attemptCharge(`session-${i}`, `key-${i}`);
      }
      expect(quota.size).toBe(50);

      // All windows expire.
      nowMs += WINDOW_MS + 1;

      // Drive operations up to the 128-operation sweep threshold (50 charges
      // already elapsed, so 77 more checks land at 127 total operations).
      // Just before the threshold, entries are still present.
      for (let i = 0; i < 77; i += 1) {
        quota.check(`dummy-${i}`, `dummy-key-${i}`);
      }
      expect(quota.size).toBe(50); // not yet swept

      // One more call triggers the sweep.
      quota.check("trigger", "trigger-key");
      // Old entries swept; check does not create an entry, so size is 0.
      expect(quota.size).toBe(0);
    });

    it("bounds the session table at MAX_SESSION_QUOTA_ENTRIES", () => {
      nowMs = 0;
      const quota = createQuota();

      // Fill beyond the hard cap. Each charge calls enforceCapacity which
      // sweeps expired entries and then evicts the oldest if still at cap.
      for (let i = 0; i < MAX_SESSION_QUOTA_ENTRIES + 100; i += 1) {
        quota.attemptCharge(`session-${i}`, `key-${i}`);
      }

      expect(quota.size).toBeLessThanOrEqual(MAX_SESSION_QUOTA_ENTRIES);
    });

    it("never evicts the session currently being charged at capacity", () => {
      nowMs = 0;
      const quota = createQuota();

      // Fill to the hard cap.
      for (let i = 0; i < MAX_SESSION_QUOTA_ENTRIES; i += 1) {
        quota.attemptCharge(`session-${i}`, `key-${i}`);
      }
      expect(quota.size).toBe(MAX_SESSION_QUOTA_ENTRIES);

      // Charging a new session evicts the oldest, but NOT the new one.
      quota.attemptCharge("new-session", "new-key");
      expect(quota.size).toBe(MAX_SESSION_QUOTA_ENTRIES);
      expect(quota.check("new-session", "another-key")).toEqual({
        kind: "allowed",
      });

      // The evicted session's data is gone.
      expect(quota.check("session-0", "post-eviction-key")).toEqual({
        kind: "allowed",
      });
    });
  });

  describe("invalid configuration", () => {
    it("rejects a non-positive quota", () => {
      expect(
        () => new SessionGenerationQuota(0, WINDOW_MS, clock),
      ).toThrow();
      expect(
        () => new SessionGenerationQuota(-1, WINDOW_MS, clock),
      ).toThrow();
    });

    it("rejects a non-positive window", () => {
      expect(
        () => new SessionGenerationQuota(QUOTA, 0, clock),
      ).toThrow();
      expect(
        () => new SessionGenerationQuota(QUOTA, -1, clock),
      ).toThrow();
    });
  });
});
