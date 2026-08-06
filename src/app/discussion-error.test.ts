import { describe, expect, it } from "vitest";
import {
  combinedErrorCopy,
  errorFamilyForCode,
  fallbackErrorForStatus,
  malformedServerDataError,
  networkLossError,
} from "./discussion-error";

describe("errorFamilyForCode", () => {
  it("classifies Topic and request-shape errors as edit-the-Topic", () => {
    for (const code of [
      "TOPIC_REQUIRED",
      "TOPIC_INVALID",
      "TOPIC_TOO_LONG",
      "TOPIC_BLOCKED",
      "INVALID_REQUEST",
      "MALFORMED_REQUEST",
      "CONTENT_TYPE_UNSUPPORTED",
      "BODY_TOO_LARGE",
    ] as const) {
      expect(errorFamilyForCode(code, false)).toBe("topic");
    }
  });

  it("classifies rate-limit, quota, capacity, and conflict errors as wait", () => {
    for (const code of [
      "RATE_LIMITED",
      "SESSION_QUOTA_EXCEEDED",
      "GENERATION_CAPACITY_EXCEEDED",
      "STORAGE_UNAVAILABLE",
      "TURN_IN_PROGRESS",
      "REQUEST_IN_PROGRESS",
    ] as const) {
      expect(errorFamilyForCode(code, true)).toBe("wait");
    }
  });

  it("classifies provider failures by retryability", () => {
    expect(errorFamilyForCode("GENERATION_FAILED", true)).toBe("retry");
    expect(errorFamilyForCode("INVALID_RESPONSE", true)).toBe("retry");
    expect(errorFamilyForCode("GENERATION_FAILED", false)).toBe("terminal");
    expect(errorFamilyForCode("INVALID_RESPONSE", false)).toBe("terminal");
  });

  it("classifies timeout, policy, and state errors as terminal", () => {
    for (const code of [
      "GENERATION_TIMEOUT",
      "OUTPUT_BLOCKED",
      "OUTPUT_LIMIT_EXCEEDED",
      "DISCUSSION_NOT_FOUND",
      "INVALID_DISCUSSION_ID",
      "INVALID_DISCUSSION_STATE",
      "DISCUSSION_COMPLETED",
      "DISCUSSION_STOPPED",
    ] as const) {
      expect(errorFamilyForCode(code, false)).toBe("terminal");
    }
  });
});

describe("fallbackErrorForStatus", () => {
  it("maps ownership loss to stable terminal copy", () => {
    const fallback = fallbackErrorForStatus(404);
    expect(fallback).toMatchObject({
      retryable: false,
      family: "terminal",
    });
    expect(fallback.message).toContain("no longer available");
  });

  it("maps rate limiting and capacity to wait copy with retry", () => {
    expect(fallbackErrorForStatus(429)).toMatchObject({
      retryable: true,
      family: "wait",
    });
    expect(fallbackErrorForStatus(503)).toMatchObject({
      retryable: true,
      family: "wait",
    });
  });

  it("maps timeout and provider failures to terminal copy", () => {
    expect(fallbackErrorForStatus(504)).toMatchObject({
      retryable: false,
      family: "terminal",
    });
    expect(fallbackErrorForStatus(504).message).toContain("timed out");
    expect(fallbackErrorForStatus(502)).toMatchObject({
      retryable: false,
      family: "terminal",
    });
  });

  it("never includes internals in fallback copy", () => {
    for (const status of [400, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504]) {
      const copy = combinedErrorCopy(fallbackErrorForStatus(status));
      expect(copy).not.toMatch(/stack|trace|provider|credential|secret|token/i);
    }
  });
});

describe("stable copy helpers", () => {
  it("appends a wait hint when Retry-After is present", () => {
    expect(
      combinedErrorCopy(
        fallbackErrorForStatus(429),
        30,
      ),
    ).toContain("You can retry in about 30 seconds.");
    expect(
      combinedErrorCopy(fallbackErrorForStatus(429)),
    ).not.toContain("retry in about");
  });

  it("provides distinct network-loss and malformed-data copy", () => {
    expect(networkLossError()).toMatchObject({
      retryable: true,
      family: "retry",
    });
    expect(malformedServerDataError()).toMatchObject({
      retryable: false,
      family: "unknown",
    });
  });
});
