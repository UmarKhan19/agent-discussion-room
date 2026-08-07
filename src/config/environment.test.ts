import { describe, expect, it } from "vitest";
import {
  deriveMastraStorageUrl,
  DISCUSSION_SESSION_SECRET_ENV,
  DISCUSSION_STORE_AUTH_TOKEN_ENV,
  DISCUSSION_STORE_URL_ENV,
  EnvironmentValidationError,
  GENERATION_MODE_ENV,
  MASTRA_PLATFORM_ACCESS_TOKEN_ENV,
  OBSERVABILITY_EXPORT_ENABLED_ENV,
  PROVIDER_KEY_ENV,
  resolveDiscussionEnvironment,
} from "./environment";

const SECRET = "a-stable-session-secret-that-is-long-enough";
const KEY = "sk-provider-key";

function environment(
  overrides: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    [DISCUSSION_STORE_URL_ENV]: "file:/var/lib/discussions/mastra.db",
    [DISCUSSION_SESSION_SECRET_ENV]: SECRET,
    [PROVIDER_KEY_ENV]: KEY,
    ...overrides,
  };
}

function problemsOf(
  env: Record<string, string | undefined>,
): readonly string[] {
  try {
    resolveDiscussionEnvironment(env);
  } catch (error) {
    if (error instanceof EnvironmentValidationError) return error.problems;
    throw error;
  }
  throw new Error("Expected environment validation to fail");
}

describe("resolveDiscussionEnvironment", () => {
  it("accepts a complete production environment", () => {
    const resolved = resolveDiscussionEnvironment(environment());

    expect(resolved).toMatchObject({
      nodeEnv: "production",
      isProduction: true,
      storage: { kind: "durable", url: "file:/var/lib/discussions/mastra.db" },
      sessionSecret: SECRET,
      providerKey: KEY,
    });
  });

  it("carries the durable-store auth token for remote URLs", () => {
    const resolved = resolveDiscussionEnvironment(
      environment({
        [DISCUSSION_STORE_URL_ENV]: "libsql://db.example.com",
        [DISCUSSION_STORE_AUTH_TOKEN_ENV]: "secret-token",
      }),
    );

    expect(resolved.storage).toEqual({
      kind: "durable",
      url: "libsql://db.example.com",
      authToken: "secret-token",
    });
  });

  it("requires durable storage in production and fails with a clear non-secret error", () => {
    const problems = problemsOf(
      environment({ [DISCUSSION_STORE_URL_ENV]: "" }),
    );

    expect(problems[0]).toContain(DISCUSSION_STORE_URL_ENV);
    expect(problems[0]).toContain("required in production");
    expect(problems[0]).not.toContain(SECRET);
    expect(problems[0]).not.toContain(KEY);
  });

  it("rejects plain in-memory URLs everywhere because they lose data per statement", () => {
    const problems = problemsOf(
      environment({ [DISCUSSION_STORE_URL_ENV]: ":memory:" }),
    );

    expect(problems[0]).toContain(DISCUSSION_STORE_URL_ENV);
    expect(problems[0]).toContain(":memory:");
  });

  it.each([
    "file::memory:?cache=shared",
    "file::memory:",
    "file:?cache=shared",
    "file:",
  ])("rejects ephemeral file: URLs in production (%#)", (url) => {
    const problems = problemsOf(
      environment({ [DISCUSSION_STORE_URL_ENV]: url }),
    );

    expect(problems[0]).toContain(DISCUSSION_STORE_URL_ENV);
    expect(problems[0]).toContain("in-memory");
    expect(problems[0]).toContain("durable");
  });

  it("rejects explicitly configured ephemeral file: URLs outside production too", () => {
    const problems = problemsOf(
      environment({
        NODE_ENV: "development",
        [DISCUSSION_STORE_URL_ENV]: "file::memory:?cache=shared",
      }),
    );

    expect(problems[0]).toContain(DISCUSSION_STORE_URL_ENV);
    expect(problems[0]).toContain("in-memory");
    expect(problems[0]).toContain("not supported");
  });

  it.each(["mastra.db", "sqlite://mastra.db", "memory://x", ""])(
    "rejects a non-libSQL storage URL %#",
    (url) => {
      const problems = problemsOf(
        environment({ [DISCUSSION_STORE_URL_ENV]: url }),
      );

      expect(problems[0]).toContain(DISCUSSION_STORE_URL_ENV);
      expect(problems[0]).toMatch(/file:|libsql:|http|ws/);
    },
  );

  it("requires a session-signing secret in production", () => {
    const problems = problemsOf(
      environment({ [DISCUSSION_SESSION_SECRET_ENV]: "" }),
    );

    expect(problems.some((problem) => problem.includes(DISCUSSION_SESSION_SECRET_ENV))).toBe(true);
    expect(problems.some((problem) => problem.includes("restarts"))).toBe(true);
  });

  it("rejects a session-signing secret shorter than 32 characters", () => {
    const problems = problemsOf(
      environment({ [DISCUSSION_SESSION_SECRET_ENV]: "too-short" }),
    );

    expect(problems[0]).toContain(DISCUSSION_SESSION_SECRET_ENV);
    expect(problems[0]).toContain("32");
  });

  it("requires provider credentials in production", () => {
    const problems = problemsOf(environment({ [PROVIDER_KEY_ENV]: "" }));

    expect(problems.some((problem) => problem.includes(PROVIDER_KEY_ENV))).toBe(true);
  });

  it("never includes configured values in validation errors", () => {
    const problems = problemsOf(
      environment({
        [DISCUSSION_SESSION_SECRET_ENV]: SECRET,
        [PROVIDER_KEY_ENV]: KEY,
        [DISCUSSION_STORE_URL_ENV]: "",
      }),
    );
    const joined = problems.join("\n");

    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain(KEY);
  });

  it("reports every missing production requirement together", () => {
    const problems = problemsOf(
      environment({
        [DISCUSSION_STORE_URL_ENV]: "",
        [DISCUSSION_SESSION_SECRET_ENV]: "",
        [PROVIDER_KEY_ENV]: "",
      }),
    );

    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain(DISCUSSION_STORE_URL_ENV);
  });

  it("uses explicit in-memory configuration in development without any values", () => {
    const resolved = resolveDiscussionEnvironment({ NODE_ENV: "development" });

    expect(resolved).toEqual({
      nodeEnv: "development",
      isProduction: false,
      storage: { kind: "in-memory" },
      sessionSecret: null,
      providerKey: null,
      observabilityExportEnabled: false,
      generationMode: "mastra",
    });
  });

  it("uses explicit in-memory configuration in test without any values", () => {
    const resolved = resolveDiscussionEnvironment({ NODE_ENV: "test" });

    expect(resolved.storage).toEqual({ kind: "in-memory" });
    expect(resolved.sessionSecret).toBeNull();
    expect(resolved.providerKey).toBeNull();
  });

  it("treats an unknown NODE_ENV as development", () => {
    const resolved = resolveDiscussionEnvironment({ NODE_ENV: "staging" });

    expect(resolved.nodeEnv).toBe("development");
    expect(resolved.isProduction).toBe(false);
  });

  it("accepts an explicit durable store in development", () => {
    const resolved = resolveDiscussionEnvironment({
      NODE_ENV: "development",
      [DISCUSSION_STORE_URL_ENV]: "file:./dev.db",
      [DISCUSSION_SESSION_SECRET_ENV]: SECRET,
      [PROVIDER_KEY_ENV]: KEY,
    });

    expect(resolved.storage).toEqual({
      kind: "durable",
      url: "file:./dev.db",
    });
    expect(resolved.sessionSecret).toBe(SECRET);
    expect(resolved.providerKey).toBe(KEY);
  });

  it("accepts remote storage URLs", () => {
    for (const url of [
      "libsql://mastra.example.com/db",
      "https://mastra.example.com/db",
      "wss://mastra.example.com/db",
    ]) {
      expect(
        resolveDiscussionEnvironment(
          environment({ [DISCUSSION_STORE_URL_ENV]: url }),
        ).storage,
      ).toMatchObject({ kind: "durable", url });
    }
  });

  describe("external observability export", () => {
    const TOKEN = "mastra-platform-token";

    it("is disabled by default even in production", () => {
      expect(
        resolveDiscussionEnvironment(environment()).observabilityExportEnabled,
      ).toBe(false);
    });

    it("enables only for the exact value true alongside platform credentials", () => {
      const resolved = resolveDiscussionEnvironment(
        environment({
          [OBSERVABILITY_EXPORT_ENABLED_ENV]: "true",
          [MASTRA_PLATFORM_ACCESS_TOKEN_ENV]: TOKEN,
        }),
      );

      expect(resolved.observabilityExportEnabled).toBe(true);
    });

    it.each(["TRUE", "True", "1", "yes", "enabled"])(
      "rejects any enablement value other than the exact string true: %s",
      (value) => {
        const problems = problemsOf(
          environment({ [OBSERVABILITY_EXPORT_ENABLED_ENV]: value }),
        );

        expect(problems.join("\n")).toContain(OBSERVABILITY_EXPORT_ENABLED_ENV);
      },
    );

    it("requires platform credentials in production when export is enabled", () => {
      const problems = problemsOf(
        environment({ [OBSERVABILITY_EXPORT_ENABLED_ENV]: "true" }),
      );

      expect(problems.join("\n")).toContain(MASTRA_PLATFORM_ACCESS_TOKEN_ENV);
      expect(problems.join("\n")).toContain("export");
      expect(problems.join("\n")).not.toContain(TOKEN);
    });

    it("keeps local behavior functional when export is enabled without credentials outside production", () => {
      const resolved = resolveDiscussionEnvironment(
        environment({
          NODE_ENV: "development",
          [OBSERVABILITY_EXPORT_ENABLED_ENV]: "true",
        }),
      );

      expect(resolved.observabilityExportEnabled).toBe(true);
    });
  });
});

describe("deriveMastraStorageUrl", () => {
  it("uses an explicit shared-cache memory URL for in-memory configuration", () => {
    expect(
      deriveMastraStorageUrl({ kind: "in-memory" }),
    ).toBe("file::memory:?cache=shared");
  });

  it("derives a sibling file for local file databases", () => {
    expect(
      deriveMastraStorageUrl({ kind: "durable", url: "file:./data/discussions.db" }),
    ).toBe("file:./data/mastra.db");
    expect(
      deriveMastraStorageUrl({
        kind: "durable",
        url: "file:/var/lib/discussions/discussions.db",
      }),
    ).toBe("file:/var/lib/discussions/mastra.db");
    expect(
      deriveMastraStorageUrl({ kind: "durable", url: "file:discussions.db" }),
    ).toBe("file:mastra.db");
  });

  it("shares remote database URLs unchanged", () => {
    for (const url of [
      "libsql://mastra.example.com/db",
      "https://mastra.example.com/db",
    ]) {
      expect(deriveMastraStorageUrl({ kind: "durable", url })).toBe(url);
    }
  });

  describe("generation mode", () => {
    it("defaults to the Mastra adapter everywhere", () => {
      expect(
        resolveDiscussionEnvironment({ NODE_ENV: "development" })
          .generationMode,
      ).toBe("mastra");
      expect(
        resolveDiscussionEnvironment(environment()).generationMode,
      ).toBe("mastra");
    });

    it("enables the deterministic mode in development and test", () => {
      expect(
        resolveDiscussionEnvironment({
          NODE_ENV: "development",
          [GENERATION_MODE_ENV]: "deterministic",
        }).generationMode,
      ).toBe("deterministic");
      expect(
        resolveDiscussionEnvironment({
          NODE_ENV: "test",
          [GENERATION_MODE_ENV]: "deterministic",
        }).generationMode,
      ).toBe("deterministic");
    });

    it("rejects the deterministic mode in production as a non-production test path", () => {
      const problems = problemsOf(
        environment({ [GENERATION_MODE_ENV]: "deterministic" }),
      );

      expect(problems.join("\n")).toContain(GENERATION_MODE_ENV);
      expect(problems.join("\n")).toContain("deterministic");
      expect(problems.join("\n")).toContain("test mode");
    });

    it("rejects any generation-mode value that is not the exact deterministic marker", () => {
      for (const value of ["scripted", "fake", "Deterministic", "true", ""]) {
        const problems = problemsOf(
          environment({
            NODE_ENV: "development",
            [GENERATION_MODE_ENV]: value,
          }),
        );

        expect(problems.join("\n")).toContain(GENERATION_MODE_ENV);
      }
    });
  });
});
