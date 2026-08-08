import {
  DiscussionResponseSchema,
  ErrorResponseSchema,
  type DiscussionState,
  type ProductErrorCode,
} from "@/discussion/contracts";
import {
  combinedErrorCopy,
  errorFamilyForCode,
  fallbackErrorForStatus,
  malformedServerDataError,
  networkLossError,
  type DiscussionErrorCopy,
  type DiscussionErrorFamily,
} from "./discussion-error";

/**
 * Transport layer of the Discussion API client: owns fetch, JSON parsing,
 * and runtime response validation. Returns a decoded `DiscussionRequestResult`
 * for every reached server, or throws when the server is unreachable — the
 * caller decides the participant copy for network loss (the family differs
 * by lifecycle operation). The server error envelope is trusted; malformed
 * or missing envelopes fall back to status-based copy so internals never
 * leak.
 */

/** Copy shown to the participant in the alert region. */
export interface ParticipantError {
  message: string;
  family: DiscussionErrorFamily;
}

export function networkError(family: DiscussionErrorFamily): ParticipantError {
  return { message: combinedErrorCopy(networkLossError()), family };
}

export type DiscussionRequestResult =
  | { ok: true; discussion: DiscussionState }
  | { ok: false; error: ParticipantError; retryable: boolean };

/**
 * Decodes a Discussion HTTP response into either the authoritative
 * Discussion state or stable participant copy.
 */
async function readDiscussionResponse(
  response: Response,
): Promise<DiscussionRequestResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      return {
        ok: false,
        retryable: false,
        error: {
          message: combinedErrorCopy(malformedServerDataError()),
          family: "unknown",
        },
      };
    }
    const fallback = fallbackErrorForStatus(response.status);
    return {
      ok: false,
      retryable: fallback.retryable,
      error: { message: combinedErrorCopy(fallback), family: fallback.family },
    };
  }

  if (!response.ok) {
    const parsedError = ErrorResponseSchema.safeParse(payload);
    if (parsedError.success) {
      const serverError = parsedError.data.error;
      const copy: DiscussionErrorCopy = {
        message: serverError.message,
        action: serverError.action,
        retryable: serverError.retryable,
        family: errorFamilyForCode(
          serverError.code as ProductErrorCode,
          serverError.retryable,
        ),
      };
      return {
        ok: false,
        retryable: serverError.retryable,
        error: {
          message: combinedErrorCopy(copy, serverError.retryAfterSeconds),
          family: copy.family,
        },
      };
    }

    const fallback = fallbackErrorForStatus(response.status);
    return {
      ok: false,
      retryable: fallback.retryable,
      error: { message: combinedErrorCopy(fallback), family: fallback.family },
    };
  }

  const parsedDiscussion = DiscussionResponseSchema.safeParse(payload);
  if (!parsedDiscussion.success) {
    return {
      ok: false,
      retryable: false,
      error: {
        message: combinedErrorCopy(malformedServerDataError()),
        family: "unknown",
      },
    };
  }

  return { ok: true, discussion: parsedDiscussion.data };
}

export type HydratedSnapshot =
  | { kind: "found"; discussion: DiscussionState }
  | { kind: "missing" }
  | { kind: "error"; error: ParticipantError };

/**
 * Hydration read that distinguishes the three participant-relevant outcomes:
 * found (authoritative state), missing (the URL names a Discussion this
 * session does not own — the URL is an address, not a credential), and a
 * transient error that deserves a retry affordance.
 */
export async function readHydratedDiscussion(
  discussionId: string,
  signal: AbortSignal,
): Promise<HydratedSnapshot> {
  try {
    const response = await fetch(`/api/discussions/${discussionId}`, {
      method: "GET",
      signal,
    });
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return { kind: "missing" };
    }
    const result = await readDiscussionResponse(response);
    if (!result.ok) return { kind: "error", error: result.error };
    return { kind: "found", discussion: result.discussion };
  } catch {
    return { kind: "error", error: networkError("unknown") };
  }
}

/** Starts a Discussion; the server persists the (session, creation identity) mapping. */
export async function createDiscussion(input: {
  topic: string;
  creationRequestId: string;
}): Promise<DiscussionRequestResult> {
  const response = await fetch("/api/discussions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: input.topic,
      creationRequestId: input.creationRequestId,
    }),
  });
  return readDiscussionResponse(response);
}

/** Authoritative GET of the persisted Discussion state. */
export async function readDiscussion(
  discussionId: string,
  signal?: AbortSignal,
): Promise<DiscussionRequestResult> {
  const response = await fetch(`/api/discussions/${discussionId}`, {
    method: "GET",
    ...(signal === undefined ? {} : { signal }),
  });
  return readDiscussionResponse(response);
}

/** Next-Turn POST; the server derives Speaker, Transcript, and policy from durable state. */
export async function requestNextTurn(
  discussionId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<DiscussionRequestResult> {
  const response = await fetch(`/api/discussions/${discussionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
    ...(signal === undefined ? {} : { signal }),
  });
  return readDiscussionResponse(response);
}

/** Stop POST; bodyless, as browsers send it. */
export async function stopDiscussion(
  discussionId: string,
): Promise<DiscussionRequestResult> {
  const response = await fetch(`/api/discussions/${discussionId}/stop`, {
    method: "POST",
  });
  return readDiscussionResponse(response);
}

/**
 * Server-owned synthesis retry/resume POST; no body and no Turn request
 * identity — the server derives everything from durable state.
 */
export async function resumeSynthesis(
  discussionId: string,
  signal?: AbortSignal,
): Promise<DiscussionRequestResult> {
  const response = await fetch(`/api/discussions/${discussionId}/synthesis`, {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
  });
  return readDiscussionResponse(response);
}
