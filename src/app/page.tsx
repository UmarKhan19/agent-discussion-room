"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  DiscussionResponseSchema,
  DiscussionTopicSchema,
  ErrorResponseSchema,
  NextTurnRequestSchema,
  TOPIC_MAX_LENGTH,
  speakerForTurn,
  type DiscussionState,
  type ProductErrorCode,
  type Speaker,
} from "@/discussion/contracts";
import { Transcript } from "./components/transcript";
import {
  LifecycleStatus,
  derivePhase,
} from "./components/lifecycle-status";
import {
  combinedErrorCopy,
  errorFamilyForCode,
  fallbackErrorForStatus,
  malformedServerDataError,
  networkLossError,
  type DiscussionErrorCopy,
  type DiscussionErrorFamily,
} from "./discussion-error";

function topicError(topic: string): string {
  if (topic.trim().length === 0) {
    return "Enter a Discussion Topic before starting.";
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    return `Shorten the Topic to ${TOPIC_MAX_LENGTH} characters or fewer.`;
  }
  return "Use plain text without tabs, line breaks, or control characters.";
}

/** Copy shown to the participant in the alert region. */
interface ParticipantError {
  message: string;
  family: DiscussionErrorFamily;
}

function networkError(family: DiscussionErrorFamily): ParticipantError {
  return { message: combinedErrorCopy(networkLossError()), family };
}

type DiscussionRequestResult =
  | { ok: true; discussion: DiscussionState }
  | { ok: false; error: ParticipantError; retryable: boolean };

/**
 * Decodes a Discussion HTTP response into either the authoritative
 * Discussion state or stable participant copy. Server error envelopes are
 * trusted; malformed or missing envelopes fall back to status-based copy so
 * internals never leak.
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

export default function Home() {
  const [topic, setTopic] = useState("");
  const [discussion, setDiscussion] = useState<DiscussionState | null>(null);
  const [error, setError] = useState<ParticipantError | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [canRetryTurn, setCanRetryTurn] = useState(false);
  const [generatingSpeaker, setGeneratingSpeaker] = useState<Speaker | null>(
    null,
  );
  const generationControllerRef = useRef<AbortController | null>(null);
  const generationRunRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const pendingTurnRef = useRef<{
    discussionId: string;
    requestId: string;
  } | null>(null);
  const topicInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Synchronous double-click guards: the disabled attribute prevents a
  // second activation after re-render; these refs close the same-tick gap.
  const startGuardRef = useRef(false);
  const stopGuardRef = useRef(false);
  const retryGuardRef = useRef(false);

  useEffect(() => {
    return () => {
      generationRunRef.current += 1;
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      pendingTurnRef.current = null;
    };
  }, []);

  /**
   * Bumps the run identity and clears every piece of lifecycle, request,
   * and error state. Used when starting a fresh Discussion and when the
   * participant explicitly resets after completion, Stop, or failure.
   */
  function beginFreshRun(): number {
    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    pendingTurnRef.current = null;
    setCanRetryTurn(false);
    setGeneratingSpeaker(null);
    setIsGenerating(false);
    setIsStopping(false);
    setIsStarting(false);
    setDiscussion(null);
    setError(null);
    return runId;
  }

  function startFreshDiscussion() {
    beginFreshRun();
    setTopic("");
    topicInputRef.current?.focus();
  }

  async function readPersistedDiscussion(
    discussionId: string,
    runId: number,
    signal: AbortSignal,
  ): Promise<DiscussionState | null> {
    const isStale = () =>
      generationRunRef.current !== runId || signal.aborted;
    if (isStale()) return null;

    try {
      const response = await fetch(`/api/discussions/${discussionId}`, {
        method: "GET",
        signal,
      });
      if (isStale() || !response.ok) return null;

      const payload: unknown = await response.json();
      if (isStale()) return null;

      const persistedDiscussion = DiscussionResponseSchema.safeParse(payload);
      if (isStale() || !persistedDiscussion.success) return null;

      return persistedDiscussion.data;
    } catch {
      return null;
    }
  }

  /**
   * Fire-and-forget authoritative refresh after a persisted failure. The
   * refresh has its own controller so it never rides (or blocks) the
   * generation request; a fresh run or a successful Stop aborts it.
   */
  function refreshDiscussion(discussionId: string, runId: number): void {
    const refreshController = new AbortController();
    refreshControllerRef.current = refreshController;
    void readPersistedDiscussion(
      discussionId,
      runId,
      refreshController.signal,
    ).then((persistedDiscussion) => {
      if (refreshControllerRef.current === refreshController) {
        refreshControllerRef.current = null;
      }
      if (
        generationRunRef.current === runId &&
        !refreshController.signal.aborted &&
        persistedDiscussion
      ) {
        setDiscussion(persistedDiscussion);
      }
    });
  }

  async function advanceDiscussion(
    initialDiscussion: DiscussionState,
    runId: number,
    retry = false,
  ) {
    if (generationRunRef.current !== runId) return;

    const controller = new AbortController();
    generationControllerRef.current = controller;
    setCanRetryTurn(false);
    setIsGenerating(true);
    let current = initialDiscussion;

    try {
      while (
        (current.status === "idle" ||
          (retry &&
            current.status === "failed" &&
            current.terminalReason === null)) &&
        current.turnCount < current.turnLimit
      ) {
        const nextSpeaker = speakerForTurn(current.turnCount + 1);
        setGeneratingSpeaker(nextSpeaker);

        const pendingRequest = pendingTurnRef.current;
        const requestId =
          pendingRequest?.discussionId === current.id
            ? pendingRequest.requestId
            : crypto.randomUUID();
        pendingTurnRef.current = {
          discussionId: current.id,
          requestId,
        };
        const requestBody = NextTurnRequestSchema.parse({ requestId });
        const response = await fetch(`/api/discussions/${current.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        if (generationRunRef.current !== runId) return;

        const result = await readDiscussionResponse(response);
        if (generationRunRef.current !== runId) return;
        if (!result.ok) {
          setError(result.error);
          setCanRetryTurn(result.retryable);
          // Claim-time and terminal failures persist a new server state;
          // refresh it so status and controls follow the server. Wait-family
          // and Topic errors leave the Discussion unchanged, so no refresh
          // is needed. Ambiguous network failures are recovered by Retry
          // with the same request identity (replay-safe).
          if (
            result.error.family !== "wait" &&
            result.error.family !== "topic"
          ) {
            refreshDiscussion(current.id, runId);
          }
          if (!result.retryable) {
            pendingTurnRef.current = null;
          }
          return;
        }

        pendingTurnRef.current = null;
        current = result.discussion;
        setDiscussion(current);
        setError(null);
      }
    } catch {
      if (generationRunRef.current !== runId || controller.signal.aborted) {
        return;
      }
      setError(networkError("retry"));
      setCanRetryTurn(true);
    } finally {
      if (generationRunRef.current === runId) {
        generationControllerRef.current = null;
        setGeneratingSpeaker(null);
        setIsGenerating(false);
        retryGuardRef.current = false;
      }
    }
  }

  function retryTurn() {
    if (
      !discussion ||
      !pendingTurnRef.current ||
      pendingTurnRef.current.discussionId !== discussion.id ||
      isGenerating ||
      isStopping ||
      retryGuardRef.current
    ) {
      return;
    }

    retryGuardRef.current = true;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setError(null);
    void advanceDiscussion(discussion, generationRunRef.current, true);
  }

  async function startDiscussion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (startGuardRef.current) return;

    const parsedTopic = DiscussionTopicSchema.safeParse(topic);
    if (!parsedTopic.success) {
      setError({ message: topicError(topic), family: "topic" });
      topicInputRef.current?.focus();
      return;
    }

    startGuardRef.current = true;
    const runId = beginFreshRun();
    setIsStarting(true);
    try {
      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: parsedTopic.data }),
      });
      if (generationRunRef.current !== runId) return;

      const result = await readDiscussionResponse(response);
      if (generationRunRef.current !== runId) return;
      if (!result.ok) {
        setError(result.error);
        if (result.error.family === "topic") {
          topicInputRef.current?.focus();
        }
        return;
      }

      setDiscussion(result.discussion);
      void advanceDiscussion(result.discussion, runId);
    } catch {
      if (generationRunRef.current === runId) {
        setError(networkError("unknown"));
      }
    } finally {
      if (generationRunRef.current === runId) {
        setIsStarting(false);
        startGuardRef.current = false;
      }
    }
  }

  async function stopDiscussion() {
    if (!discussion) return;
    const serverGenerating =
      isGenerating || discussion.status === "generating";
    if (!serverGenerating || isStopping || stopGuardRef.current) {
      return;
    }

    const activeRunId = generationRunRef.current;
    const turnController = generationControllerRef.current;
    stopGuardRef.current = true;
    setIsStopping(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/discussions/${discussion.id}/stop`,
        { method: "POST" },
      );
      if (generationRunRef.current !== activeRunId) return;

      const result = await readDiscussionResponse(response);
      if (generationRunRef.current !== activeRunId) return;

      if (!result.ok) {
        setError(result.error);
        setCanRetryTurn(false);
        // Stop failed while generation may still be running; refresh the
        // authoritative state so status and controls match the server.
        refreshDiscussion(discussion.id, activeRunId);
        return;
      }
      if (result.discussion.status !== "stopped") {
        setError({
          message: combinedErrorCopy(malformedServerDataError()),
          family: "unknown",
        });
        setCanRetryTurn(false);
        refreshDiscussion(discussion.id, activeRunId);
        return;
      }

      generationRunRef.current = activeRunId + 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      setDiscussion(result.discussion);
      pendingTurnRef.current = null;
      setCanRetryTurn(false);
      setError(null);
      setGeneratingSpeaker(null);
      setIsGenerating(false);
      setIsStopping(false);
      stopGuardRef.current = false;
      turnController?.abort();
      if (generationControllerRef.current === turnController) {
        generationControllerRef.current = null;
      }
    } catch {
      if (generationRunRef.current === activeRunId) {
        setError(networkError("unknown"));
      }
    } finally {
      if (generationRunRef.current === activeRunId) {
        setIsStopping(false);
        stopGuardRef.current = false;
      }
    }
  }

  const phase = derivePhase(discussion, {
    isStarting,
    isStopping,
    isGenerating,
    generatingSpeaker,
    errorFamily: error?.family ?? null,
  });
  const stopVisible = phase.kind === "generating" || phase.kind === "stopping";
  const retryVisible = canRetryTurn && !isGenerating && !isStopping;
  const newDiscussionVisible =
    discussion !== null &&
    (phase.kind === "completed" ||
      phase.kind === "stopped" ||
      phase.kind === "failed" ||
      error?.family === "terminal" ||
      error?.family === "unknown");
  const topicInvalid = error?.family === "topic";

  return (
    <main className="page-shell flex min-h-dvh flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Agent Discussion Room
        </h1>
        <p className="mt-2 text-muted">
          Choose a permitted Topic, then explicitly start a bounded Discussion
          between a Supporter and an Opponent.
        </p>
      </header>

      <form onSubmit={startDiscussion} className="flex flex-col gap-3">
        <label htmlFor="discussion-topic" className="font-semibold">
          Discussion Topic
        </label>
        <textarea
          id="discussion-topic"
          name="topic"
          ref={topicInputRef}
          value={topic}
          maxLength={TOPIC_MAX_LENGTH + 1}
          rows={3}
          aria-describedby="topic-help"
          aria-invalid={topicInvalid || undefined}
          onChange={(event) => setTopic(event.target.value)}
          className="rounded-lg border border-border bg-surface p-3"
        />
        <p id="topic-help" className="text-sm text-muted">
          Enter plain text, up to {TOPIC_MAX_LENGTH} characters.
        </p>
        <button
          type="submit"
          disabled={isStarting || isGenerating || isStopping}
          className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
        >
          {isStarting ? "Starting Discussion…" : "Start Discussion"}
        </button>
      </form>

      <p role="alert" aria-live="polite" className="min-h-6 text-error">
        {error?.message}
      </p>

      <LifecycleStatus phase={phase} />

      {discussion ? (
        <section
          aria-labelledby="active-topic"
          aria-busy={isGenerating || isStopping}
          className="flex flex-col gap-4"
        >
          <div>
            <p className="text-sm font-semibold tracking-wide text-muted uppercase">
              Active Topic
            </p>
            <h2
              id="active-topic"
              className="reflow text-xl font-semibold sm:text-2xl"
            >
              {discussion.topic}
            </h2>
          </div>
          <p
            aria-label="Turn progress"
            className="font-medium text-muted tabular-nums"
          >
            {discussion.turnCount} / {discussion.turnLimit} Turns
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {stopVisible ? (
              <button
                type="button"
                onClick={() => void stopDiscussion()}
                disabled={isStopping}
                className="control control-block rounded-lg bg-danger px-5 py-2 font-semibold text-danger-foreground disabled:opacity-60"
              >
                Stop Discussion
              </button>
            ) : null}
            {retryVisible ? (
              <button
                type="button"
                onClick={retryTurn}
                disabled={isStopping}
                className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
              >
                Retry Turn
              </button>
            ) : null}
            {newDiscussionVisible ? (
              <button
                type="button"
                onClick={startFreshDiscussion}
                className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
              >
                Start a New Discussion
              </button>
            ) : null}
          </div>
          <Transcript messages={discussion.transcript} />
        </section>
      ) : null}
    </main>
  );
}
