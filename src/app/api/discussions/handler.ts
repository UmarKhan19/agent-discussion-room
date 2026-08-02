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
  DiscussionCompletedError,
  DiscussionGenerationFailedError,
  DiscussionInvalidGeneratedTurnError,
  DiscussionInvalidStateError,
  DiscussionOutputPolicyBlockedError,
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
import type { SignedSessionManager } from "@/discussion/signed-session";

function errorResponse(
  status: number,
  error: ProductError,
  setCookie?: string,
): Response {
  const body = ErrorResponseSchema.parse({ error });
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
    Vary: "Cookie",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
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

function invalidNextTurnRequest(body: unknown): ProductError {
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

function invalidStartRequest(body: unknown): ProductError {
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
) {
  return {
    async post(request: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await request.json();
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

      const session = sessions.authenticate(request);
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
          },
          session.setCookie,
        );
      }
    },

    async postTurn(
      request: Request,
      untrustedId: string,
    ): Promise<Response> {
      const parsedId = DiscussionIdentifierSchema.safeParse(untrustedId);
      if (!parsedId.success) {
        return errorResponse(400, {
          code: "INVALID_DISCUSSION_ID",
          message: "The Discussion identifier is malformed.",
          action: "Use the UUID returned when the Discussion was started.",
        });
      }

      let body: unknown;
      try {
        body = await request.json();
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

      const session = sessions.authenticate(request);
      try {
        const discussion = await runner.nextTurn(
          session.id,
          parsedId.data,
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
              category: error.outcome.category,
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

        if (error instanceof DiscussionGenerationFailedError) {
          return errorResponse(
            502,
            {
              code: "GENERATION_FAILED",
              message: "The next Turn could not be generated safely.",
              action: "Start a new Discussion or try again later.",
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

    async get(request: Request, untrustedId: string): Promise<Response> {
      const parsedId = DiscussionIdentifierSchema.safeParse(untrustedId);
      if (!parsedId.success) {
        return errorResponse(400, {
          code: "INVALID_DISCUSSION_ID",
          message: "The Discussion identifier is malformed.",
          action: "Use the UUID returned when the Discussion was started.",
        });
      }

      const session = sessions.authenticate(request);
      const discussion = service.read(session.id, parsedId.data);
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
