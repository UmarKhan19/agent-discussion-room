import { randomBytes } from "node:crypto";
import {
  DEFAULT_DISCUSSION_BUDGETS,
  DiscussionBudgetSchema,
} from "@/discussion/budgets";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import {
  DiscussionService,
  InMemoryDiscussionStore,
} from "@/discussion/discussion-service";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
} from "@/discussion/request-protection";
import { SignedSessionManager } from "@/discussion/signed-session";
import { discussion } from "@/mastra";
import {
  DEFAULT_NETWORK_RATE_LIMIT,
  DEFAULT_NETWORK_RATE_WINDOW_MS,
  DEFAULT_SESSION_RATE_LIMIT,
  DEFAULT_SESSION_RATE_WINDOW_MS,
  createDiscussionHttpHandlers,
  type DiscussionHttpProtection,
} from "./handler";

type DiscussionHttpHandlers = ReturnType<typeof createDiscussionHttpHandlers>;

const processState = globalThis as typeof globalThis & {
  discussionHttpHandlers?: DiscussionHttpHandlers;
};

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads one budget ceiling from the environment. Missing values use the
 * safe default; present values are validated by `DiscussionBudgetSchema`,
 * so an out-of-range or non-numeric value fails startup loudly instead of
 * silently running with different budgets.
 */
function envBudgetInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return Number(raw);
}

function createProcessHandlers(): DiscussionHttpHandlers {
  const store = new InMemoryDiscussionStore();
  const configuredTurnLimit = process.env.DISCUSSION_TURN_LIMIT;
  const service = new DiscussionService({
    store,
    ...(configuredTurnLimit === undefined
      ? {}
      : { turnLimit: Number(configuredTurnLimit) }),
  });
  const budgets = DiscussionBudgetSchema.parse({
    recentTranscriptTurns: envBudgetInt(
      "DISCUSSION_RECENT_TRANSCRIPT_TURNS",
      DEFAULT_DISCUSSION_BUDGETS.recentTranscriptTurns,
    ),
    transcriptCharacterBudget: envBudgetInt(
      "DISCUSSION_TRANSCRIPT_CHARACTER_BUDGET",
      DEFAULT_DISCUSSION_BUDGETS.transcriptCharacterBudget,
    ),
    maxOutputTokens: envBudgetInt(
      "DISCUSSION_MAX_OUTPUT_TOKENS",
      DEFAULT_DISCUSSION_BUDGETS.maxOutputTokens,
    ),
    maxOutputCharacters: envBudgetInt(
      "DISCUSSION_MAX_OUTPUT_CHARACTERS",
      DEFAULT_DISCUSSION_BUDGETS.maxOutputCharacters,
    ),
    generationTimeoutMs: envBudgetInt(
      "DISCUSSION_GENERATION_TIMEOUT_MS",
      DEFAULT_DISCUSSION_BUDGETS.generationTimeoutMs,
    ),
    maxConcurrentGenerations: envBudgetInt(
      "DISCUSSION_MAX_CONCURRENT_GENERATIONS",
      DEFAULT_DISCUSSION_BUDGETS.maxConcurrentGenerations,
    ),
    sessionGenerationQuota: envBudgetInt(
      "DISCUSSION_SESSION_GENERATION_QUOTA",
      DEFAULT_DISCUSSION_BUDGETS.sessionGenerationQuota,
    ),
  });
  const runner = new DiscussionRunner({ store, discussion, budgets });
  const processSigningKey =
    process.env.DISCUSSION_SESSION_SECRET ??
    randomBytes(32).toString("base64url");
  const sessions = new SignedSessionManager(processSigningKey);
  const protection: DiscussionHttpProtection = {
    maxBodyBytes: envPositiveInt(
      "DISCUSSION_MAX_REQUEST_BODY_BYTES",
      DEFAULT_MAX_REQUEST_BODY_BYTES,
    ),
    sessionRateLimit: envPositiveInt(
      "DISCUSSION_SESSION_RATE_LIMIT",
      DEFAULT_SESSION_RATE_LIMIT,
    ),
    sessionRateWindowMs: envPositiveInt(
      "DISCUSSION_SESSION_RATE_WINDOW_MS",
      DEFAULT_SESSION_RATE_WINDOW_MS,
    ),
    networkRateLimit: envPositiveInt(
      "DISCUSSION_NETWORK_RATE_LIMIT",
      DEFAULT_NETWORK_RATE_LIMIT,
    ),
    networkRateWindowMs: envPositiveInt(
      "DISCUSSION_NETWORK_RATE_WINDOW_MS",
      DEFAULT_NETWORK_RATE_WINDOW_MS,
    ),
  };
  return createDiscussionHttpHandlers(service, sessions, runner, protection);
}

export const discussionHttpHandlers =
  processState.discussionHttpHandlers ?? createProcessHandlers();
processState.discussionHttpHandlers = discussionHttpHandlers;
