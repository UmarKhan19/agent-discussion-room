import { randomBytes } from "node:crypto";
import { DiscussionService, InMemoryDiscussionStore } from "@/discussion/discussion-service";
import { SignedSessionManager } from "@/discussion/signed-session";
import { createDiscussionHttpHandlers } from "./handler";

type DiscussionHttpHandlers = ReturnType<typeof createDiscussionHttpHandlers>;

const processState = globalThis as typeof globalThis & {
  discussionHttpHandlers?: DiscussionHttpHandlers;
};

function createProcessHandlers(): DiscussionHttpHandlers {
  const store = new InMemoryDiscussionStore();
  const service = new DiscussionService({ store, turnLimit: 12 });
  const processSigningKey =
    process.env.DISCUSSION_SESSION_SECRET ??
    randomBytes(32).toString("base64url");
  const sessions = new SignedSessionManager(processSigningKey);
  return createDiscussionHttpHandlers(service, sessions);
}

export const discussionHttpHandlers =
  processState.discussionHttpHandlers ?? createProcessHandlers();
processState.discussionHttpHandlers = discussionHttpHandlers;
