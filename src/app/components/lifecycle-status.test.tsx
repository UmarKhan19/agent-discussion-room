// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiscussionState } from "@/discussion/contracts";
import {
  LifecycleStatus,
  derivePhase,
  lifecycleStatusCopy,
  type LifecycleOverlay,
  type LifecyclePhase,
} from "./lifecycle-status";

const idleDiscussion: DiscussionState = {
  id: "11111111-1111-4111-8111-111111111111",
  topic: "Should cities create more public parks?",
  status: "idle",
  terminalReason: null,
  turnLimit: 12,
  turnCount: 0,
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
  policyOutcome: {
    decision: "allowed",
    category: null,
    checkedAt: "2026-08-02T12:00:00.000Z",
  },
  transcript: [],
};

const overlay: LifecycleOverlay = {
  isStarting: false,
  isStopping: false,
  isGenerating: false,
  generatingSpeaker: null,
  errorFamily: null,
};

describe("derivePhase", () => {
  it("distinguishes empty, starting, and ready phases", () => {
    expect(derivePhase(null, overlay)).toEqual({ kind: "empty" });
    expect(
      derivePhase(null, { ...overlay, isStarting: true }),
    ).toEqual({ kind: "starting" });
    expect(derivePhase(idleDiscussion, overlay)).toEqual({ kind: "ready" });
  });

  it("distinguishes generating, stopping, completed, stopped, and failed phases", () => {
    expect(
      derivePhase(idleDiscussion, {
        ...overlay,
        isGenerating: true,
        generatingSpeaker: "opponent",
      }),
    ).toEqual({ kind: "generating", speaker: "opponent" });
    expect(
      derivePhase(idleDiscussion, { ...overlay, isStopping: true }),
    ).toEqual({ kind: "stopping" });
    expect(
      derivePhase({ ...idleDiscussion, status: "completed" }, overlay),
    ).toEqual({ kind: "completed" });
    expect(
      derivePhase(
        { ...idleDiscussion, status: "stopped", terminalReason: "stop" },
        overlay,
      ),
    ).toEqual({ kind: "stopped" });
    expect(
      derivePhase(
        { ...idleDiscussion, status: "failed", terminalReason: null },
        overlay,
      ),
    ).toEqual({ kind: "failed", reason: "other" });
    expect(
      derivePhase(
        { ...idleDiscussion, status: "failed", terminalReason: "timeout" },
        overlay,
      ),
    ).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("treats a server-generating Discussion as generating even without client flags", () => {
    expect(
      derivePhase({ ...idleDiscussion, status: "generating" }, overlay),
    ).toEqual({ kind: "generating", speaker: null });
  });

  it("marks an idle Discussion failed when a terminal or unknown error is pending", () => {
    expect(
      derivePhase(idleDiscussion, { ...overlay, errorFamily: "terminal" }),
    ).toEqual({ kind: "failed", reason: "other" });
    expect(
      derivePhase(idleDiscussion, { ...overlay, errorFamily: "unknown" }),
    ).toEqual({ kind: "failed", reason: "other" });
  });

  it("keeps an idle Discussion ready for wait and retry families", () => {
    expect(
      derivePhase(idleDiscussion, { ...overlay, errorFamily: "wait" }),
    ).toEqual({ kind: "ready" });
    expect(
      derivePhase(idleDiscussion, { ...overlay, errorFamily: "retry" }),
    ).toEqual({ kind: "ready" });
    expect(derivePhase(idleDiscussion, overlay)).toEqual({ kind: "ready" });
  });

  it("prioritizes terminal server states over client overlay flags", () => {
    expect(
      derivePhase(
        { ...idleDiscussion, status: "completed" },
        { ...overlay, isGenerating: true, isStopping: true },
      ),
    ).toEqual({ kind: "completed" });
  });
});

describe("LifecycleStatus", () => {
  const phases: LifecyclePhase[] = [
    { kind: "empty" },
    { kind: "starting" },
    { kind: "ready" },
    { kind: "generating", speaker: "supporter" },
    { kind: "generating", speaker: null },
    { kind: "stopping" },
    { kind: "completed" },
    { kind: "stopped" },
    { kind: "failed", reason: "timeout" },
    { kind: "failed", reason: "other" },
  ];

  it("renders a distinct stable copy for every lifecycle state", () => {
    const copies = phases.map(lifecycleStatusCopy);
    expect(new Set(copies).size).toBe(copies.length);

    for (const phase of phases) {
      const { unmount } = render(<LifecycleStatus phase={phase} />);
      const status = screen.getByRole("status");
      expect(status.textContent).toBe(lifecycleStatusCopy(phase));
      unmount();
      cleanup();
    }
  });

  it("keeps participant-visible copy stable for generating and terminal states", () => {
    expect(lifecycleStatusCopy({ kind: "generating", speaker: "supporter" })).toBe(
      "Generating Supporter Turn…",
    );
    expect(lifecycleStatusCopy({ kind: "generating", speaker: null })).toBe(
      "Generating the next Turn…",
    );
    expect(lifecycleStatusCopy({ kind: "completed" })).toBe(
      "Discussion completed.",
    );
    expect(lifecycleStatusCopy({ kind: "stopped" })).toBe(
      "Discussion stopped.",
    );
    expect(lifecycleStatusCopy({ kind: "failed", reason: "timeout" })).toBe(
      "Discussion timed out.",
    );
    expect(lifecycleStatusCopy({ kind: "failed", reason: "other" })).toBe(
      "Discussion failed.",
    );
  });
});
