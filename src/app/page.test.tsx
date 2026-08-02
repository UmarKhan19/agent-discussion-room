// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NextTurnRequestSchema } from "@/discussion/contracts";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";

const topic = "Should cities create more public parks?";
const requestId = "22222222-2222-4222-8222-222222222222";
const messageContent =
  "Public parks give more residents access to shared green space.";
const initialDiscussion = {
  id: "11111111-1111-4111-8111-111111111111",
  topic,
  status: "idle",
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("participant-visible Discussion start", () => {
  it("waits for an explicit action, then shows Topic, empty state, and progress", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(initialDiscussion), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    const user = userEvent.setup();

    render(<Home />);

    const topicControl = screen.getByRole("textbox", {
      name: "Discussion Topic",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/No active Discussion/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Start Discussion" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a Discussion Topic",
    );

    await user.type(topicControl, topic);
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      topic,
    });
    expect(
      await screen.findByRole("heading", { name: topic, level: 2 }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "0 / 12",
    );
    expect(screen.getByText("No Turns yet. The Transcript is empty.")).toBeTruthy();
  });

  it("shows generation progress, then an explicitly labelled Supporter Turn", async () => {
    let resolveTurn: ((response: Response) => void) | undefined;
    const turnResponse = new Promise<Response>((resolve) => {
      resolveTurn = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(initialDiscussion), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(turnResponse);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    const user = userEvent.setup();

    render(<Home />);
    await user.type(
      screen.getByRole("textbox", { name: "Discussion Topic" }),
      topic,
    );
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toContain(
      "Generating Supporter Turn",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/discussions/${initialDiscussion.id}`,
    );
    const nextTurnBody = NextTurnRequestSchema.parse(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    );
    expect(nextTurnBody).toEqual({ requestId });

    resolveTurn?.(
      new Response(JSON.stringify(discussionWithFirstTurn), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(await screen.findByText(messageContent)).toBeTruthy();
    expect(screen.getByText("Supporter")).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain(
      "1 / 12",
    );
    expect(screen.queryByText("Generating Supporter Turn…")).toBeNull();
  });

  it("rejects an excessively long Topic before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<Home />);

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
});
