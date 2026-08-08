// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscussionState } from "@/discussion/contracts";
import DiscussionRoom from "./discussion-room";
import { Transcript } from "./components/transcript";
import Home from "./page";

const { pushMock, stableRouter, pathnameRef } = vi.hoisted(() => {
  const pushMock = vi.fn();
  return {
    pushMock,
    stableRouter: { push: pushMock },
    pathnameRef: { current: "/" },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
  usePathname: () => pathnameRef.current,
}));

/**
 * Structural UI-contract tests: every primary control rides the touch-target
 * and narrow-screen surfaces, long Topics and Messages ride the reflow
 * surface, and the page shell is bounded. The CSS rules behind these classes
 * are verified mechanically in theme.test.ts; real viewport, zoom, and theme
 * rendering checks are documented in docs/responsive-ui.md and belong to the
 * browser suite.
 */

const topic = "Should cities create more public parks?";
const requestId = "22222222-2222-4222-8222-222222222222";
const discussionId = "11111111-1111-4111-8111-111111111111";

const initialDiscussion: DiscussionState = {
  id: discussionId,
  topic,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        action: `Action for ${code}.`,
        retryable: true,
      },
    },
    status,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  pushMock.mockReset();
  pathnameRef.current = "/";
});

/** Hydrate-mode flow: the persisted state is fetched, then an idle
 *  Discussion advances Turns. The first call is always the hydration GET. */
function renderHydratedFlow(
  fetchMock: ReturnType<typeof vi.fn>,
  id: string = discussionId,
) {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", { randomUUID: () => requestId });
  pathnameRef.current = `/discussions/${id}`;
  return render(<DiscussionRoom discussionId={id} />);
}

function expectControlSurface(button: HTMLElement) {
  expect(button.classList).toContain("control");
  expect(button.classList).toContain("control-block");
}

describe("touch targets and narrow-screen layout", () => {
  it("renders the page shell bounded and stacked for narrow screens", () => {
    render(<Home />);
    const main = screen.getByRole("main");
    expect(main.classList).toContain("page-shell");
    expect(main.classList).toContain("flex-col");
    expect(screen.getByRole("button", { name: "Start Discussion" })).toBeTruthy();
  });

  it("keeps Start, Stop, and Retry on the touch-target and full-width control surfaces", async () => {
    // Start surface (create page).
    render(<Home />);
    const start = screen.getByRole("button", { name: "Start Discussion" });
    expectControlSurface(start);
    cleanup();

    // Stop surface: generation is in flight on the hydrated page.
    const stopFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    renderHydratedFlow(stopFetchMock);
    await waitFor(() => expect(stopFetchMock).toHaveBeenCalledTimes(2));
    const stop = screen.getByRole("button", { name: "Stop Discussion" });
    expectControlSurface(stop);
    cleanup();

    // Retry surface: a retryable Turn failure on the hydrated page.
    const failed = {
      ...initialDiscussion,
      status: "failed",
      terminalReason: null,
    };
    const retryFetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          502,
          "GENERATION_FAILED",
          "The next Turn could not be generated safely.",
        ),
      )
      .mockResolvedValueOnce(jsonResponse(failed));
    renderHydratedFlow(retryFetchMock);
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    expectControlSurface(retry);
  });

  it("keeps Jump to Latest on the touch-target surface and clear of the newest Message", async () => {
    const message = {
      id: "33333333-3333-4333-8333-333333333333",
      content: "Public parks give more residents access to shared green space.",
      speaker: "supporter",
      createdAt: "2026-08-02T12:00:01.000Z",
      turn: 1,
      generation: {
        requestId,
        usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
        outputPolicyOutcome: {
          decision: "allowed",
          category: null,
          checkedAt: "2026-08-02T12:00:01.000Z",
        },
      },
    } as const;
    render(<Transcript messages={[message]} />);
    const scrollEl = screen.getByRole("list").parentElement!;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 400,
    });
    scrollEl.scrollTop = 100;
    fireEvent.scroll(scrollEl);

    const jump = screen.getByRole("button", { name: "Jump to Latest" });
    expect(jump.classList).toContain("control");
    expect(scrollEl.className).toContain("pb-20");
  });
});

describe("text zoom and reflow", () => {
  it("keeps long Topics on the reflow surface so they wrap instead of overflowing", async () => {
    const longWord = "Supercalifragilisticexpialidocious".repeat(5);
    const longTopic = `${longWord} Should cities create more public parks?`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ...initialDiscussion, topic: longTopic }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    renderHydratedFlow(fetchMock);

    const heading = await screen.findByRole("heading", {
      name: longTopic,
      level: 2,
    });
    expect(heading.classList).toContain("reflow");
  });
});
