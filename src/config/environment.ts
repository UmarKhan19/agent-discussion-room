/**
 * Runtime environment contract.
 *
 * The Discussion Room must fail startup loudly rather than silently degrade:
 * production requires explicit durable storage, a stable session-signing
 * secret, and provider credentials. Development and test environments may
 * run without those values and get explicit in-memory defaults instead.
 *
 * Every problem message names only environment variable names and
 * constraints — never values — so failures are safe to surface in logs,
 * build output, and operator dashboards.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Creates the parent directory of a local `file:` storage URL so the
 * database file can be opened on first start (build, dev, or server boot).
 * Remote URLs and in-memory URIs are left untouched.
 */
export function ensureStorageDirectory(url: string): void {
  const path = localFilePathOf(url);
  if (path.length === 0 || path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}

export const DISCUSSION_STORE_URL_ENV = "DISCUSSION_STORE_URL";
export const DISCUSSION_STORE_AUTH_TOKEN_ENV = "DISCUSSION_STORE_AUTH_TOKEN";
export const DISCUSSION_SESSION_SECRET_ENV = "DISCUSSION_SESSION_SECRET";
export const PROVIDER_KEY_ENV = "OPENCODE_API_KEY";

export const SESSION_SECRET_MIN_LENGTH = 32;

export type NodeEnvironment = "development" | "test" | "production";

export type DiscussionStorageEnvironment =
  | { kind: "in-memory" }
  | { kind: "durable"; url: string; authToken?: string };

export interface DiscussionEnvironment {
  nodeEnv: NodeEnvironment;
  isProduction: boolean;
  storage: DiscussionStorageEnvironment;
  /**
   * The configured session-signing secret, or null when the caller must
   * generate an ephemeral secret (development/test only).
   */
  sessionSecret: string | null;
  /**
   * The configured provider credential value, or null when no credential
   * was supplied (development/test only). Never included in errors.
   */
  providerKey: string | null;
}

/** Raised when required runtime values are absent or invalid. */
export class EnvironmentValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "The Discussion Room environment is not configured safely:",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
    this.name = "EnvironmentValidationError";
    this.problems = [...problems];
  }
}

const DURABLE_URL_SCHEME = /^(?:file:|libsql:\/\/|https?:\/\/|wss?:\/\/)/u;

/**
 * The local path of a `file:` URL (before any query string), or "" when the
 * URL is not a `file:` URL.
 */
function localFilePathOf(url: string): string {
  if (!url.startsWith("file:")) return "";
  return url.slice("file:".length).split("?", 1)[0];
}

/**
 * In-memory URLs are never durable: the exact ":memory:" form and the
 * `file:` variants with an empty or ":memory:" local path. Development and
 * test get the explicit in-memory store by leaving the URL unset; an
 * explicitly configured ephemeral URL always fails startup.
 */
function isEphemeralStorageUrl(url: string): boolean {
  if (url === ":memory:") return true;
  if (!url.startsWith("file:")) return false;
  const path = localFilePathOf(url);
  return path === ":memory:" || path.length === 0;
}

function isDurableStorageUrl(url: string): boolean {
  return DURABLE_URL_SCHEME.test(url) && !isEphemeralStorageUrl(url);
}

const REMOTE_URL_SCHEME = /^(?:libsql:|https?:|wss?:)\/\//u;

/**
 * Storage URL for the central Mastra instance, derived from the Discussion
 * storage configuration. Local file databases use a sibling file so the
 * Discussion system of record and the Mastra runtime never contend on one
 * SQLite file; remote databases are shared because the server serializes
 * writers.
 */
export function deriveMastraStorageUrl(
  storage: DiscussionStorageEnvironment,
): string {
  if (storage.kind === "in-memory") {
    return "file::memory:?cache=shared";
  }
  if (REMOTE_URL_SCHEME.test(storage.url)) {
    return storage.url;
  }
  const path = localFilePathOf(storage.url);
  const separator = path.lastIndexOf("/");
  const directory = separator >= 0 ? path.slice(0, separator + 1) : "";
  return `file:${directory}mastra.db`;
}

function validateStorageUrl(url: string, isProduction: boolean): string[] {
  if (isEphemeralStorageUrl(url)) {
    return [
      isProduction
        ? `${DISCUSSION_STORE_URL_ENV} must not be an in-memory URL in production (":memory:" or file::memory:...); configure a durable libSQL URL (file:, libsql:, http(s):, or ws(s):) so Discussions survive restarts.`
        : `${DISCUSSION_STORE_URL_ENV} in-memory URLs (":memory:" or file::memory:...) are not supported; development and test use an explicit in-memory store by default, and production requires a durable file:, libsql:, http(s):, or ws(s): URL.`,
    ];
  }
  if (!isDurableStorageUrl(url)) {
    return [
      `${DISCUSSION_STORE_URL_ENV} must be a libSQL URL with a file:, libsql:, http(s):, or ws(s): scheme.`,
    ];
  }
  return [];
}

function validateSessionSecret(secret: string | undefined): string[] {
  if (secret === undefined || secret.length === 0) {
    return [
      `${DISCUSSION_SESSION_SECRET_ENV} is required in production; without a stable secret, signed sessions cannot survive restarts.`,
    ];
  }
  if (secret.length < SESSION_SECRET_MIN_LENGTH) {
    return [
      `${DISCUSSION_SESSION_SECRET_ENV} must be at least ${SESSION_SECRET_MIN_LENGTH} characters long.`,
    ];
  }
  return [];
}

function validateProviderKey(key: string | undefined): string[] {
  if (key === undefined || key.trim().length === 0) {
    return [
      `${PROVIDER_KEY_ENV} is required in production; the Supporter and Opponent agents need provider credentials.`,
    ];
  }
  return [];
}

function nodeEnvironment(raw: string | undefined): NodeEnvironment {
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

/**
 * Resolves and validates the runtime environment. Throws
 * `EnvironmentValidationError` with a non-secret problem list when a
 * required production value is absent or invalid; development and test
 * environments fall back to explicit in-memory configuration.
 */
export function resolveDiscussionEnvironment(
  env: Record<string, string | undefined>,
): DiscussionEnvironment {
  const nodeEnv = nodeEnvironment(env.NODE_ENV);
  const isProduction = nodeEnv === "production";

  const storageUrl = env[DISCUSSION_STORE_URL_ENV];
  const problems: string[] = [];

  let storage: DiscussionStorageEnvironment;
  if (storageUrl === undefined || storageUrl.length === 0) {
    if (isProduction) {
      problems.push(
        `${DISCUSSION_STORE_URL_ENV} is required in production; configure a durable libSQL URL (file:, libsql:, http(s):, or ws(s):). In-memory storage is never an implicit production fallback.`,
      );
      storage = { kind: "in-memory" };
    } else {
      storage = { kind: "in-memory" };
    }
  } else {
    problems.push(...validateStorageUrl(storageUrl, isProduction));
    const authToken = env[DISCUSSION_STORE_AUTH_TOKEN_ENV];
    storage =
      problems.length === 0 && !isEphemeralStorageUrl(storageUrl)
        ? {
            kind: "durable",
            url: storageUrl,
            ...(authToken !== undefined && authToken.length > 0
              ? { authToken }
              : {}),
          }
        : { kind: "in-memory" };
  }

  if (isProduction) {
    problems.push(...validateSessionSecret(env[DISCUSSION_SESSION_SECRET_ENV]));
    problems.push(...validateProviderKey(env[PROVIDER_KEY_ENV]));
  }

  if (problems.length > 0) {
    throw new EnvironmentValidationError(problems);
  }

  return {
    nodeEnv,
    isProduction,
    storage,
    sessionSecret: env[DISCUSSION_SESSION_SECRET_ENV] ?? null,
    providerKey: env[PROVIDER_KEY_ENV] ?? null,
  };
}
