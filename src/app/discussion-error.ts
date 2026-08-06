import type { ProductErrorCode } from "@/discussion/contracts";

/**
 * Client-side classification of Discussion errors into participant actions.
 * The server owns the authoritative error envelope; this module only decides
 * what the interface should offer next (edit the Topic, wait, retry, or
 * start fresh) and supplies stable fallback copy when the server envelope
 * is malformed or unreachable.
 */
export type DiscussionErrorFamily =
  | "topic"
  | "wait"
  | "retry"
  | "terminal"
  | "unknown";

export interface DiscussionErrorCopy {
  message: string;
  action: string;
  retryable: boolean;
  family: DiscussionErrorFamily;
}

/**
 * Maps a stable product error code to the participant-facing recovery
 * family. Codes that never reach the interface (e.g. OUTPUT_LIMIT_EXCEEDED
 * on start) still map sensibly because they share product vocabulary.
 */
export function errorFamilyForCode(
  code: ProductErrorCode | undefined,
  retryable: boolean,
): DiscussionErrorFamily {
  switch (code) {
    case "TOPIC_REQUIRED":
    case "TOPIC_INVALID":
    case "TOPIC_TOO_LONG":
    case "TOPIC_BLOCKED":
    case "INVALID_REQUEST":
    case "MALFORMED_REQUEST":
    case "CONTENT_TYPE_UNSUPPORTED":
    case "BODY_TOO_LARGE":
      return "topic";
    case "RATE_LIMITED":
    case "SESSION_QUOTA_EXCEEDED":
    case "GENERATION_CAPACITY_EXCEEDED":
    case "STORAGE_UNAVAILABLE":
    case "TURN_IN_PROGRESS":
    case "REQUEST_IN_PROGRESS":
      return "wait";
    case "GENERATION_FAILED":
    case "INVALID_RESPONSE":
      return retryable ? "retry" : "terminal";
    case "GENERATION_TIMEOUT":
    case "OUTPUT_BLOCKED":
    case "OUTPUT_LIMIT_EXCEEDED":
    case "DISCUSSION_NOT_FOUND":
    case "INVALID_DISCUSSION_ID":
    case "INVALID_DISCUSSION_STATE":
    case "DISCUSSION_COMPLETED":
    case "DISCUSSION_STOPPED":
      return "terminal";
    default:
      return "unknown";
  }
}

/**
 * Stable fallback copy used only when the server response is not a valid
 * product error envelope. Copy is chosen from the HTTP status so the
 * participant always sees an actionable, non-internal message.
 */
export function fallbackErrorForStatus(status: number): DiscussionErrorCopy {
  if (status === 404) {
    return {
      message:
        "This Discussion is no longer available in this session.",
      action: "Start a new Discussion.",
      retryable: false,
      family: "terminal",
    };
  }
  if (status === 409) {
    return {
      message:
        "The Discussion changed state while this request was in flight.",
      action: "Review the current status, then try again or start a new Discussion.",
      retryable: false,
      family: "terminal",
    };
  }
  if (status === 429) {
    return {
      message: "The server is receiving too many requests.",
      action: "Wait a moment, then try again.",
      retryable: true,
      family: "wait",
    };
  }
  if (status === 502) {
    return {
      message: "The next Turn could not be completed.",
      action: "Start a new Discussion and try again later.",
      retryable: false,
      family: "terminal",
    };
  }
  if (status === 503) {
    return {
      message: "The server is at its simultaneous generation limit.",
      action: "Wait for an active generation to finish, then try again.",
      retryable: true,
      family: "wait",
    };
  }
  if (status === 504) {
    return {
      message: "The Discussion timed out.",
      action: "Start a new Discussion and try again later.",
      retryable: false,
      family: "terminal",
    };
  }
  if (status >= 400 && status < 500) {
    return {
      message: "The request could not be accepted.",
      action: "Edit the Topic and try again.",
      retryable: false,
      family: "topic",
    };
  }
  return {
    message: "The server could not complete the request.",
    action: "Wait a moment, then try again.",
    retryable: true,
    family: "wait",
  };
}

/** Stable copy for a server response that is not valid Discussion data. */
export function malformedServerDataError(): DiscussionErrorCopy {
  return {
    message: "The server returned an unexpected response.",
    action: "Check the current status and try again, or start a new Discussion.",
    retryable: false,
    family: "unknown",
  };
}

/** Copy for a request that never reached the server (network loss). */
export function networkLossError(): DiscussionErrorCopy {
  return {
    message: "Could not reach the server.",
    action: "Check your connection and try again.",
    retryable: true,
    family: "retry",
  };
}

/** Combines envelope copy with the optional wait hint from Retry-After. */
export function combinedErrorCopy(
  copy: DiscussionErrorCopy,
  retryAfterSeconds?: number,
): string {
  const waitHint =
    retryAfterSeconds === undefined
      ? ""
      : ` You can retry in about ${retryAfterSeconds} seconds.`;
  return `${copy.message} ${copy.action}${waitHint}`;
}
