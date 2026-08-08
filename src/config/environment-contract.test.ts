import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERATION_MODE_ENV,
  OBSERVABILITY_EXPORT_ENABLED_ENV,
  DISCUSSION_SESSION_SECRET_ENV,
  DISCUSSION_STORE_AUTH_TOKEN_ENV,
  DISCUSSION_STORE_URL_ENV,
  MASTRA_PLATFORM_ACCESS_TOKEN_ENV,
  PROVIDER_KEY_ENV,
} from "./environment";

/**
 * The example environment contract (tracked at the repository root) must
 * document every runtime environment variable with a safe placeholder. This
 * test guards both directions of drift: an undocumented variable fails, and
 * a stale example entry fails.
 */

/** Variables read by the HTTP composition (src/app/api/discussions/composition.ts). */
const COMPOSITION_ENV_VARS = [
  "DISCUSSION_TURN_LIMIT",
  "DISCUSSION_RECENT_TRANSCRIPT_TURNS",
  "DISCUSSION_TRANSCRIPT_CHARACTER_BUDGET",
  "DISCUSSION_MAX_OUTPUT_TOKENS",
  "DISCUSSION_MAX_OUTPUT_CHARACTERS",
  "DISCUSSION_GENERATION_TIMEOUT_MS",
  "DISCUSSION_MAX_CONCURRENT_GENERATIONS",
  "DISCUSSION_SESSION_GENERATION_QUOTA",
  "DISCUSSION_SESSION_GENERATION_QUOTA_WINDOW_MS",
  "DISCUSSION_MAX_REQUEST_BODY_BYTES",
  "DISCUSSION_SESSION_RATE_LIMIT",
  "DISCUSSION_SESSION_RATE_WINDOW_MS",
  "DISCUSSION_NETWORK_RATE_LIMIT",
  "DISCUSSION_NETWORK_RATE_WINDOW_MS",
] as const;

const RUNTIME_ENV_VARS = [
  DISCUSSION_STORE_URL_ENV,
  DISCUSSION_STORE_AUTH_TOKEN_ENV,
  DISCUSSION_SESSION_SECRET_ENV,
  PROVIDER_KEY_ENV,
  GENERATION_MODE_ENV,
  OBSERVABILITY_EXPORT_ENABLED_ENV,
  MASTRA_PLATFORM_ACCESS_TOKEN_ENV,
  ...COMPOSITION_ENV_VARS,
];

/** Documented entries may be commented out (e.g. the deterministic mode). */
function documentedVariables(example: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const line of example.split("\n")) {
    const stripped = line.replace(/^\s*#\s*/, "");
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(stripped);
    if (match) variables.set(match[1], match[2] ?? "");
  }
  return variables;
}

const examplePath = new URL("../../.env.example", import.meta.url);

describe("tracked example environment contract (.env.example)", () => {
  const example = readFileSync(examplePath, "utf8");
  const documented = documentedVariables(example);

  it("documents every runtime environment variable", () => {
    const missing = RUNTIME_ENV_VARS.filter(
      (name) => !documented.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("contains no stale entries (every documented variable is read at runtime)", () => {
    const stale = [...documented.keys()].filter(
      (name) => !RUNTIME_ENV_VARS.includes(name as (typeof RUNTIME_ENV_VARS)[number]),
    );
    expect(stale).toEqual([]);
  });

  it("contains no real secrets, only safe placeholders", () => {
    const expectations: Record<string, string> = {
      [PROVIDER_KEY_ENV]: "your-api-key",
      [DISCUSSION_SESSION_SECRET_ENV]:
        "replace-with-a-random-secret-of-at-least-32-characters",
      [DISCUSSION_STORE_AUTH_TOKEN_ENV]: "",
      [MASTRA_PLATFORM_ACCESS_TOKEN_ENV]: "",
      [OBSERVABILITY_EXPORT_ENABLED_ENV]: "false",
    };
    for (const [name, placeholder] of Object.entries(expectations)) {
      expect(
        documented.get(name),
        `${name} must carry its documented placeholder, not a real value`,
      ).toBe(placeholder);
    }

    // Defense in depth: no documented value may look like a credential.
    for (const [name, value] of documented) {
      if (value === "" || value.startsWith("your-") || value.startsWith("replace-with-")) {
        continue;
      }
      expect(
        value,
        `${name} must not contain a credential-shaped value`,
      ).not.toMatch(
        /(?:sk-|ghp_|gho_|eyJ[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]+-----|AKIA[A-Z0-9]{16})/u,
      );
    }
  });
});
