// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./page";

const topic = "Should cities create more public parks?";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("participant-visible Discussion start", () => {
  it("waits for an explicit action, then shows Topic, empty state, and progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(initialDiscussion), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
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
