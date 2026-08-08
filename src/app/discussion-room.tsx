"use client";

import { TOPIC_MAX_LENGTH } from "@/discussion/contracts";
import { Transcript } from "./components/transcript";
import { LifecycleStatus } from "./components/lifecycle-status";
import { DiscussionSynthesis } from "./components/synthesis";
import { useDiscussionController } from "./discussion-controller";

/**
 * Discussion UI: pure composition and rendering over the client-side
 * Discussion controller (`useDiscussionController`). All lifecycle
 * mechanics — Start, Turn advancement, retries, Stop, hydration, synthesis
 * resume, request identities, and race guards — live in the controller;
 * this component only decides what to render from the controller surface.
 */
export default function DiscussionRoom({
  discussionId,
}: {
  discussionId?: string | null;
}) {
  const {
    topic,
    setTopic,
    topicInputRef,
    discussion,
    error,
    isCreateMode,
    isHydrateMode,
    hydrateStatus,
    isStarting,
    isGenerating,
    isStopping,
    canRetrySynthesis,
    phase,
    topicInvalid,
    stopVisible,
    retryVisible,
    newDiscussionVisible,
    showLifecycleStatus,
    startDiscussion,
    startFreshDiscussion,
    retryTurn,
    retrySynthesis,
    stopDiscussion,
    retryHydration,
  } = useDiscussionController(discussionId);

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

      {isCreateMode ? (
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
      ) : null}

      <p role="alert" aria-live="polite" className="min-h-6 text-error">
        {error?.message}
      </p>

      {isHydrateMode && hydrateStatus === "missing" ? (
        <section
          aria-labelledby="missing-discussion-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="missing-discussion-heading" className="text-xl font-semibold sm:text-2xl">
            Discussion unavailable
          </h2>
          <p className="text-muted">
            This Discussion is not available in this browser session. A
            Discussion belongs to the anonymous session that started it — the
            URL alone does not grant access. Start a new Discussion in this
            session, or return to the session that created it.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={startFreshDiscussion}
              className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
            >
              Start a New Discussion
            </button>
          </div>
        </section>
      ) : null}

      {isHydrateMode && hydrateStatus === "error" ? (
        <section
          aria-labelledby="hydration-error-heading"
          className="flex flex-col gap-4"
        >
          <h2 id="hydration-error-heading" className="text-xl font-semibold sm:text-2xl">
            Could not load this Discussion
          </h2>
          <p className="text-muted">
            {error?.message ??
              "The server could not be reached. Check your connection and try again."}
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={retryHydration}
              className="control control-block rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground"
            >
              Retry Loading
            </button>
            <button
              type="button"
              onClick={startFreshDiscussion}
              className="control control-block rounded-lg border border-border bg-surface px-5 py-2 font-semibold text-foreground"
            >
              Start a New Discussion
            </button>
          </div>
        </section>
      ) : null}

      {showLifecycleStatus ? <LifecycleStatus phase={phase} /> : null}

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
          {discussion.status === "completed" &&
          (discussion.synthesis !== undefined || canRetrySynthesis) ? (
            <DiscussionSynthesis
              synthesis={discussion.synthesis ?? null}
              retrying={isGenerating}
              canRetry={canRetrySynthesis}
              onRetry={retrySynthesis}
            />
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
