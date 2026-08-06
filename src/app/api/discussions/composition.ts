import { randomBytes } from "node:crypto";
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

function createProcessHandlers(): DiscussionHttpHandlers {
  const store = new InMemoryDiscussionStore();
  const configuredTurnLimit = process.env.DISCUSSION_TURN_LIMIT;
  const service = new DiscussionService({
    store,
    ...(configuredTurnLimit === undefined
      ? {}
      : { turnLimit: Number(configuredTurnLimit) }),
  });
  const runner = new DiscussionRunner({ store, discussion });
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
