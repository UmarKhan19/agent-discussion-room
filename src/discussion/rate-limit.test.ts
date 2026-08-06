import { beforeEach, describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit";

describe("FixedWindowRateLimiter", () => {
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(() => {
    nowMs = 0;
  });

  it("accepts exactly the configured number of requests in a window", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 3,
      windowMs: 60_000,
      now: clock,
    });

    expect(limiter.check("caller")).toEqual({ allowed: true });
    expect(limiter.check("caller")).toEqual({ allowed: true });
    expect(limiter.check("caller")).toEqual({ allowed: true });
    expect(limiter.check("caller")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("reports whole seconds until the window resets", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: clock,
    });
    limiter.check("caller");

    nowMs = 15_000;
    expect(limiter.check("caller")).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });

    nowMs = 59_999;
    expect(limiter.check("caller")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });

    nowMs = 60_000;
    expect(limiter.check("caller")).toEqual({ allowed: true });
  });

  it("recovers automatically once a caller waits past the window", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 30_000,
      now: clock,
    });

    expect(limiter.check("caller").allowed).toBe(true);
    expect(limiter.check("caller").allowed).toBe(false);

    nowMs = 30_000;
    expect(limiter.check("caller").allowed).toBe(true);
    expect(limiter.check("caller").allowed).toBe(false);

    nowMs = 60_000;
    expect(limiter.check("caller").allowed).toBe(true);
  });

  it("tracks independent callers separately without cross-consumption", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: clock,
    });

    expect(limiter.check("caller-a").allowed).toBe(true);
    expect(limiter.check("caller-b").allowed).toBe(true);
    expect(limiter.check("caller-a").allowed).toBe(false);
    expect(limiter.check("caller-b").allowed).toBe(false);
    expect(limiter.check("caller-c").allowed).toBe(true);
  });

  it("never reports a zero or negative retry interval", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: clock,
    });
    limiter.check("caller");

    nowMs = 999;
    expect(limiter.check("caller")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("drops expired windows during a sweep", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: clock,
    });
    limiter.check("caller");
    expect(limiter.check("caller").allowed).toBe(false);

    nowMs = 60_000;
    limiter.sweepExpired();

    expect(limiter.check("caller").allowed).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(
      () =>
        new FixedWindowRateLimiter({ limit: 0, windowMs: 1000, now: clock }),
    ).toThrow();
    expect(
      () =>
        new FixedWindowRateLimiter({ limit: 1.5, windowMs: 1000, now: clock }),
    ).toThrow();
    expect(
      () =>
        new FixedWindowRateLimiter({ limit: 1, windowMs: 0, now: clock }),
    ).toThrow();
  });
});
