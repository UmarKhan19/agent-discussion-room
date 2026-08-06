import {
  MastraPlatformExporter,
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
  type ObservabilityRegistryConfig,
} from "@mastra/observability";
import type { DiscussionEnvironment } from "@/config/environment";
import { ConversationRedactionSpanProcessor } from "./conversation-redaction";

/**
 * Central Mastra observability configuration.
 *
 * - Traces are always exported to the local Mastra storage exporter after
 *   two independent span processors: generic secret filtering
 *   (`SensitiveDataFilter`) and conversation redaction
 *   (`ConversationRedactionSpanProcessor`).
 * - External platform export is opt-in only: the platform exporter is
 *   registered solely when the environment explicitly enables it (see
 *   `docs/observability-privacy.md` for the retention and privacy contract).
 */
export function createMastraObservabilityConfig(
  environment: DiscussionEnvironment,
): ObservabilityRegistryConfig {
  return {
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new MastraStorageExporter(),
          ...(environment.observabilityExportEnabled
            ? [new MastraPlatformExporter()]
            : []),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
          new ConversationRedactionSpanProcessor(),
        ],
      },
    },
  };
}

export function createMastraObservability(
  environment: DiscussionEnvironment,
): Observability {
  return new Observability(createMastraObservabilityConfig(environment));
}
