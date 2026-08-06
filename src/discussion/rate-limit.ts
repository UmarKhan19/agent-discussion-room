export interface FixedWindowRateLimiterOptions {
  /** Maximum number of accepted requests per window for one key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock in milliseconds since epoch; defaults to Date.now. */
  now?: () => number;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

interface WindowBucket {
  windowStartMs: number;
  count: number;
}

/** Bound on retained caller buckets so an attacker cannot grow memory. */
export const MAX_RATE_LIMIT_BUCKETS = 10_000;

/**
 * Fixed-window request counter keyed by caller.
 *
 * A window starts at the first request seen in a new interval, so a caller
 * that waits past the window recovers automatically. Keys are caller
 * identifiers (signed-session IDs or client network addresses) — never
 * session tokens or other secrets.
 *
 * Memory is hard-bounded: when the bucket table is at capacity, expired
 * windows are swept and a single active window is evicted so a fresh key
 * always fits. Under sustained spoofed-key pressure the eviction keeps the
 * table at MAX_RATE_LIMIT_BUCKETS, and the eviction path runs only while
 * the table stays at capacity.
 */
export class FixedWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, WindowBucket>();

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new TypeError("Rate limit must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new TypeError("Rate limit window must be a positive integer");
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /** Number of tracked caller windows; diagnostics aid for capacity checks. */
  get size(): number {
    return this.buckets.size;
  }

  check(key: string): RateLimitDecision {
    const nowMs = this.now();
    if (this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      this.sweepExpired(nowMs);
      if (this.buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        // Still at capacity: drop one window so new callers are never
        // rejected by table exhaustion rather than by the rate limit.
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined && oldestKey !== key) {
          this.buckets.delete(oldestKey);
        }
      }
    }

    const current = this.buckets.get(key);
    if (
      current === undefined ||
      nowMs >= current.windowStartMs + this.windowMs
    ) {
      this.buckets.set(key, { windowStartMs: nowMs, count: 1 });
      return { allowed: true };
    }

    if (current.count >= this.limit) {
      const retryAfterMs = current.windowStartMs + this.windowMs - nowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true };
  }

  /** Removes windows that have already elapsed; used to bound memory. */
  sweepExpired(nowMs: number = this.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.windowStartMs + this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
