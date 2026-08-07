"use client";

import { useEffect, useRef, useState } from "react";
import type { DiscussionMessage, Speaker } from "@/discussion/contracts";

/** Distance from the newest Message within which the participant is treated as reading the latest content. */
const NEAR_BOTTOM_PX = 128;
/** Bounded tail of announcements kept in the live region so old text is never re-read. */
const MAX_ANNOUNCEMENTS = 5;

function speakerName(speaker: Speaker): string {
  return speaker === "supporter" ? "Supporter" : "Opponent";
}

interface Announcement {
  id: number;
  text: string;
}

/**
 * The Transcript is a semantic ordered conversation log. Each Message carries
 * an explicit Speaker heading so the exchange is followable without color or
 * position. New Messages are announced to screen readers one at a time, model
 * output preserves its paragraph breaks and wraps inside its container, and
 * automatic scrolling yields to the participant's reading position, offering
 * a keyboard-accessible Jump to Latest action when they are reading older
 * Turns.
 */
export function Transcript({
  messages,
}: {
  messages: readonly DiscussionMessage[];
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const newestMessageRef = useRef<HTMLLIElement | null>(null);
  /** Whether the participant's last known position is near the newest Message. */
  const nearBottomRef = useRef(true);
  /**
   * The first effect run is the Transcript's appearance; it must not move an
   * existing reading position, so only later additions may auto-scroll.
   */
  const firstScrollRunRef = useRef(true);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const firstRunRef = useRef(true);
  const announcementIdRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  const newestMessage = messages[messages.length - 1] ?? null;

  // Auto-scroll only when the participant is already near the newest Message;
  // while they read an older Turn, their position is preserved. The first run
  // (the Transcript's appearance) never moves an existing position.
  useEffect(() => {
    if (firstScrollRunRef.current) {
      firstScrollRunRef.current = false;
      return;
    }
    const scrollEl = scrollRef.current;
    if (scrollEl && nearBottomRef.current) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }, [messages.length]);

  // Targeted screen-reader announcements: each Message that arrives while the
  // Transcript is displayed is announced once, by Speaker and Turn, without
  // re-reading earlier Messages. Messages already present when the component
  // mounts are only marked seen, so a refresh never replays the Transcript.
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      for (const message of messages) {
        seenMessageIdsRef.current.add(message.id);
      }
      return;
    }
    const unseen = messages.filter(
      (message) => !seenMessageIdsRef.current.has(message.id),
    );
    if (unseen.length === 0) return;
    for (const message of unseen) {
      seenMessageIdsRef.current.add(message.id);
    }
    const fresh = unseen.map<Announcement>((message, index) => ({
      id: announcementIdRef.current + index + 1,
      text: `New Turn ${message.turn} from the ${speakerName(message.speaker)}.`,
    }));
    announcementIdRef.current += fresh.length;
    setAnnouncements((previous) =>
      [...previous, ...fresh].slice(-MAX_ANNOUNCEMENTS),
    );
  }, [messages]);

  function handleScroll() {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const nearBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <=
      NEAR_BOTTOM_PX;
    nearBottomRef.current = nearBottom;
    setShowJumpToLatest(
      !nearBottom && scrollEl.scrollHeight > scrollEl.clientHeight,
    );
  }

  function jumpToLatest() {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    nearBottomRef.current = true;
    setShowJumpToLatest(false);
    // Move focus with the reading position so keyboard users land on the
    // newest Message instead of being dropped on a disappearing control.
    newestMessageRef.current?.focus();
  }

  return (
    <section
      aria-labelledby="transcript-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <h2
        id="transcript-heading"
        className="px-4 pt-4 text-lg font-semibold sm:px-6 sm:pt-5"
      >
        Transcript
      </h2>
      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`max-h-96 overflow-y-auto px-4 py-4 sm:px-6 ${showJumpToLatest ? "pb-20" : ""}`}
        >
          {messages.length === 0 ? (
            <p>No Turns yet. The Transcript is empty.</p>
          ) : (
            <ol
              aria-label="Discussion Transcript"
              className="flex w-full min-w-0 flex-col gap-4"
            >
              {messages.map((message) => {
                const isNewest = message.id === newestMessage?.id;
                return (
                  <li
                    key={message.id}
                    ref={isNewest ? newestMessageRef : undefined}
                    tabIndex={isNewest ? -1 : undefined}
                    className={`flex min-w-0 w-full flex-col gap-1 rounded-lg p-4 sm:w-3/4 ${
                      message.speaker === "supporter"
                        ? "bg-supporter text-supporter-foreground self-start"
                        : "bg-opponent text-opponent-foreground self-end"
                    }`}
                  >
                    <h3 className="font-semibold">
                      {speakerName(message.speaker)}, Turn {message.turn}
                    </h3>
                    <p className="reflow whitespace-pre-wrap">
                      {message.content}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {showJumpToLatest ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="control absolute inset-x-4 bottom-4 z-10 rounded-lg border border-border bg-surface px-4 py-2 font-semibold shadow-md sm:inset-x-auto sm:right-4"
          >
            Jump to Latest
          </button>
        ) : null}
      </div>
      <div role="log" aria-label="Transcript announcements" className="sr-only">
        {announcements.map((announcement) => (
          <div key={announcement.id}>{announcement.text}</div>
        ))}
      </div>
    </section>
  );
}
