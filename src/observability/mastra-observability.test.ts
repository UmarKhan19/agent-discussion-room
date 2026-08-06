import {
  MastraPlatformExporter,
  MastraStorageExporter,
  SensitiveDataFilter,
  type ObservabilityInstanceConfig,
  type ObservabilityRegistryConfig,
} from "@mastra/observability";
import { describe, expect, it } from "vitest";
import type { DiscussionEnvironment } from "@/config/environment";
import { ConversationRedactionSpanProcessor } from "./conversation-redaction";
import { createMastraObservabilityConfig } from "./mastra-observability";

function instanceConfig(
  config: ObservabilityRegistryConfig,
): ObservabilityInstanceConfig | undefined {
  const value = config.configs?.default;
  return value !== null &&
    typeof value === "object" &&
    "exporters" in value
    ? (value as ObservabilityInstanceConfig)
    : undefined;
}

function environment(
  observabilityExportEnabled: boolean,
): DiscussionEnvironment {
  return {
    nodeEnv: "production",
    isProduction: true,
    storage: { kind: "durable", url: "file:/var/lib/discussions/db" },
    sessionSecret: "a-stable-session-secret-that-is-long-enough",
    providerKey: "sk-provider-key",
    observabilityExportEnabled,
  };
}

describe("createMastraObservabilityConfig", () => {
  it("always persists redacted spans locally through the storage exporter", () => {
    const config = createMastraObservabilityConfig(environment(false));
    const exporters = instanceConfig(config)?.exporters ?? [];

    expect(
      exporters.some((exporter) => exporter instanceof MastraStorageExporter),
    ).toBe(true);
  });

  it("keeps external platform export disabled unless explicitly configured", () => {
    const config = createMastraObservabilityConfig(environment(false));
    const exporters = instanceConfig(config)?.exporters ?? [];

    expect(
      exporters.some((exporter) => exporter instanceof MastraPlatformExporter),
    ).toBe(false);
  });

  it("adds the platform exporter only when export is explicitly enabled", () => {
    const config = createMastraObservabilityConfig(environment(true));
    const exporters = instanceConfig(config)?.exporters ?? [];

    expect(
      exporters.some((exporter) => exporter instanceof MastraPlatformExporter),
    ).toBe(true);
  });

  it("applies conversation redaction independently of generic secret filtering", () => {
    const config = createMastraObservabilityConfig(environment(false));
    const processors = instanceConfig(config)?.spanOutputProcessors ?? [];

    expect(
      processors.some((processor) => processor instanceof SensitiveDataFilter),
    ).toBe(true);
    expect(
      processors.some(
        (processor) => processor instanceof ConversationRedactionSpanProcessor,
      ),
    ).toBe(true);
  });
});
