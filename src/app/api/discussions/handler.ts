import {
  DiscussionIdentifierSchema,
  DiscussionResponseSchema,
  ErrorResponseSchema,
  NextTurnRequestSchema,
  StartDiscussionRequestSchema,
  TOPIC_MAX_LENGTH,
  type ProductError,
} from "@/discussion/contracts";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_DISCUSSION_IDENTIFIER_LENGTH,
  clientNetworkKey,
  hasJsonContentType,
  readBoundedBody,
} from "@/discussion/request-protection";
import {
  FixedWindowRateLimiter,
  type RateLimitDecision,
} from "@/discussion/rate-limit";

export const DEFAULT_SESSION_RATE_LIMIT = 60;
export const DEFAULT_SESSION_RATE_WINDOW_MS = 60_000;
export const DEFAULT_NETWORK_RATE_LIMIT = 300;
export const DEFAULT_NETWORK_RATE_WINDOW_MS = 60_000;

export interface DiscussionHttpProtection {
  /** Ceiling for a JSON request body in bytes. */
  maxBodyBytes?: number;
  /** Per signed-session requests allowed within one window. */
  sessionRateLimit?: number;
  sessionRateWindowMs?: number;
  /** Per network key (client address) requests allowed within one window. */
  networkRateLimit?: number;
  networkRateWindowMs?: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}
import {
  DiscussionCompletedError,
  DiscussionGenerationCapacityError,
  DiscussionGenerationFailedError,
  DiscussionGenerationOutputLimitError,
  DiscussionGenerationTimeoutError,
  DiscussionInvalidGeneratedTurnError,
  DiscussionInvalidStateError,
  DiscussionRequestInProgressError,
  DiscussionSessionQuotaExceededError,
  DiscussionTurnInProgressError,
  DiscussionOutputPolicyBlockedError,
  DiscussionStoppedError,
  type DiscussionRunner,
} from "@/discussion/discussion-runner";
import {
  DiscussionPolicyBlockedError,
  type DiscussionService,
} from "@/discussion/discussion-service";
import {
  SAFE_OUTPUT_ALTERNATIVE,
  SAFE_TOPIC_ALTERNATIVE,
} from "@/discussion/policy";
import type {
  AuthenticatedSession,
  SignedSessionManager,
} from "@/discussion/signed-session";

type ProductErrorInput = Omit<ProductError, "retryable"> & {
  retryable?: boolean;
};

function errorResponse(
  status: number,
  error: ProductErrorInput,
  setCookie?: string,
  retryAfterSeconds?: number,
): Response {
  const body = ErrorResponseSchema.parse({
    error: { ...error, retryable: error.retryable ?? false },
  });
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
    Vary: "Cookie",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  if (retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(retryAfterSeconds));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function rateLimitedResponse(
  session: AuthenticatedSession,
  decision: Extract<RateLimitDecision, { allowed: false }>,
): Response {
  return errorResponse(
    429,
    {
      code: "RATE_LIMITED",
      message: "Too many requests from this address or session. Waiting is required.",
      action: "Wait for the retry window to pass, then try again.",
      retryable: true,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    session.setCookie,
    decision.retryAfterSeconds,
  );
}

function discussionResponse(
  discussion: unknown,
  status: number,
  setCookie?: string,
): Response {
  const body = DiscussionResponseSchema.parse(discussion);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
    Vary: "Cookie",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function invalidNextTurnRequest(body: unknown): ProductErrorInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      code: "INVALID_REQUEST",
      message: "The next-Turn request must contain only a stable request identity.",
      action: "Send an object in the form {\"requestId\": \"UUID\"}.",
    };
  }

  const keys = Object.keys(body);
  if (keys.some((key) => key !== "requestId")) {
    return {
      code: "INVALID_REQUEST",
      message: "Speaker, Transcript, Turn count, prompt, and safety outcome are server-owned.",
      action: "Remove every field except the stable requestId, then try again.",
    };
  }

  return {
    code: "INVALID_REQUEST",
    message: "requestId must be a UUID string.",
    action: "Create one stable UUID for this logical next-Turn request.",
  };
}

function invalidStartRequest(body: unknown): ProductErrorInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      code: "INVALID_REQUEST",
      message: "The request must be a JSON object containing only a Topic.",
      action: "Send an object in the form {\"topic\": \"Your Topic\"}.",
    };
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "topic")) {
    return {
      code: "INVALID_REQUEST",
      message: "A new Discussion accepts only a Topic; Speaker and Transcript are server-owned.",
      action: "Remove Speaker, messages, Transcript, and other extra fields, then submit only the Topic.",
    };
  }

  if (typeof record.topic !== "string") {
    return {
      code: "TOPIC_INVALID",
      message: "Topic must be text.",
      action: "Enter a plain-text Discussion Topic and try again.",
    };
  }

  if (record.topic.length > TOPIC_MAX_LENGTH) {
    return {
      code: "TOPIC_TOO_LONG",
      message: `Topic must be ${TOPIC_MAX_LENGTH} characters or fewer.`,
      action: "Shorten the Topic and try again.",
    };
  }

  if (record.topic.trim().length === 0) {
    return {
      code: "TOPIC_REQUIRED",
      message: "Topic cannot be empty.",
      action: "Enter a Discussion Topic before starting.",
    };
  }

  return {
    code: "TOPIC_INVALID",
    message: "Topic contains unsupported control characters.",
    action: "Use plain text without tabs, line breaks, or control characters.",
  };
}

export function createDiscussionHttpHandlers(
  service: DiscussionService,
  sessions: SignedSessionManager,
  runner: DiscussionRunner,
  protection: DiscussionHttpProtection = {},
) {
  const maxBodyBytes =
    protection.maxBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const networkLimiter = new FixedWindowRateLimiter({
    limit: protection.networkRateLimit ?? DEFAULT_NETWORK_RATE_LIMIT,
    windowMs:
      protection.networkRateWindowMs ?? DEFAULT_NETWORK_RATE_WINDOW_MS,
    now: protection.now,
  });
  const sessionLimiter = new FixedWindowRateLimiter({
    limit: protection.sessionRateLimit ?? DEFAULT_SESSION_RATE_LIMIT,
    windowMs:
      protection.sessionRateWindowMs ?? DEFAULT_SESSION_RATE_WINDOW_MS,
    now: protection.now,
  });

  /** Applies network then per-session limits; returns a 429 response when blocked. */
  function applyRateLimits(
    session: AuthenticatedSession,
    request: Request,
  ): Response | null {
    const network = networkLimiter.check(clientNetworkKey(request));
    if (!network.allowed) return rateLimitedResponse(session, network);
    const perSession = sessionLimiter.check(session.id);
    if (!perSession.allowed) return rateLimitedResponse(session, perSession);
    return null;
  }

  type AuthenticatedRequest =
    | { response: Response }
    | { session: AuthenticatedSession; text: string };

  /**
   * Applies content-type, body-size, session, and rate-limit guards and
   * returns either a rejection response or an authenticated session with
   * the bounded raw body text (empty when the request carries no body).
   */
  async function authenticateRequest(
    request: Request,
  ): Promise<AuthenticatedRequest> {
    if (request.body !== null && !hasJsonContentType(request)) {
      return {
        response: errorResponse(415, {
          code: "CONTENT_TYPE_UNSUPPORTED",
          message: "Discussion requests must be sent as JSON.",
          action: 'Send the request with "Content-Type: application/json".',
        }),
      };
    }
    const bounded = await readBoundedBody(request, maxBodyBytes);
    if (!bounded.ok) {
      return {
        response: errorResponse(413, {
          code: "BODY_TOO_LARGE",
          message: `The request body exceeds the ${maxBodyBytes}-byte limit.`,
          action: "Send only the required fields in a compact JSON body.",
        }),
      };
    }
    const session = sessions.authenticate(request);
    const limited = applyRateLimits(session, request);
    if (limited) return { response: limited };
    return { session, text: bounded.text };
  }

  function invalidIdentifierResponse(): Response {
    return errorResponse(400, {
      code: "INVALID_DISCUSSION_ID",
      message: "The Discussion identifier is malformed or too long.",
      action: "Use the UUID returned when the Discussion was started.",
    });
  }

  type ParsedDiscussionIdentifier =
    | { ok: true; id: string }
    | { ok: false; response: Response };

  function parseDiscussionIdentifier(
    untrustedId: string,
  ): ParsedDiscussionIdentifier {
    if (untrustedId.length > MAX_DISCUSSION_IDENTIFIER_LENGTH) {
      return { ok: false, response: invalidIdentifierResponse() };
    }
    const parsed = DiscussionIdentifierSchema.safeParse(untrustedId);
    if (!parsed.success) {
      return { ok: false, response: invalidIdentifierResponse() };
    }
    return { ok: true, id: parsed.data };
  }

  return {
    async post(request: Request): Promise<Response> {
      const guarded = await authenticateRequest(request);
      if ("response" in guarded) return guarded.response;
      const { session } = guarded;

      let body: unknown;
      try {
        body = JSON.parse(guarded.text);
      } catch {
        return errorResponse(400, {
          code: "MALFORMED_REQUEST",
          message: "The request body is not valid JSON.",
          action: "Send a JSON object in the form {\"topic\": \"Your Topic\"}.",
        });
      }

      const parsedRequest = StartDiscussionRequestSchema.safeParse(body);
      if (!parsedRequest.success) {
        return errorResponse(400, invalidStartRequest(body));
      }

      try {
        const discussion = service.start(session.id, parsedRequest.data.topic);
        return discussionResponse(discussion, 201, session.setCookie);
      } catch (error) {
        if (error instanceof DiscussionPolicyBlockedError) {
          return errorResponse(
            422,
            {
              code: "TOPIC_BLOCKED",
              message: "This Topic requests advocacy or praise that the Discussion Policy does not permit.",
              action: SAFE_TOPIC_ALTERNATIVE,
              category: error.outcome.category,
            },
            session.setCookie,
          );
        }

        return errorResponse(
          500,
          {
            code: "INVALID_RESPONSE",
            message: "The Discussion could not be created safely.",
            action: "Try again with the same Topic.",
            retryable: true,
          },
          session.setCookie,
        );
      }
    },

    async postTurn(
      request: Request,
      untrustedId: string,
    ): Promise<Response> {
      const parsedId = parseDiscussionIdentifier(untrustedId);
      if (!parsedId.ok) return parsedId.response;

      const guarded = await authenticateRequest(request);
      if ("response" in guarded) return guarded.response;
      const { session } = guarded;

      let body: unknown;
      try {
        body = JSON.parse(guarded.text);
      } catch {
        return errorResponse(400, {
          code: "MALFORMED_REQUEST",
          message: "The request body is not valid JSON.",
          action: "Send an object in the form {\"requestId\": \"UUID\"}.",
        });
      }

      const parsedRequest = NextTurnRequestSchema.safeParse(body);
      if (!parsedRequest.success) {
        return errorResponse(400, invalidNextTurnRequest(body));
      }

      try {
        const discussion = await runner.nextTurn(
          session.id,
          parsedId.id,
          parsedRequest.data.requestId,
          request.signal,
        );
        if (!discussion) {
          return errorResponse(
            404,
            {
              code: "DISCUSSION_NOT_FOUND",
              message: "This Discussion is not available in the current session.",
              action: "Start a new Discussion in this session or return to the session that created it.",
            },
            session.setCookie,
          );
        }

        return discussionResponse(discussion, 200, session.setCookie);
      } catch (error) {
        if (error instanceof DiscussionRequestInProgressError) {
          return errorResponse(
            409,
            {
              code: "REQUEST_IN_PROGRESS",
              message: "This next-Turn request is already being generated.",
              action: "Wait for the active request to finish, then retry with the same requestId.",
              retryable: true,
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionTurnInProgressError) {
          return errorResponse(
            409,
            {
              code: "TURN_IN_PROGRESS",
              message: "Another next-Turn request is already being generated for this Discussion.",
              action: "Wait for the active Turn to finish before requesting another Turn.",
              retryable: true,
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionSessionQuotaExceededError) {
          return errorResponse(
            429,
            {
              code: "SESSION_QUOTA_EXCEEDED",
              message: "This session has reached its generation quota.",
              action: "Start a fresh session, or try again later.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionGenerationCapacityError) {
          return errorResponse(
            503,
            {
              code: "GENERATION_CAPACITY_EXCEEDED",
              message: "The server has reached its simultaneous generation limit.",
              action: "Wait for an active generation to finish, then retry with the same request identity.",
              retryable: true,
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionCompletedError) {
          return errorResponse(
            409,
            {
              code: "DISCUSSION_COMPLETED",
              message: "This Discussion has completed its configured Turn limit.",
              action: "Start a new Discussion to continue with a fresh Topic and Transcript.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionInvalidStateError) {
          return errorResponse(
            409,
            {
              code: "INVALID_DISCUSSION_STATE",
              message: "This Discussion is not eligible for another Turn.",
              action: "Read the current Discussion state before requesting another Turn.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionOutputPolicyBlockedError) {
          return errorResponse(
            422,
            {
              code: "OUTPUT_BLOCKED",
              message: "The generated Turn did not pass the Discussion output policy.",
              action: SAFE_OUTPUT_ALTERNATIVE,
              category: error.category,
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionInvalidGeneratedTurnError) {
          return errorResponse(
            502,
            {
              code: "INVALID_RESPONSE",
              message: "The generated Turn did not match the safe response contract.",
              action: "Start a new Discussion or try again later.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionGenerationOutputLimitError) {
          return errorResponse(
            502,
            {
              code: "OUTPUT_LIMIT_EXCEEDED",
              message: "The generated Turn exceeded the configured output limit.",
              action: "Start a new Discussion or try again later.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionGenerationTimeoutError) {
          return errorResponse(
            504,
            {
              code: "GENERATION_TIMEOUT",
              message: "The next Turn reached the server generation timeout.",
              action: "Start a new Discussion and try again later.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionStoppedError) {
          return errorResponse(
            409,
            {
              code: "DISCUSSION_STOPPED",
              message: "The Discussion was stopped before the next Turn completed.",
              action: "Start a new Discussion to continue with a fresh Topic and Transcript.",
            },
            session.setCookie,
          );
        }

        if (error instanceof DiscussionGenerationFailedError) {
          return errorResponse(
            502,
            {
              code: "GENERATION_FAILED",
              message: "The next Turn could not be generated safely.",
              action: error.retryable
                ? "Retry this Turn with the same request identity."
                : "Start a new Discussion or try again later.",
              retryable: error.retryable,
            },
            session.setCookie,
          );
        }

        return errorResponse(
          500,
          {
            code: "INVALID_RESPONSE",
            message: "The Discussion could not be advanced safely.",
            action: "Read the current Discussion state before trying again.",
          },
          session.setCookie,
        );
      }
    },

    async postStop(
      request: Request,
      untrustedId: string,
    ): Promise<Response> {
      const parsedId = parseDiscussionIdentifier(untrustedId);
      if (!parsedId.ok) return parsedId.response;

      const guarded = await authenticateRequest(request);
      if ("response" in guarded) return guarded.response;
      const { session } = guarded;

      try {
        const discussion = runner.stop(session.id, parsedId.id);
        if (!discussion) {
          return errorResponse(
            404,
            {
              code: "DISCUSSION_NOT_FOUND",
              message: "This Discussion is not available in the current session.",
              action: "Start a new Discussion in this session or return to the session that created it.",
            },
            session.setCookie,
          );
        }

        return discussionResponse(discussion, 200, session.setCookie);
      } catch (error) {
        if (error instanceof DiscussionInvalidStateError) {
          return errorResponse(
            409,
            {
              code: "INVALID_DISCUSSION_STATE",
              message: "This Discussion has no active generation to stop.",
              action: "Read the current Discussion state before trying to stop it.",
            },
            session.setCookie,
          );
        }

        return errorResponse(
          500,
          {
            code: "INVALID_RESPONSE",
            message: "The Discussion could not be stopped safely.",
            action: "Read the current Discussion state before trying again.",
            retryable: true,
          },
          session.setCookie,
        );
      }
    },

    async get(request: Request, untrustedId: string): Promise<Response> {
      const parsedId = parseDiscussionIdentifier(untrustedId);
      if (!parsedId.ok) return parsedId.response;

      const guarded = await authenticateRequest(request);
      if ("response" in guarded) return guarded.response;
      const { session } = guarded;

      const discussion = service.read(session.id, parsedId.id);
      if (!discussion) {
        return errorResponse(
          404,
          {
            code: "DISCUSSION_NOT_FOUND",
            message: "This Discussion is not available in the current session.",
            action: "Start a new Discussion in this session or return to the session that created it.",
          },
          session.setCookie,
        );
      }

      return discussionResponse(discussion, 200, session.setCookie);
    },
  };
}
