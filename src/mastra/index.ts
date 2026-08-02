import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { supporterAgent } from "./agents/supporter";
import { opponentAgent } from "./agents/opponent";
import { MastraDiscussion } from "@/discussion/mastra-discussion";

export const mastra = new Mastra({
  agents: { supporterAgent, opponentAgent },
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
