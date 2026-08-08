import { z } from "zod";
import { MESSAGE_MAX_LENGTH } from "./contracts";

/**
 * Server-owned generation budgets.
 *
 * Every ceiling has a safe default and a hard maximum. Environment
 * configuration may lower a budget but can never raise it past the hard
 * maximum, and clients cannot submit any budget at all. The Turn limit is
 * configured through `DiscussionService` (see `DEFAULT_DISCUSSION_TURN_LIMIT`
 * and `HARD_DISCUSSION_TURN_LIMIT`) and is listed here only so the full
 * operator-facing budget surface stays in one place.
 */

/** How many most-recent completed Turns may be sent to the model. */
export const DEFAULT_RECENT_TRANSCRIPT_TURNS = 8;
export const HARD_RECENT_TRANSCRIPT_TURNS = 32;

/** Maximum characters of recent Transcript sent to the model (input ceiling). */
export const DEFAULT_TRANSCRIPT_CHARACTER_BUDGET = 32_000;
export const HARD_TRANSCRIPT_CHARACTER_BUDGET = 64_000;

/**
 * Maximum characters of Transcript provided as synthesis context (input
 * ceiling). The synthesis ideally reads the whole debate, so this is larger
 * than the per-Turn recent window; the Discussion is hard-capped at the Turn
 * limit and per-Turn output, so normally the full Transcript fits and only
 * an unusually verbose debate falls back to a bounded recent selection.
 */
export const DEFAULT_SYNTHESIS_TRANSCRIPT_CHARACTER_BUDGET = 48_000;
export const HARD_SYNTHESIS_TRANSCRIPT_CHARACTER_BUDGET = 64_000;

/** Output-token ceiling passed to the provider when it supports one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
export const HARD_MAX_OUTPUT_TOKENS = 8_000;

/** Output-character ceiling enforced after generation; never exceeds the persisted Message limit. */
export const DEFAULT_MAX_OUTPUT_CHARACTERS = 8_000;
export const HARD_MAX_OUTPUT_CHARACTERS = MESSAGE_MAX_LENGTH;

/** Hard duration ceiling for one generation. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 30_000;
export const HARD_GENERATION_TIMEOUT_MS = 300_000;

/**
 * Fixed safety margin added to the configured generation timeout to form
 * the recovery-lease duration of a claimed attempt. A live instance's own
 * hard timeout always fires before the lease expires, so the lease is
 * exclusively the signal that the owning process disappeared. The margin
 * absorbs scheduling latency, store round-trips, and event-loop stalls,
 * plus moderate clock skew between instances; it is not a substitute for
 * time synchronization (substantial owner-behind skew can still cause a
 * healthy attempt to be recovered early). Production instances are
 * expected to run reasonably synchronized clocks (normal platform/NTP
 * synchronization). Not operator-configurable: the generation timeout
 * environment variable effectively controls the lease length.
 */
export const RECOVERY_LEASE_GRACE_MS = 60_000;

/**
 * Single derivation of the recovery-lease duration from a configured
 * generation timeout: the timeout plus the fixed safety margin. The lease
 * is therefore derived from the generation timeout supplied to the store,
 * and there is no independent lease-duration knob or default that could
 * silently drift out of sync with that timeout. Production composition
 * passes the same `generationTimeoutMs` to both the store and the Runner,
 * so the invariant "lease duration outlives a legitimate generation
 * lifetime" holds there. Direct callers are still responsible for
 * supplying the same generation timeout to the store and the Runner;
 * deriving the lease through this function alone cannot guarantee that.
 */
export function deriveLeaseDurationMs(generationTimeoutMs: number): number {
  return generationTimeoutMs + RECOVERY_LEASE_GRACE_MS;
}

/** Process-wide simultaneous generations across all Discussions. */
export const DEFAULT_MAX_CONCURRENT_GENERATIONS = 4;
export const HARD_MAX_CONCURRENT_GENERATIONS = 16;

/** Model-generating requests one signed session may claim per time window. */
export const DEFAULT_SESSION_GENERATION_QUOTA = 500;
export const HARD_SESSION_GENERATION_QUOTA = 10_000;

/**
 * Time window (ms) over which a session's generation quota is measured.
 * After the window elapses, charged request keys are discarded and the
 * session receives a fresh allowance, making "try again later" truthful.
 * The hard maximum matches the anonymous session cookie Max-Age (30 days).
 */
export const DEFAULT_SESSION_GENERATION_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HARD_SESSION_GENERATION_QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const DiscussionBudgetSchema = z
  .object({
    recentTranscriptTurns: z
      .number()
      .int()
      .positive()
      .max(HARD_RECENT_TRANSCRIPT_TURNS),
    transcriptCharacterBudget: z
      .number()
      .int()
      .positive()
      .max(HARD_TRANSCRIPT_CHARACTER_BUDGET),
    synthesisTranscriptCharacterBudget: z
      .number()
      .int()
      .positive()
      .max(HARD_SYNTHESIS_TRANSCRIPT_CHARACTER_BUDGET),
    maxOutputTokens: z.number().int().positive().max(HARD_MAX_OUTPUT_TOKENS),
    maxOutputCharacters: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_OUTPUT_CHARACTERS),
    generationTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(HARD_GENERATION_TIMEOUT_MS),
    maxConcurrentGenerations: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_CONCURRENT_GENERATIONS),
    sessionGenerationQuota: z
      .number()
      .int()
      .positive()
      .max(HARD_SESSION_GENERATION_QUOTA),
    sessionGenerationQuotaWindowMs: z
      .number()
      .int()
      .positive()
      .max(HARD_SESSION_GENERATION_QUOTA_WINDOW_MS),
  })
  .strict();

export type DiscussionBudgets = z.infer<typeof DiscussionBudgetSchema>;

export const DEFAULT_DISCUSSION_BUDGETS: DiscussionBudgets = {
  recentTranscriptTurns: DEFAULT_RECENT_TRANSCRIPT_TURNS,
  transcriptCharacterBudget: DEFAULT_TRANSCRIPT_CHARACTER_BUDGET,
  synthesisTranscriptCharacterBudget:
    DEFAULT_SYNTHESIS_TRANSCRIPT_CHARACTER_BUDGET,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  maxOutputCharacters: DEFAULT_MAX_OUTPUT_CHARACTERS,
  generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
  maxConcurrentGenerations: DEFAULT_MAX_CONCURRENT_GENERATIONS,
  sessionGenerationQuota: DEFAULT_SESSION_GENERATION_QUOTA,
  sessionGenerationQuotaWindowMs:
    DEFAULT_SESSION_GENERATION_QUOTA_WINDOW_MS,
};
