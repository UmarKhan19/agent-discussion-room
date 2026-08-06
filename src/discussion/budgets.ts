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

/** Output-token ceiling passed to the provider when it supports one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
export const HARD_MAX_OUTPUT_TOKENS = 8_000;

/** Output-character ceiling enforced after generation; never exceeds the persisted Message limit. */
export const DEFAULT_MAX_OUTPUT_CHARACTERS = 8_000;
export const HARD_MAX_OUTPUT_CHARACTERS = MESSAGE_MAX_LENGTH;

/** Hard duration ceiling for one generation. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 30_000;
export const HARD_GENERATION_TIMEOUT_MS = 300_000;

/** Process-wide simultaneous generations across all Discussions. */
export const DEFAULT_MAX_CONCURRENT_GENERATIONS = 4;
export const HARD_MAX_CONCURRENT_GENERATIONS = 16;

/** Model-generating next-Turn requests one signed session may claim. */
export const DEFAULT_SESSION_GENERATION_QUOTA = 500;
export const HARD_SESSION_GENERATION_QUOTA = 10_000;

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
  })
  .strict();

export type DiscussionBudgets = z.infer<typeof DiscussionBudgetSchema>;

export const DEFAULT_DISCUSSION_BUDGETS: DiscussionBudgets = {
  recentTranscriptTurns: DEFAULT_RECENT_TRANSCRIPT_TURNS,
  transcriptCharacterBudget: DEFAULT_TRANSCRIPT_CHARACTER_BUDGET,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  maxOutputCharacters: DEFAULT_MAX_OUTPUT_CHARACTERS,
  generationTimeoutMs: DEFAULT_GENERATION_TIMEOUT_MS,
  maxConcurrentGenerations: DEFAULT_MAX_CONCURRENT_GENERATIONS,
  sessionGenerationQuota: DEFAULT_SESSION_GENERATION_QUOTA,
};
