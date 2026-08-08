import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import {
  deriveMastraStorageUrl,
  ensureStorageDirectory,
  resolveDiscussionEnvironment,
} from "@/config/environment";
import { MastraDiscussion } from "@/discussion/mastra-discussion";
import { createMastraObservability } from "@/observability/mastra-observability";
import { OPPONENT_MODEL_ID, opponentAgent } from "./agents/opponent";
import { SUPPORTER_MODEL_ID, supporterAgent } from "./agents/supporter";
import {
  SYNTHESIZER_MODEL_ID,
  synthesizerAgent,
} from "./agents/synthesizer";

const environment = resolveDiscussionEnvironment(process.env);

// The Mastra runtime gets its own durable store (a sibling file for local
// databases) so it never contends with the Discussion system of record.
const mastraStorageUrl = deriveMastraStorageUrl(environment.storage);
if (environment.storage.kind === "durable") {
  ensureStorageDirectory(mastraStorageUrl);
}

// Explicit storage on the central Mastra instance: production requires the
// durable adapter from the environment, while development and test use an
// explicit in-memory libSQL store. There is never an implicit fallback.
const mastraStorage = new LibSQLStore({
  id: "mastra-storage",
  url: mastraStorageUrl,
  ...(environment.storage.kind === "durable" &&
  environment.storage.authToken !== undefined
    ? { authToken: environment.storage.authToken }
    : {}),
});

export const mastra = new Mastra({
  agents: { supporterAgent, opponentAgent, synthesizerAgent },
  storage: mastraStorage,
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  // Privacy-safe observability: spans are conversation-redacted before any
  // exporter sees them, and external platform export is opt-in only.
  observability: createMastraObservability(environment),
});

export const discussion = new MastraDiscussion({
  supporter: {
    modelId: SUPPORTER_MODEL_ID,
    generate: (prompt, options) => supporterAgent.generate(prompt, options),
  },
  opponent: {
    modelId: OPPONENT_MODEL_ID,
    generate: (prompt, options) => opponentAgent.generate(prompt, options),
  },
  synthesizer: {
    modelId: SYNTHESIZER_MODEL_ID,
    generate: (prompt, options) => synthesizerAgent.generate(prompt, options),
  },
});
