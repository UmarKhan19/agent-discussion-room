// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { NextTurnRequestSchema } from "@/discussion/contracts";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiscussionRoom from "./discussion-room";
import Home from "./page";

const { pushMock, stableRouter, pathnameRef } = vi.hoisted(() => {
  const pushMock = vi.fn();
  return {
    pushMock,
    // useRouter must return a stable object identity: the create-mode mount
    // effect depends on `router`, and a fresh object per render would re-run
    // it (and auto-retry the persisted pending Start identity) after every
    // render.
    stableRouter: { push: pushMock },
    pathnameRef: { current: "/" },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
  usePathname: () => pathnameRef.current,
}));

const topic = "Should cities create more public parks?";
const discussionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const secondRequestId = "44444444-4444-4444-8444-444444444444";
const messageContent =
  "Public parks give more residents access to shared green space.";
const initialDiscussion = {
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
const discussionWithFirstTurn = {
  ...initialDiscussion,
  turnCount: 1,
  transcript: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      content: messageContent,
      speaker: "supporter",
      createdAt: "2026-08-02T12:00:01.000Z",
      turn: 1,
      generation: {
        requestId,
        usage: {
          inputTokens: 12,
          outputTokens: 9,
          totalTokens: 21,
        },
        outputPolicyOutcome: {
          decision: "allowed",
          category: null,
          checkedAt: "2026-08-02T12:00:01.000Z",
        },
      },
    },
  ],
};

const PENDING_START_KEY = "agent-discussion-room:pending-start";
const PENDING_TURN_KEY = "agent-discussion-room:pending-turn";
const FOCUS_TOPIC_ON_CREATE_KEY = "agent-discussion-room:focus-topic-on-create";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  action = `Action for ${code}.`,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        action,
        retryable: true,
        ...extra,
      },
    },
    status,
  );
}

function seedPendingStart(override: Record<string, string> = {}): void {
  window.sessionStorage.setItem(
    PENDING_START_KEY,
    JSON.stringify({ requestId, topic, ...override }),
  );
}

function seedPendingTurn(override: Record<string, string> = {}): void {
  window.sessionStorage.setItem(
    PENDING_TURN_KEY,
    JSON.stringify({ discussionId, requestId, ...override }),
  );
}

function storedPendingStart(): { requestId: string; topic: string } | null {
  const raw = window.sessionStorage.getItem(PENDING_START_KEY);
  return raw ? (JSON.parse(raw) as { requestId: string; topic: string }) : null;
}

function renderHome(): ReturnType<typeof render> {
  return render(<Home />);
}

function renderHydrated(
  id: string = discussionId,
): ReturnType<typeof render> {
  pathnameRef.current = `/discussions/${id}`;
  return render(<DiscussionRoom discussionId={id} />);
}

function postedBody(call: unknown[]): unknown {
  return JSON.parse(String((call[1] as { body: string } | undefined)?.body));
}

function turnPosts(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter(
    (call) =>
      call[0] === `/api/discussions/${discussionId}` &&
      (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
  pushMock.mockReset();
  pathnameRef.current = "/";
});

describe("create page", () => {
  it("waits for an explicit action, then shows Topic, empty state, and progress", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHome();
    const user = userEvent.setup();
    expect(
      screen.getByRole("heading", { name: "Agent Discussion Room" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "No active Discussion",
    );
    expect(screen.getByRole("button", { name: "Start Discussion" })).toBeTruthy();
    const topicControl = screen.getByRole("textbox", {
      name: "Discussion Topic",
    });
    await user.type(topicControl, topic);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Starts a Discussion, posts the creation request identity, and navigates to its canonical URL without advancing the create page", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion, 201))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    renderHome();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "Discussion Topic" }),
      topic,
    );
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBody(fetchMock.mock.calls[0])).toEqual({
      topic,
      creationRequestId: requestId,
    });
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/discussions/${discussionId}`),
    );
    // The create page never advances: the Topic stays editable and no
    // Discussion heading appears here.
    expect(screen.getByRole("textbox", { name: "Discussion Topic" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: topic, level: 2 })).toBeNull();
    // The pending identity survives navigation so an ambiguous Start
    // response stays replay-safe on the hydrated page.
    expect(storedPendingStart()).toEqual({ requestId, topic });
  });

  it("reuses a pending Start identity for the same Topic and mints a new one for a different Topic", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(initialDiscussion, 201));
    vi.stubGlobal("fetch", fetchMock);
    renderHome();
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: "Discussion Topic" });
    await user.type(input, topic);
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(storedPendingStart()).toEqual({ requestId, topic });

    // Same Topic again → the same identity, so the server replays the
    // original Discussion instead of creating an orphan.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start Discussion" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(2));
    expect(postedBody(fetchMock.mock.calls[1])).toEqual({
      topic,
      creationRequestId: requestId,
    });

    // A different Topic is a genuinely new Start: mint a fresh identity.
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(secondRequestId) });
    await user.clear(input);
    await user.type(input, "A different permitted Topic");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start Discussion" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(3));
    expect(postedBody(fetchMock.mock.calls[2])).toEqual({
      topic: "A different permitted Topic",
      creationRequestId: secondRequestId,
    });
  });

  it("auto-retries a pending Start on mount after a lost response", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    let resolveStart!: (value: Response) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveStart = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    seedPendingStart();

    renderHome();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedBody(fetchMock.mock.calls[0])).toEqual({
      topic,
      creationRequestId: requestId,
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Starting Discussion…",
    );

    await act(async () => {
      resolveStart(jsonResponse(initialDiscussion, 201));
    });
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/discussions/${discussionId}`),
    );
  });

  it("auto-retries a pending Start on mount under a StrictMode double-invocation", async () => {
    // Next.js dev wraps the app in StrictMode, which runs mount effects
    // twice (mount, cleanup, mount). The cleanup of the first invocation
    // cancels its in-flight retry and must release the start guard so the
    // second invocation can complete the recovery; without that, the
    // ambiguous-Start recovery is silently stranded with no navigation and
    // no error.
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(initialDiscussion, 201));
    vi.stubGlobal("fetch", fetchMock);
    seedPendingStart();

    render(
      <StrictMode>
        <Home />
      </StrictMode>,
    );
    // The double invocation may retry twice; both posts carry the same
    // creation identity, so both replay the same Discussion.
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const posts = fetchMock.mock.calls.filter(
      (call) => call[0] === "/api/discussions",
    );
    expect(posts.length).toBeGreaterThanOrEqual(1);
    for (const call of posts) {
      expect(postedBody(call)).toEqual({ topic, creationRequestId: requestId });
    }
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith(`/discussions/${discussionId}`),
    );
  });

  it("burns the pending identity and focuses the Topic control on a topic-family error", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(422, "TOPIC_BLOCKED", "This Topic is blocked.", {
          retryable: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    seedPendingStart();

    renderHome();
    // The seeded pending Start is auto-retried on mount; the server's
    // topic-family rejection burns the identity and focuses the control.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const input = screen.getByRole("textbox", { name: "Discussion Topic" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "This Topic is blocked.",
    );
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/No active Discussion/)).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
    expect(storedPendingStart()).toBeNull();
  });

  it("rejects a Topic longer than the client maximum before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHome();
    const user = userEvent.setup();
    const topicControl = screen.getByRole("textbox", {
      name: "Discussion Topic",
    });
    await user.type(topicControl, "x".repeat(241));
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "240 characters or fewer",
    );
  });

  it("prevents duplicate Start submissions from rapid double-clicks", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion, 201))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);

    renderHome();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Discussion Topic" }),
      topic,
    );
    const start = screen.getByRole("button", { name: "Start Discussion" });
    fireEvent.click(start);
    fireEvent.click(start);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((call) => call[0] === "/api/discussions")
          .length,
      ).toBe(1),
    );
  });
});

describe("hydrated Discussion page", () => {
  it("hydrates the persisted state and advances one authorized request at a time with visible progress to completion", async () => {
    const firstRequestId = requestId;
    const secondRequestId = "44444444-4444-4444-8444-444444444444";
    const boundedInitial = { ...initialDiscussion, turnLimit: 2 };
    const firstTurn = {
      ...discussionWithFirstTurn,
      turnLimit: 2,
    };
    const completed = {
      ...firstTurn,
      status: "completed",
      turnCount: 2,
      transcript: [
        ...firstTurn.transcript,
        {
          ...firstTurn.transcript[0],
          id: "55555555-5555-4555-8555-555555555555",
          content: "Dense development can leave more land available for parks.",
          speaker: "opponent",
          turn: 2,
          generation: {
            ...firstTurn.transcript[0].generation,
            requestId: secondRequestId,
          },
        },
      ],
    };
    let resolveFirstTurn: ((response: Response) => void) | undefined;
    let resolveSecondTurn: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirstTurn = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSecondTurn = resolve;
        }),
      );
    const generatedIds = [firstRequestId, secondRequestId];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => generatedIds.shift() });
    renderHydrated();
    expect(await screen.findByRole("heading", { name: topic, level: 2 })).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/discussions/${discussionId}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(screen.getByRole("status").textContent).toContain(
      "Generating Supporter Turn",
    );

    resolveFirstTurn?.(jsonResponse(firstTurn));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Turn progress").textContent).toContain("1 / 2");
    expect(screen.getByRole("status").textContent).toContain(
      "Generating Opponent Turn",
    );
    expect(screen.getByText(messageContent)).toBeTruthy();

    resolveSecondTurn?.(jsonResponse(completed));
    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain("2 / 2");
    expect(screen.queryByText(/Generating .* Turn/)).toBeNull();
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([firstRequestId, secondRequestId]);
  });

  it("announces each newly committed Turn without re-reading earlier Messages", async () => {
    const firstRequestId = requestId;
    const secondRequestId = "44444444-4444-4444-8444-444444444444";
    const boundedInitial = { ...initialDiscussion, turnLimit: 2 };
    const firstTurn = {
      ...discussionWithFirstTurn,
      turnLimit: 2,
    };
    const completed = {
      ...firstTurn,
      status: "completed",
      turnCount: 2,
      transcript: [
        ...firstTurn.transcript,
        {
          ...firstTurn.transcript[0],
          id: "55555555-5555-4555-8555-555555555555",
          content: "Dense development can leave more land available for parks.",
          speaker: "opponent",
          turn: 2,
          generation: {
            ...firstTurn.transcript[0].generation,
            requestId: secondRequestId,
          },
        },
      ],
    };
    let resolveFirstTurn: ((response: Response) => void) | undefined;
    let resolveSecondTurn: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveFirstTurn = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSecondTurn = resolve;
        }),
      );
    const generatedIds = [firstRequestId, secondRequestId];
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => generatedIds.shift() });
    renderHydrated();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveFirstTurn?.(jsonResponse(firstTurn));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    resolveSecondTurn?.(jsonResponse(completed));
    expect(await screen.findByText("Discussion completed.")).toBeTruthy();

    const announce = screen.getByLabelText("Transcript announcements");
    expect(announce.textContent).toContain("New Turn 1");
    await waitFor(() =>
      expect(announce.textContent).toContain("New Turn 2"),
    );
    expect(announce.textContent).not.toContain("New Turn 3");
    expect(
      announce.textContent.match(/New Turn 1/g) ?? [],
    ).toHaveLength(1);
    expect(
      announce.textContent.match(/New Turn 2/g) ?? [],
    ).toHaveLength(1);
    expect(screen.getByText(messageContent)).toBeTruthy();
  });

  it("retries a retryable server failure with the same logical request identity", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const failed = {
      ...boundedInitial,
      status: "failed",
      terminalReason: null,
    };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockResolvedValueOnce(
        errorResponse(
          502,
          "GENERATION_FAILED",
          "The next Turn could not be generated safely.",
          {},
          "Retry this Turn with the same request identity.",
        ),
      )
      .mockResolvedValueOnce(jsonResponse(failed))
      .mockResolvedValueOnce(jsonResponse(completed));
    const randomUUID = vi.fn(() => requestId);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID });
    renderHydrated();
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    expect(screen.getByRole("alert").textContent).toContain(
      "Retry this Turn with the same request identity.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Discussion failed.",
    );
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
    await user.click(retry);

    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([requestId, requestId]);
  });

  it("retries an ambiguous network failure with the same logical request identity", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockRejectedValueOnce(new Error("connection reset after commit status unknown"))
      .mockResolvedValueOnce(jsonResponse(completed));
    const randomUUID = vi.fn(() => requestId);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID });
    renderHydrated();
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    expect(screen.getByRole("alert").textContent).toContain(
      "Check your connection and try again.",
    );
    await user.click(retry);

    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([requestId, requestId]);
  });

  it("prevents duplicate Retry submissions from rapid double-clicks", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const failed = {
      ...boundedInitial,
      status: "failed",
      terminalReason: null,
    };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockResolvedValueOnce(
        errorResponse(
          502,
          "GENERATION_FAILED",
          "The next Turn could not be generated safely.",
          {},
          "Retry this Turn with the same request identity.",
        ),
      )
      .mockResolvedValueOnce(jsonResponse(failed))
      .mockResolvedValueOnce(jsonResponse(completed));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });

    renderHydrated();
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(turnPosts(fetchMock).length).toBe(2);
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([requestId, requestId]);
  });

  it("shows a failed state without Retry for a non-retryable Turn failure and offers a fresh Discussion", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const failed = {
      ...boundedInitial,
      status: "failed",
      terminalReason: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockResolvedValueOnce(
        errorResponse(
          502,
          "OUTPUT_LIMIT_EXCEEDED",
          "The generated Turn exceeded the configured output limit.",
          { retryable: false },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(failed));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    expect(await screen.findByText("Discussion failed.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The generated Turn exceeded the configured output limit.",
    );
    expect(screen.queryByRole("button", { name: "Retry Turn" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "0 / 1",
    );
    expect(screen.getByRole("heading", { name: topic, level: 2 })).toBeTruthy();
  });

  it("restores the Retry identity from the pending Turn entry and retries without minting a new one", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const failed = {
      ...boundedInitial,
      status: "failed",
      terminalReason: null,
    };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(failed))
      .mockResolvedValueOnce(jsonResponse(completed));
    const randomUUID = vi.fn(() => "66666666-6666-4666-8666-666666666666");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID });
    seedPendingTurn();
    renderHydrated();
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    await user.click(retry);

    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([requestId]);
  });

  it("offers no Retry for a retryable failed Discussion without a matching pending Turn identity", async () => {
    const failed = {
      ...initialDiscussion,
      status: "failed",
      terminalReason: null,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(failed));
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    expect(await screen.findByText("Discussion failed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry Turn" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
  });

  it("uses stable ownership-loss copy and offers a fresh Discussion when the server no longer owns the Discussion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          404,
          "DISCUSSION_NOT_FOUND",
          "This Discussion is not available in the current session.",
          { retryable: false },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });

    renderHydrated();
    expect(await screen.findByText("Discussion failed.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "This Discussion is not available in the current session.",
    );
    expect(screen.queryByRole("button", { name: "Retry Turn" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
  });

  it("explains waiting for a rate-limited Turn and keeps the Discussion ready for a same-identity retry", async () => {
    const boundedInitial = { ...initialDiscussion, turnLimit: 1 };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(boundedInitial))
      .mockResolvedValueOnce(
        errorResponse(
          429,
          "RATE_LIMITED",
          "Too many requests from this address or session. Waiting is required.",
          { retryable: true, retryAfterSeconds: 30 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(completed));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "Retry Turn" });
    expect(screen.getByRole("alert").textContent).toContain(
      "You can retry in about 30 seconds.",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Ready for the next Turn.",
    );
    // The wait family never triggers an authoritative refresh: exactly the
    // hydration GET and the Turn POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await user.click(retry);
    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(turnPosts(fetchMock).map((call) =>
      NextTurnRequestSchema.parse(postedBody(call)).requestId,
    )).toEqual([requestId, requestId]);
  });

  it("uses stable fallback copy for malformed server data and offers a fresh Discussion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }))
      .mockResolvedValueOnce(jsonResponse(initialDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });

    renderHydrated();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The server returned an unexpected response.",
    );
    expect(screen.queryByRole("button", { name: "Retry Turn" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Discussion failed.",
    );
  });
});

describe("hydrated Discussion page controls", () => {
  it("stops active generation, aborts its request, and ignores a late Turn response", async () => {
    const stoppedDiscussion = {
      ...initialDiscussion,
      status: "stopped",
      terminalReason: "stop",
    };
    let resolveLateTurn: ((response: Response) => void) | undefined;
    let resolveStop: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveLateTurn = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveStop = resolve;
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const stop = screen.getByRole("button", { name: "Stop Discussion" });
    expect(stop).toBeTruthy();
    const turnSignal = fetchMock.mock.calls[1]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(turnSignal?.aborted).toBe(false);

    await user.click(stop);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/discussions/${discussionId}/stop`,
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(turnSignal?.aborted).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Stop Discussion" })
        .hasAttribute("disabled"),
    ).toBe(true);

    resolveStop?.(jsonResponse(stoppedDiscussion));

    expect(await screen.findByText("Discussion stopped.")).toBeTruthy();
    expect(turnSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop Discussion" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();

    resolveLateTurn?.(jsonResponse(discussionWithFirstTurn));
    await waitFor(() => expect(screen.queryByText(messageContent)).toBeNull());
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "0 / 12",
    );
    expect(screen.getByText("Discussion stopped.")).toBeTruthy();
  });

  it("prevents duplicate Stop requests from rapid double-clicks", async () => {
    const stoppedDiscussion = {
      ...initialDiscussion,
      status: "stopped",
      terminalReason: "stop",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse(stoppedDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const stop = screen.getByRole("button", { name: "Stop Discussion" });
    fireEvent.click(stop);
    fireEvent.click(stop);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Discussion stopped.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith("/stop"),
      ).length,
    ).toBe(1);
  });

  it("keeps generation attached after failed Stop and permits a successful retry", async () => {
    const stoppedDiscussion = {
      ...initialDiscussion,
      status: "stopped",
      terminalReason: "stop",
    };
    let resolveLateTurn: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveLateTurn = resolve;
        }),
      )
      .mockResolvedValueOnce(
        errorResponse(
          500,
          "INVALID_RESPONSE",
          "The Discussion could not be stopped safely.",
          {},
          "Read the current Discussion state before trying again.",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...initialDiscussion, status: "generating" }),
      )
      .mockResolvedValueOnce(jsonResponse(stoppedDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const turnSignal = fetchMock.mock.calls[1]?.[1]?.signal as
      | AbortSignal
      | undefined;

    await user.click(screen.getByRole("button", { name: "Stop Discussion" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("alert").textContent).toContain(
      "The Discussion could not be stopped safely. Read the current Discussion state before trying again.",
    );
    expect(turnSignal?.aborted).toBe(false);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `/api/discussions/${discussionId}`,
    );
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "GET" });
    const retryStop = screen.getByRole("button", { name: "Stop Discussion" });
    expect(retryStop.hasAttribute("disabled")).toBe(false);

    await user.click(retryStop);

    expect(await screen.findByText("Discussion stopped.")).toBeTruthy();
    expect(turnSignal?.aborted).toBe(true);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}/stop`,
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}/stop`,
    ]);
    expect(screen.getByRole("alert").textContent).toBe("");

    resolveLateTurn?.(jsonResponse(discussionWithFirstTurn));
    await waitFor(() => expect(screen.queryByText(messageContent)).toBeNull());
    expect(screen.getByText("Discussion stopped.")).toBeTruthy();
  });

  it("keeps Stop functional when the authoritative refresh reports a server-generating Discussion", async () => {
    const stoppedDiscussion = {
      ...initialDiscussion,
      status: "stopped",
      terminalReason: "stop",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          502,
          "GENERATION_FAILED",
          "The next Turn could not be generated safely.",
          {},
          "Retry this Turn with the same request identity.",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ...initialDiscussion, status: "generating" }),
      )
      .mockResolvedValueOnce(jsonResponse(stoppedDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    const stop = await screen.findByRole("button", { name: "Stop Discussion" });
    expect(screen.getByRole("status").textContent).toContain(
      "Generating the next Turn",
    );
    await user.click(stop);

    expect(await screen.findByText("Discussion stopped.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        (call) => call[0] === `/api/discussions/${discussionId}/stop`,
      ),
    ).toBe(true);
  });

  it("refreshes authoritative timeout state and navigates fresh without stale state", async () => {
    const timedOutDiscussion = {
      ...initialDiscussion,
      status: "failed",
      terminalReason: "timeout",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          504,
          "GENERATION_TIMEOUT",
          "The next Turn reached the server generation timeout.",
          { retryable: false },
          "Start a new Discussion and try again later.",
        ),
      )
      .mockResolvedValueOnce(jsonResponse(timedOutDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    expect(await screen.findByText("Discussion timed out.")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}`,
      `/api/discussions/${discussionId}`,
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
    expect(screen.getByRole("alert").textContent).toContain(
      "The next Turn reached the server generation timeout. Start a new Discussion and try again later.",
    );
    expect(screen.queryByRole("button", { name: "Stop Discussion" })).toBeNull();
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "0 / 12",
    );

    await user.click(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    );
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/"),
    );
    expect(
      window.sessionStorage.getItem(FOCUS_TOPIC_ON_CREATE_KEY),
    ).toBe("1");
    expect(screen.queryByText("Discussion timed out.")).toBeNull();
  });

  it("preserves timeout guidance when authoritative refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          504,
          "GENERATION_TIMEOUT",
          "The next Turn reached the server generation timeout.",
          { retryable: false },
          "Start a new Discussion and try again later.",
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });

    renderHydrated();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("alert").textContent).toContain(
      "The next Turn reached the server generation timeout. Start a new Discussion and try again later.",
    );
    expect(screen.queryByText("Discussion timed out.")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Discussion failed.",
    );
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
  });

  it("ignores a stale timeout refresh after a fresh Discussion starts", async () => {
    const timedOutDiscussion = {
      ...initialDiscussion,
      status: "failed",
      terminalReason: "timeout",
    };
    let resolveTimeoutRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockResolvedValueOnce(
        errorResponse(
          504,
          "GENERATION_TIMEOUT",
          "The next Turn reached the server generation timeout.",
          { retryable: false },
          "Start a new Discussion and try again later.",
        ),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveTimeoutRefresh = resolve;
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const refreshSignal = fetchMock.mock.calls[2]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(refreshSignal?.aborted).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(refreshSignal?.aborted).toBe(true);

    resolveTimeoutRefresh?.(jsonResponse(timedOutDiscussion));
    await waitFor(() =>
      expect(screen.queryByText("Discussion timed out.")).toBeNull(),
    );
    expect(screen.getByRole("alert").textContent).toBe("");
  });

  it("offers a fresh-Discussion action after completion that resets Topic, Transcript, progress, and errors", async () => {
    const firstInitial = { ...initialDiscussion, turnLimit: 1 };
    const firstCompleted = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstInitial))
      .mockResolvedValueOnce(jsonResponse(firstCompleted));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "1 / 1",
    );

    await user.click(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(
      window.sessionStorage.getItem(FOCUS_TOPIC_ON_CREATE_KEY),
    ).toBe("1");
    expect(window.sessionStorage.getItem(PENDING_START_KEY)).toBeNull();
    expect(screen.queryByText(messageContent)).toBeNull();
    expect(screen.queryByText("Discussion completed.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(
      screen.queryByRole("button", { name: "Start a New Discussion" }),
    ).toBeNull();
  });

  it("offers a fresh-Discussion action after Stop that resets Topic, Transcript, progress, and errors", async () => {
    const stoppedDiscussion = {
      ...initialDiscussion,
      status: "stopped",
      terminalReason: "stop",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(jsonResponse(stoppedDiscussion));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Stop Discussion" }));
    expect(await screen.findByText("Discussion stopped.")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    );

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(
      window.sessionStorage.getItem(FOCUS_TOPIC_ON_CREATE_KEY),
    ).toBe("1");
    expect(screen.queryByText("Discussion stopped.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(screen.queryByRole("button", { name: "Stop Discussion" })).toBeNull();
  });
});

describe("hydrated Discussion page addressability", () => {
  it("shows the unavailable card for a 404 with no further requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    expect(
      await screen.findByRole("heading", { name: "Discussion unavailable" }),
    ).toBeTruthy();
    expect(screen.getByText(/the URL alone does not grant access/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start a New Discussion" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable card for a 403 from a different session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    expect(
      await screen.findByRole("heading", { name: "Discussion unavailable" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch for an invalid Discussion identifier", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated("not-a-uuid");
    expect(
      await screen.findByRole("heading", { name: "Discussion unavailable" }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers Retry Loading and Start a New Discussion after a transient hydration failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    renderHydrated();
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Could not load this Discussion" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/Check your connection and try again/).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Retry Loading" }));

    expect(
      await screen.findByRole("heading", { name: topic, level: 2 }),
    ).toBeTruthy();
    // Hydration GET, retry GET, and the Turn POST that the idle state starts.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("shows the transient failure card for a malformed 200 hydration response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    expect(
      await screen.findByRole("heading", { name: "Could not load this Discussion" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Loading" })).toBeTruthy();
  });

  it("polls a generating Discussion and never re-claims the Turn with a POST", async () => {
    vi.useFakeTimers();
    const generating = {
      ...initialDiscussion,
      status: "generating",
    };
    const completed = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(generating))
      .mockResolvedValueOnce(jsonResponse(completed));
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: topic, level: 2 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Generating the next Turn",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Discussion completed.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("keeps observing a generating Discussion past a client-invented short deadline and only stops at the authoritative server bound", async () => {
    // Regression guard for the hydration polling horizon: the browser must
    // never stop observing an attempt the server can still legitimately
    // consider active. The server hard bound is `HARD_GENERATION_TIMEOUT_MS`
    // (300 s) plus the `RECOVERY_LEASE_GRACE_MS` margin (60 s), so a poll
    // cap of 60 × 2 s (120 s) would be an earlier, invented deadline.
    vi.useFakeTimers();
    const generating = {
      ...initialDiscussion,
      status: "generating",
    };
    // Every poll must get a fresh Response; a shared instance would have a
    // consumed body by the second read.
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse(generating),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHydrated();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Well past the old 120 s cap the page must still be polling (one GET
    // per 2 s interval, no re-claiming POSTs).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(66);
    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);

    // The derived horizon (300 s + 60 s = 360 s at a 2 s interval = 180
    // polls after the initial read) is reached only after the server's own
    // hard bound; only then does the page hand control back to a reload.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(232_000);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "This Discussion is still generating. Reload this page to see the latest Turns.",
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(181);
    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("reconciles a matched pending Start identity when the hydrated Topic matches", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue(requestId) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(initialDiscussion))
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    seedPendingStart();

    renderHydrated();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(storedPendingStart()).toBeNull();
  });
});
