import type { DiscussionState, Speaker } from "@/discussion/contracts";
import type { DiscussionErrorFamily } from "@/app/discussion-error";

/**
 * Participant-visible lifecycle phase of a Discussion. The server state is
 * authoritative; client flags cover only requests that are in flight between
 * server responses (starting, stopping, generating).
 */
export type LifecyclePhase =
  | { kind: "empty" }
  | { kind: "starting" }
  | { kind: "hydrating" }
  | { kind: "ready" }
  | { kind: "generating"; speaker: Speaker | null }
  | { kind: "stopping" }
  | { kind: "completed" }
  | { kind: "stopped" }
  | { kind: "failed"; reason: "timeout" | "other" };

export interface LifecycleOverlay {
  isStarting: boolean;
  /**
   * True while an existing Discussion is being hydrated from the
   * authoritative persisted state; the UI must not show a blank or new
   * Discussion, and must not start a Turn, before hydration resolves.
   */
  isHydrating: boolean;
  isStopping: boolean;
  isGenerating: boolean;
  generatingSpeaker: Speaker | null;
  /**
   * Family of the most recent error when the server state is not terminal.
   * Terminal and unknown errors mark the Discussion failed even when the
   * last known server state was idle, so the banner never contradicts the
   * alert copy after a failed refresh.
   */
  errorFamily: DiscussionErrorFamily | null;
}

export function derivePhase(
  discussion: DiscussionState | null,
  overlay: LifecycleOverlay,
): LifecyclePhase {
  if (overlay.isHydrating && !discussion) return { kind: "hydrating" };
  if (overlay.isStarting && !discussion) return { kind: "starting" };
  if (!discussion) return { kind: "empty" };

  if (discussion.status === "completed") return { kind: "completed" };
  if (discussion.status === "stopped") return { kind: "stopped" };
  if (discussion.status === "failed") {
    return {
      kind: "failed",
      reason: discussion.terminalReason === "timeout" ? "timeout" : "other",
    };
  }
  if (overlay.isStopping) return { kind: "stopping" };
  if (overlay.isGenerating || discussion.status === "generating") {
    return { kind: "generating", speaker: overlay.generatingSpeaker };
  }
  if (
    overlay.errorFamily === "terminal" ||
    overlay.errorFamily === "unknown"
  ) {
    return { kind: "failed", reason: "other" };
  }
  return { kind: "ready" };
}

function speakerLabel(speaker: Speaker | null): string {
  return speaker === "supporter"
    ? "Supporter"
    : speaker === "opponent"
      ? "Opponent"
      : "the next";
}

export function lifecycleStatusCopy(phase: LifecyclePhase): string {
  switch (phase.kind) {
    case "empty":
      return "No active Discussion. Enter a Topic and choose Start Discussion.";
    case "starting":
      return "Starting Discussion…";
    case "hydrating":
      return "Loading Discussion…";
    case "ready":
      return "Ready for the next Turn.";
    case "generating":
      return `Generating ${speakerLabel(phase.speaker)} Turn…`;
    case "stopping":
      return "Stopping Discussion…";
    case "completed":
      return "Discussion completed.";
    case "stopped":
      return "Discussion stopped.";
    case "failed":
      return phase.reason === "timeout"
        ? "Discussion timed out."
        : "Discussion failed.";
  }
}

export function LifecycleStatus({ phase }: { phase: LifecyclePhase }) {
  const copy = lifecycleStatusCopy(phase);
  const tone =
    phase.kind === "completed"
      ? "text-success"
      : phase.kind === "failed"
        ? "text-error"
        : phase.kind === "stopped"
          ? "text-warning"
          : "text-muted";
  return (
    <p role="status" className={`font-semibold ${tone}`}>
      {copy}
    </p>
  );
}
