import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import {
  deriveMastraStorageUrl,
  ensureStorageDirectory,
  resolveDiscussionEnvironment,
} from "@/config/environment";
import { supporterAgent } from "./agents/supporter";
import { opponentAgent } from "./agents/opponent";
import { MastraDiscussion } from "@/discussion/mastra-discussion";

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
  agents: { supporterAgent, opponentAgent },
  storage: mastraStorage,
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

export const discussion = new MastraDiscussion({
  supporter: mastra.getAgentById("supporter-agent"),
  opponent: mastra.getAgentById("opponent-agent"),
});
