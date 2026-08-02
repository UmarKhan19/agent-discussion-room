import { randomBytes } from "node:crypto";
import { DiscussionRunner } from "@/discussion/discussion-runner";
import {
  DiscussionService,
  InMemoryDiscussionStore,
} from "@/discussion/discussion-service";
import { SignedSessionManager } from "@/discussion/signed-session";
import { discussion } from "@/mastra";
import { createDiscussionHttpHandlers } from "./handler";

type DiscussionHttpHandlers = ReturnType<typeof createDiscussionHttpHandlers>;

const processState = globalThis as typeof globalThis & {
  discussionHttpHandlers?: DiscussionHttpHandlers;
};

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
  return createDiscussionHttpHandlers(service, sessions, runner);
}

export const discussionHttpHandlers =
  processState.discussionHttpHandlers ?? createProcessHandlers();
processState.discussionHttpHandlers = discussionHttpHandlers;
