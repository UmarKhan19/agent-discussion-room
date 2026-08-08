import { randomBytes } from "node:crypto";
import {
  ensureStorageDirectory,
  resolveDiscussionEnvironment,
} from "@/config/environment";
import {
  DEFAULT_DISCUSSION_BUDGETS,
  DiscussionBudgetSchema,
} from "@/discussion/budgets";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import {
  DiscussionService,
  InMemoryDiscussionStore,
  isDurableDiscussionStore,
} from "@/discussion/discussion-service";
import { LibSQLDiscussionStore } from "@/discussion/libsql-discussion-store";
import { scriptedDiscussion } from "@/discussion/scripted-discussion";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
} from "@/discussion/request-protection";
import { SignedSessionManager } from "@/discussion/signed-session";
import { JsonLineTelemetry } from "@/observability/telemetry";
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
  discussionHttpHandlers?: Promise<DiscussionHttpHandlers>;
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

async function createProcessHandlers(): Promise<DiscussionHttpHandlers> {
  const environment = resolveDiscussionEnvironment(process.env);

  // The deterministic browser suite runs the credential-free scripted
  // adapter; every other configuration uses the registered Mastra debate
  // agents. The Mastra composition is imported lazily so deterministic runs
  // never construct agents, storage, or observability that could touch a
  // provider or produce durable data.
  // Production uses the explicit durable adapter from the environment; the
  // in-memory store is chosen only by the explicit development/test
  // configuration (production fails startup when storage is missing).
  const configuredTurnLimit = process.env.DISCUSSION_TURN_LIMIT;
  const budgets = DiscussionBudgetSchema.parse({
    recentTranscriptTurns: envBudgetInt(
      "DISCUSSION_RECENT_TRANSCRIPT_TURNS",
      DEFAULT_DISCUSSION_BUDGETS.recentTranscriptTurns,
    ),
    transcriptCharacterBudget: envBudgetInt(
      "DISCUSSION_TRANSCRIPT_CHARACTER_BUDGET",
      DEFAULT_DISCUSSION_BUDGETS.transcriptCharacterBudget,
    ),
    synthesisTranscriptCharacterBudget: envBudgetInt(
      "DISCUSSION_SYNTHESIS_TRANSCRIPT_CHARACTER_BUDGET",
      DEFAULT_DISCUSSION_BUDGETS.synthesisTranscriptCharacterBudget,
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
    sessionGenerationQuotaWindowMs: envBudgetInt(
      "DISCUSSION_SESSION_GENERATION_QUOTA_WINDOW_MS",
      DEFAULT_DISCUSSION_BUDGETS.sessionGenerationQuotaWindowMs,
    ),
  });
  if (environment.storage.kind === "durable") {
    ensureStorageDirectory(environment.storage.url);
  }
  const store =
    environment.storage.kind === "durable"
      ? new LibSQLDiscussionStore({
          url: environment.storage.url,
          ...(environment.storage.authToken === undefined
            ? {}
            : { authToken: environment.storage.authToken }),
          // The store derives its recovery lease from the same generation
          // timeout the Runner enforces (see budgets.ts): the lease always
          // outlives a legitimate generation by the fixed safety margin,
          // and the two cannot drift apart because there is one value.
          generationTimeoutMs: budgets.generationTimeoutMs,
        })
      : new InMemoryDiscussionStore();

  // Startup readiness: initialize the durable store and reconcile any
  // Discussion left generating by a previous process before serving. A
  // store failure is logged and surfaces as a stable 500 on every request.
  const ready = isDurableDiscussionStore(store)
    ? store.init().then(async () => {
        await store.recoverInterrupted();
      })
    : Promise.resolve();
  void ready.catch((error) => {
    console.error(
      "[discussion] Durable storage initialization failed; Discussion requests will fail until storage is available.",
      error,
    );
  });

  const service = new DiscussionService({
    store,
    ...(configuredTurnLimit === undefined
      ? {}
      : { turnLimit: Number(configuredTurnLimit) }),
  });
  // Structured, privacy-safe operational telemetry: JSON lines on stdout.
  // Conversation content is structurally impossible to record; see
  // src/observability/telemetry.ts and docs/observability-privacy.md.
  const telemetry = new JsonLineTelemetry();
  const generationDiscussion =
    environment.generationMode === "deterministic"
      ? scriptedDiscussion
      : (await import("@/mastra")).discussion;
  const runner = new DiscussionRunner({
    store,
    discussion: generationDiscussion,
    budgets,
    telemetry,
  });
  const processSigningKey =
    environment.sessionSecret ??
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
  return createDiscussionHttpHandlers(
    service,
    sessions,
    runner,
    protection,
    ready,
    telemetry,
  );
}

export const discussionHttpHandlers =
  processState.discussionHttpHandlers ?? createProcessHandlers();
processState.discussionHttpHandlers = discussionHttpHandlers;