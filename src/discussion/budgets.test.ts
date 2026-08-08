import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCUSSION_BUDGETS,
  DEFAULT_GENERATION_TIMEOUT_MS,
  DiscussionBudgetSchema,
  HARD_GENERATION_TIMEOUT_MS,
  HARD_MAX_CONCURRENT_GENERATIONS,
  HARD_MAX_OUTPUT_CHARACTERS,
  HARD_MAX_OUTPUT_TOKENS,
  HARD_RECENT_TRANSCRIPT_TURNS,
  HARD_SESSION_GENERATION_QUOTA,
  HARD_SESSION_GENERATION_QUOTA_WINDOW_MS,
  HARD_TRANSCRIPT_CHARACTER_BUDGET,
  RECOVERY_LEASE_GRACE_MS,
  deriveLeaseDurationMs,
  type DiscussionBudgets,
} from "./budgets";

describe("Discussion generation budgets", () => {
  it("validates the safe defaults as a complete server configuration", () => {
    expect(DiscussionBudgetSchema.parse(DEFAULT_DISCUSSION_BUDGETS)).toEqual(
      DEFAULT_DISCUSSION_BUDGETS,
    );
  });

  it.each<[keyof DiscussionBudgets, number]>([
    ["recentTranscriptTurns", HARD_RECENT_TRANSCRIPT_TURNS],
    ["transcriptCharacterBudget", HARD_TRANSCRIPT_CHARACTER_BUDGET],
    ["maxOutputTokens", HARD_MAX_OUTPUT_TOKENS],
    ["maxOutputCharacters", HARD_MAX_OUTPUT_CHARACTERS],
    ["generationTimeoutMs", HARD_GENERATION_TIMEOUT_MS],
    ["maxConcurrentGenerations", HARD_MAX_CONCURRENT_GENERATIONS],
    ["sessionGenerationQuota", HARD_SESSION_GENERATION_QUOTA],
    ["sessionGenerationQuotaWindowMs", HARD_SESSION_GENERATION_QUOTA_WINDOW_MS],
  ])(
    "accepts exactly the hard maximum for %s and rejects anything above it",
    (field, hardMaximum) => {
      const atMaximum = {
        ...DEFAULT_DISCUSSION_BUDGETS,
        [field]: hardMaximum,
      };
      expect(DiscussionBudgetSchema.parse(atMaximum)[field]).toBe(hardMaximum);
      expect(
        DiscussionBudgetSchema.safeParse({
          ...DEFAULT_DISCUSSION_BUDGETS,
          [field]: hardMaximum + 1,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects zero, negative, fractional, and unknown budget values", () => {
    for (const field of Object.keys(
      DEFAULT_DISCUSSION_BUDGETS,
    ) as Array<keyof DiscussionBudgets>) {
      for (const invalid of [0, -1, 1.5]) {
        expect(
          DiscussionBudgetSchema.safeParse({
            ...DEFAULT_DISCUSSION_BUDGETS,
            [field]: invalid,
          }).success,
        ).toBe(false);
      }
    }
    expect(
      DiscussionBudgetSchema.safeParse({
        ...DEFAULT_DISCUSSION_BUDGETS,
        clientTokenLimit: 1_000_000,
      }).success,
    ).toBe(false);
  });

  it("never lets the output-character ceiling exceed the persisted Message limit", () => {
    expect(HARD_MAX_OUTPUT_CHARACTERS).toBeLessThanOrEqual(12_000);
  });

  it("derives the recovery lease strictly above every generation timeout", () => {
    // The lease must always outlive the legitimate generation lifetime:
    // the timeout supplied to the store plus the fixed recovery margin.
    // There is no independent lease-duration knob; production composition
    // passes the same generation timeout to the store and the Runner, and
    // direct callers must keep the two values in step for the invariant
    // to hold.
    expect(deriveLeaseDurationMs(DEFAULT_GENERATION_TIMEOUT_MS)).toBe(
      DEFAULT_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS,
    );
    expect(deriveLeaseDurationMs(HARD_GENERATION_TIMEOUT_MS)).toBe(
      HARD_GENERATION_TIMEOUT_MS + RECOVERY_LEASE_GRACE_MS,
    );
    for (const timeout of [1, 5_000, 61_000, HARD_GENERATION_TIMEOUT_MS]) {
      expect(deriveLeaseDurationMs(timeout)).toBe(
        timeout + RECOVERY_LEASE_GRACE_MS,
      );
      expect(deriveLeaseDurationMs(timeout)).toBeGreaterThan(timeout);
    }
  });
});
