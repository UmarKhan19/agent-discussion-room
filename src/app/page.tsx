"use client";

import { useState, type FormEvent } from "react";
import {
  DiscussionResponseSchema,
  DiscussionTopicSchema,
  ErrorResponseSchema,
  NextTurnRequestSchema,
  TOPIC_MAX_LENGTH,
  speakerForTurn,
  type DiscussionState,
  type Speaker,
} from "@/discussion/contracts";
import { MessageList } from "./components/message-list";

function topicError(topic: string): string {
  if (topic.trim().length === 0) {
    return "Enter a Discussion Topic before starting.";
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    return `Shorten the Topic to ${TOPIC_MAX_LENGTH} characters or fewer.`;
  }
  return "Use plain text without tabs, line breaks, or control characters.";
}

type DiscussionRequestResult =
  | { ok: true; discussion: DiscussionState }
  | { ok: false; error: string };

async function readDiscussionResponse(
  response: Response,
  fallbackError: string,
): Promise<DiscussionRequestResult> {
  const payload: unknown = await response.json();

  if (!response.ok) {
    const parsedError = ErrorResponseSchema.safeParse(payload);
    return {
      ok: false,
      error: parsedError.success
        ? `${parsedError.data.error.message} ${parsedError.data.error.action}`
        : fallbackError,
    };
  }

  const parsedDiscussion = DiscussionResponseSchema.safeParse(payload);
  if (!parsedDiscussion.success) {
    return {
      ok: false,
      error: "The server returned an invalid Discussion. Please try again.",
    };
  }

  return { ok: true, discussion: parsedDiscussion.data };
}

export default function Home() {
  const [topic, setTopic] = useState("");
  const [discussion, setDiscussion] = useState<DiscussionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingSpeaker, setGeneratingSpeaker] = useState<Speaker | null>(
    null,
  );

  async function advanceDiscussion(initialDiscussion: DiscussionState) {
    setIsGenerating(true);
    let current = initialDiscussion;

    try {
      while (
        current.status === "idle" &&
        current.turnCount < current.turnLimit
      ) {
        const nextSpeaker = speakerForTurn(current.turnCount + 1);
        setGeneratingSpeaker(nextSpeaker);

        const requestBody = NextTurnRequestSchema.parse({
          requestId: crypto.randomUUID(),
        });
        const response = await fetch(`/api/discussions/${current.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        const result = await readDiscussionResponse(
          response,
          "The next Turn could not be generated safely.",
        );
        if (!result.ok) {
          setError(result.error);
          return;
        }

        current = result.discussion;
        setDiscussion(current);
      }
    } catch {
      setError(
        "The next Turn could not be generated. Check your connection and try again.",
      );
    } finally {
      setGeneratingSpeaker(null);
      setIsGenerating(false);
    }
  }

  async function startDiscussion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsedTopic = DiscussionTopicSchema.safeParse(topic);
    if (!parsedTopic.success) {
      setError(topicError(topic));
      return;
    }

    setDiscussion(null);
    setGeneratingSpeaker(null);
    setIsStarting(true);
    try {
      const response = await fetch("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: parsedTopic.data }),
      });
      const result = await readDiscussionResponse(
        response,
        "The Discussion could not be started. Check the Topic and try again.",
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDiscussion(result.discussion);
      void advanceDiscussion(result.discussion);
    } catch {
      setError("The Discussion could not be started. Check your connection and try again.");
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-5 py-10 sm:px-10">
      <header>
        <h1 className="text-3xl font-semibold">Agent Discussion Room</h1>
        <p className="mt-2 text-neutral-600 dark:text-neutral-300">
          Choose a permitted Topic, then explicitly start a bounded Discussion.
        </p>
      </header>

      <form onSubmit={startDiscussion} className="flex flex-col gap-3">
        <label htmlFor="discussion-topic" className="font-semibold">
          Discussion Topic
        </label>
        <textarea
          id="discussion-topic"
          name="topic"
          value={topic}
          maxLength={TOPIC_MAX_LENGTH + 1}
          rows={3}
          aria-describedby="topic-help"
          onChange={(event) => setTopic(event.target.value)}
          className="rounded-lg border border-neutral-500 bg-transparent p-3"
        />
        <p id="topic-help" className="text-sm text-neutral-600 dark:text-neutral-300">
          Enter plain text, up to {TOPIC_MAX_LENGTH} characters.
        </p>
        <button
          type="submit"
          disabled={isStarting || isGenerating}
          className="min-h-11 self-start rounded-lg bg-green-700 px-5 py-2 font-semibold text-white disabled:opacity-60"
        >
          {isStarting ? "Starting Discussion…" : "Start Discussion"}
        </button>
      </form>

      <p role="alert" aria-live="polite" className="min-h-6 text-red-700 dark:text-red-300">
        {error}
      </p>

      {discussion ? (
        <section
          aria-labelledby="active-topic"
          aria-busy={isGenerating}
          className="flex flex-col gap-4"
        >
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide">
              Active Topic
            </p>
            <h2 id="active-topic" className="text-2xl font-semibold">
              {discussion.topic}
            </h2>
          </div>
          <p aria-label="Turn progress">
            {discussion.turnCount} / {discussion.turnLimit} Turns
          </p>
          {isGenerating && generatingSpeaker ? (
            <p role="status" aria-live="polite" className="font-semibold">
              Generating {generatingSpeaker === "supporter" ? "Supporter" : "Opponent"} Turn…
            </p>
          ) : null}
          {discussion.status === "completed" ? (
            <p role="status" aria-live="polite" className="font-semibold">
              Discussion completed.
            </p>
          ) : null}
          <div className="rounded-lg border border-neutral-500 p-6">
            <MessageList messages={discussion.transcript} />
          </div>
        </section>
      ) : (
        <p>No active Discussion. Enter a Topic and choose Start Discussion.</p>
      )}
    </main>
  );
}
