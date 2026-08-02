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

  it("advances one authorized request at a time with visible progress to completion", async () => {
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify(boundedInitial), { status: 201 }),
      )
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
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveFirstTurn?.(new Response(JSON.stringify(firstTurn), { status: 200 }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Turn progress").textContent).toContain("1 / 2");
    expect(screen.getByRole("status").textContent).toContain(
      "Generating Opponent Turn",
    );
    expect(screen.getByText(messageContent)).toBeTruthy();

    resolveSecondTurn?.(new Response(JSON.stringify(completed), { status: 200 }));

    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(screen.getByLabelText("Turn progress").textContent).toContain("2 / 2");
    expect(screen.queryByText(/Generating .* Turn/)).toBeNull();
    expect(fetchMock.mock.calls.slice(1).map((call) =>
      NextTurnRequestSchema.parse(JSON.parse(String(call[1]?.body))).requestId,
    )).toEqual([firstRequestId, secondRequestId]);
  });

  it("starts a fresh Discussion without reusing prior lifecycle state", async () => {
    const secondTopic = "Should libraries stay open later?";
    const secondDiscussionId = "66666666-6666-4666-8666-666666666666";
    const requestIds = [
      requestId,
      "77777777-7777-4777-8777-777777777777",
    ];
    const firstInitial = { ...initialDiscussion, turnLimit: 1 };
    const firstCompleted = {
      ...discussionWithFirstTurn,
      status: "completed",
      turnLimit: 1,
    };
    const secondInitial = {
      ...initialDiscussion,
      id: secondDiscussionId,
      topic: secondTopic,
      turnLimit: 1,
    };
    const secondContent = "Later hours improve access for working residents.";
    const secondCompleted = {
      ...secondInitial,
      status: "completed",
      turnCount: 1,
      transcript: [
        {
          ...discussionWithFirstTurn.transcript[0],
          id: "88888888-8888-4888-8888-888888888888",
          content: secondContent,
          generation: {
            ...discussionWithFirstTurn.transcript[0].generation,
            requestId: requestIds[1],
          },
        },
      ],
    };
    let resolveSecondTurn: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstInitial), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(firstCompleted), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondInitial), { status: 201 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => {
        resolveSecondTurn = resolve;
      }));
    let requestIndex = 0;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", {
      randomUUID: () => requestIds[requestIndex++],
    });
    const user = userEvent.setup();

    render(<Home />);
    const topicControl = screen.getByRole("textbox", { name: "Discussion Topic" });
    await user.type(topicControl, topic);
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));
    expect(await screen.findByText("Discussion completed.")).toBeTruthy();
    expect(screen.getByText(messageContent)).toBeTruthy();

    await user.clear(topicControl);
    await user.type(topicControl, secondTopic);
    await user.click(screen.getByRole("button", { name: "Start Discussion" }));

    expect(await screen.findByRole("heading", { name: secondTopic, level: 2 })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.getByLabelText("Turn progress").textContent).toContain("0 / 1");
    expect(screen.getByText("No Turns yet. The Transcript is empty.")).toBeTruthy();
    expect(screen.queryByText(messageContent)).toBeNull();
    expect(screen.queryByText("Discussion completed.")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Generating Supporter Turn");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/discussions",
      `/api/discussions/${initialDiscussion.id}`,
      "/api/discussions",
      `/api/discussions/${secondDiscussionId}`,
    ]);
    expect(fetchMock.mock.calls.filter((call) => call[0] !== "/api/discussions").map((call) =>
      NextTurnRequestSchema.parse(JSON.parse(String(call[1]?.body))).requestId,
    )).toEqual(requestIds);

    resolveSecondTurn?.(new Response(JSON.stringify(secondCompleted), { status: 200 }));
    expect(await screen.findByText(secondContent)).toBeTruthy();
    expect(screen.getByText("Discussion completed.")).toBeTruthy();
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
