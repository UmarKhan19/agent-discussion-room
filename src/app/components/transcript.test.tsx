// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscussionMessage, Speaker } from "@/discussion/contracts";
import { Transcript } from "./transcript";

function message(
  turn: number,
  speaker: Speaker,
  content: string,
): DiscussionMessage {
  return {
    id: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
    content,
    speaker,
    createdAt: "2026-08-02T12:00:00.000Z",
    turn,
    generation: {
      requestId: "22222222-2222-4222-8222-222222222222",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      outputPolicyOutcome: {
        decision: "allowed",
        category: null,
        checkedAt: "2026-08-02T12:00:00.000Z",
      },
    },
  };
}

const supporterOne = message(
  1,
  "supporter",
  "Public parks give more residents access to shared green space.",
);
const opponentTwo = message(
  2,
  "opponent",
  "Dense development can leave more land available for parks.",
);
const supporterThree = message(
  3,
  "supporter",
  "Parks also improve air quality and public health.",
);

afterEach(() => {
  cleanup();
});

/**
 * Gives the Transcript's scroll container deterministic layout metrics, since
 * jsdom performs no layout.
 */
function stubScrollMetrics(
  scrollEl: HTMLElement,
  {
    scrollHeight = 1000,
    clientHeight = 400,
    scrollTop = 0,
  }: {
    scrollHeight?: number;
    clientHeight?: number;
    scrollTop?: number;
  } = {},
) {
  Object.defineProperty(scrollEl, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(scrollEl, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  scrollEl.scrollTop = scrollTop;
}

describe("Transcript structure and labeling", () => {
  it("renders the Transcript as an ordered conversation log with a stable Speaker label on each Message", () => {
    render(
      <Transcript messages={[supporterOne, opponentTwo]} />,
    );
    expect(
      screen.getByRole("heading", { name: "Transcript", level: 2 }),
    ).toBeTruthy();

    const list = screen.getByRole("list", {
      name: "Discussion Transcript",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(
      within(items[0]).getByRole("heading", { name: "Supporter, Turn 1" }),
    ).toBeTruthy();
    expect(
      within(items[0]).getByText(supporterOne.content),
    ).toBeTruthy();
    expect(
      within(items[1]).getByRole("heading", { name: "Opponent, Turn 2" }),
    ).toBeTruthy();
    expect(within(items[1]).getByText(opponentTwo.content)).toBeTruthy();
  });

  it("distinguishes Supporter and Opponent through explicit text, not only color or position", () => {
    render(
      <Transcript messages={[supporterOne, opponentTwo]} />,
    );
    expect(screen.getAllByText(/^Supporter/)).toHaveLength(1);
    expect(screen.getAllByText(/^Opponent/)).toHaveLength(1);
  });

  it("shows a stable empty state with no list when there are no Turns", () => {
    render(<Transcript messages={[]} />);
    expect(
      screen.getByText("No Turns yet. The Transcript is empty."),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("preserves paragraph breaks and wraps long words and links in the Message container", () => {
    const content =
      "First paragraph.\n\nSecond paragraph with a verylongwordthatwouldotherwiseoverflowthecontainerandpushcontentoutsidethebox and a https://example.com/very/long/url/that/should/wrap/too";
    render(<Transcript messages={[message(1, "supporter", content)]} />);

    const paragraph = screen
      .getByRole("listitem")
      .querySelector("p");
    expect(paragraph?.textContent).toContain("\n\n");
    expect(paragraph?.className).toContain("whitespace-pre-wrap");
    expect(paragraph?.className).toContain("wrap-anywhere");
  });
});

describe("Transcript announcements", () => {
  it("announces each Message that arrives while displayed, without re-announcing earlier Turns", () => {
    const { rerender } = render(<Transcript messages={[supporterOne]} />);
    const log = screen.getByRole("log", {
      name: "Transcript announcements",
    });
    expect(log.textContent).toBe("");

    rerender(<Transcript messages={[supporterOne, opponentTwo]} />);
    expect(log.textContent).toContain("New Turn 2 from the Opponent.");
    expect(log.textContent).not.toContain("New Turn 1");
    expect(log.textContent).not.toContain(supporterOne.content);

    rerender(
      <Transcript messages={[supporterOne, opponentTwo, supporterThree]} />,
    );
    expect(log.textContent).toContain("New Turn 3 from the Supporter.");
    expect(log.textContent).not.toContain(supporterOne.content);
    expect(log.textContent).not.toContain(opponentTwo.content);
  });

  it("does not announce Messages already present when the Transcript appears", () => {
    const { rerender } = render(
      <Transcript messages={[supporterOne, opponentTwo]} />,
    );
    expect(screen.getByRole("log").textContent).toBe("");

    rerender(
      <Transcript messages={[supporterOne, opponentTwo, supporterThree]} />,
    );
    const log = screen.getByRole("log");
    expect(log.textContent).toContain("New Turn 3 from the Supporter.");
    expect(log.textContent).not.toContain("New Turn 1");
    expect(log.textContent).not.toContain("New Turn 2");
  });

  it("keeps only a bounded tail of announcements so old content is never re-read", () => {
    const { rerender } = render(<Transcript messages={[supporterOne]} />);
    const many = [
      message(2, "opponent", "Two."),
      message(3, "supporter", "Three."),
      message(4, "opponent", "Four."),
      message(5, "supporter", "Five."),
      message(6, "opponent", "Six."),
      message(7, "supporter", "Seven."),
      message(8, "opponent", "Eight."),
    ];
    rerender(<Transcript messages={[supporterOne, ...many]} />);

    const log = screen.getByRole("log");
    expect(log.textContent).not.toContain("New Turn 2");
    expect(log.textContent).not.toContain("New Turn 3");
    expect(log.textContent).toContain("New Turn 4");
    expect(log.textContent).toContain("New Turn 8");
  });
});

describe("Transcript scrolling and Jump to Latest", () => {
  it("does not auto-scroll away when the Transcript appears with existing Messages", () => {
    // Prototype-level metrics so a mount-time auto-scroll, if any, would move
    // the scroll position during render.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      value: 400,
    });
    try {
      render(<Transcript messages={[supporterOne, opponentTwo]} />);
      const scrollEl = screen.getByRole("list").parentElement!;
      expect(scrollEl.scrollTop).toBe(0);
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .clientHeight;
    }
  });

  it("auto-scrolls to the newest Message only when the participant is already near the bottom", () => {
    const { rerender } = render(<Transcript messages={[supporterOne]} />);
    const scrollEl = screen.getByRole("list").parentElement!;
    stubScrollMetrics(scrollEl, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 800,
    });

    rerender(<Transcript messages={[supporterOne, opponentTwo]} />);
    expect(scrollEl.scrollTop).toBe(1000);
  });

  it("preserves the reading position when reading older Turns and exposes Jump to Latest", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Transcript messages={[supporterOne]} />);
    const scrollEl = screen.getByRole("list").parentElement!;
    stubScrollMetrics(scrollEl, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 200,
    });
    fireEvent.scroll(scrollEl);

    const jump = screen.getByRole("button", { name: "Jump to Latest" });
    rerender(<Transcript messages={[supporterOne, opponentTwo]} />);
    expect(scrollEl.scrollTop).toBe(200);

    await user.click(jump);
    expect(scrollEl.scrollTop).toBe(1000);
    expect(
      screen.queryByRole("button", { name: "Jump to Latest" }),
    ).toBeNull();
    expect(document.activeElement).toBe(screen.getAllByRole("listitem")[1]);
  });

  it("hides Jump to Latest while near the newest Message and reaches it by keyboard when scrolled away", async () => {
    const user = userEvent.setup();
    render(<Transcript messages={[supporterOne, opponentTwo]} />);
    const scrollEl = screen.getByRole("list").parentElement!;
    stubScrollMetrics(scrollEl, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 900,
    });
    fireEvent.scroll(scrollEl);
    expect(
      screen.queryByRole("button", { name: "Jump to Latest" }),
    ).toBeNull();

    scrollEl.scrollTop = 100;
    fireEvent.scroll(scrollEl);
    const jump = screen.getByRole("button", { name: "Jump to Latest" });

    await user.tab();
    expect(document.activeElement).toBe(jump);
    await user.keyboard("{Enter}");
    expect(scrollEl.scrollTop).toBe(1000);
    expect(
      screen.queryByRole("button", { name: "Jump to Latest" }),
    ).toBeNull();
  });
});
