import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  discussionTopicInput,
  expectNoHorizontalOverflow,
  expectTouchTarget,
  expectVisibleFocus,
  lifecycleStatus,
  newDiscussionButton,
  setScenario,
  startButton,
  startDiscussion,
  stopButton,
  transcriptList,
  transcriptLog,
  transcriptMessages,
} from "./helpers";

/**
 * Keyboard operation, focus visibility, targeted status announcements,
 * semantic Transcript structure, Jump to Latest, mobile viewports, text
 * zoom/reflow, long-content rendering, and both system themes — proven in a
 * real layout engine against deterministic generation. Tests run serially
 * and each scripts its own scenario first.
 */
test.describe.configure({ mode: "serial" });

const topic = "Should cities create more public parks?";

/** Tabs until the target receives focus (robust to focus loss on re-render). */
async function tabTo(page: Page, target: Locator, maxTabs = 8): Promise<void> {
  for (let tab = 0; tab < maxTabs; tab += 1) {
    const focused = await target.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("operates the full journey by keyboard with a visible focus indicator", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 4_000, ignoreAbort: true }],
    fallback: { outcome: "success" },
  });
  await page.goto("/");

  // The first Tab reaches the Topic control with a visible focus outline.
  await page.keyboard.press("Tab");
  await expect(discussionTopicInput(page)).toBeFocused();
  await expectVisibleFocus(page);

  // The Topic is typed and Start is activated by keyboard.
  await page.keyboard.type(topic);
  await tabTo(page, startButton(page));
  await expectVisibleFocus(page);
  await page.keyboard.press("Enter");
  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");

  // Stop is reached by Tab and activated with Space while generating.
  await tabTo(page, stopButton(page));
  await expectVisibleFocus(page);
  await page.keyboard.press("Space");
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");

  // A fresh Discussion is started by keyboard; focus returns to the Topic.
  await tabTo(page, newDiscussionButton(page));
  await expectVisibleFocus(page);
  await page.keyboard.press("Enter");
  await expect(discussionTopicInput(page)).toBeFocused();
  await expectVisibleFocus(page);
});

test("announces lifecycle status and new Turns to assistive technology", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 1_500 }],
    fallback: { outcome: "success" },
  });
  await startDiscussion(page, topic);

  // Targeted lifecycle announcements through the polite status region.
  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // Each new Turn is announced once by Speaker and Turn without replaying
  // the Transcript.
  await expect(transcriptLog(page)).toContainText(
    "New Turn 1 from the Supporter.",
  );
  await expect(transcriptLog(page)).toContainText(
    "New Turn 2 from the Opponent.",
  );
  await expect(transcriptLog(page)).toContainText(
    "New Turn 3 from the Supporter.",
  );
  await expect(transcriptLog(page)).toContainText(
    "New Turn 4 from the Opponent.",
  );
  const logText = (await transcriptLog(page).textContent()) ?? "";
  expect(logText.match(/New Turn 1/g) ?? []).toHaveLength(1);
});

test("renders the Transcript as a semantic ordered conversation log", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 1_500 }],
    fallback: { outcome: "success" },
  });
  await startDiscussion(page, topic);

  // The empty Transcript is stated while the first Turn is still in flight.
  await expect(
    page.getByText("No Turns yet. The Transcript is empty."),
  ).toBeVisible();
  await expect(transcriptList(page)).toHaveCount(0);

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // The Transcript is a labelled ordered log inside its own section.
  const transcriptSection = page.getByRole("region", {
    name: "Transcript",
  });
  await expect(transcriptSection).toBeVisible();
  await expect(transcriptList(page)).toBeVisible();
  await expect(transcriptMessages(page)).toHaveCount(4);

  // Each Message is an ordered entry with a Speaker-and-Turn heading and
  // its content.
  const firstMessage = transcriptMessages(page).first();
  await expect(firstMessage.locator("h3")).toHaveText("Supporter, Turn 1");
  await expect(firstMessage.locator("p")).toContainText(
    `Deterministic Supporter reply for Turn 1 on "${topic}".`,
  );
  const secondMessage = transcriptMessages(page).nth(1);
  await expect(secondMessage.locator("h3")).toHaveText("Opponent, Turn 2");
});

test("jumps to the latest Message from an earlier reading position", async ({
  page,
  request,
}) => {
  const longParagraph = (label: string) =>
    `${label}: ${"lorem ipsum dolor sit amet consectetur ".repeat(45)}`;
  const longContent = `${longParagraph("First paragraph")}\n\n${longParagraph("Second paragraph")}`;
  await setScenario(request, {
    turns: [1, 2, 3, 4].map(() => ({
      outcome: "success",
      content: longContent,
    })),
    fallback: { outcome: "success" },
  });
  await startDiscussion(page, topic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // Long content makes the Transcript scrollable; model output keeps its
  // paragraph breaks.
  const firstParagraph = transcriptMessages(page).first().locator("p");
  await expect(firstParagraph).toContainText("First paragraph");
  await expect(firstParagraph).toContainText("Second paragraph");

  const scroller = transcriptList(page).locator("xpath=..");
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    )
    .toBeGreaterThan(0);

  // Reading an earlier Turn exposes Jump to Latest with a touch target.
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  const jump = page.getByRole("button", { name: "Jump to Latest" });
  await expect(jump).toBeVisible();
  await expectTouchTarget(jump);

  // Jumping returns to the newest Message and moves focus there. The
  // product treats positions within 128px of the newest Message as "near
  // the latest", so the landing position must satisfy that threshold.
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(128);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("LI");
});

for (const width of [320, 375, 768]) {
  test.describe(`viewport ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("renders the complete journey without horizontal scrolling", async ({
      page,
      request,
    }) => {
      await setScenario(request, {
        turns: [{ outcome: "success", delayMs: 1_500 }],
        fallback: { outcome: "success" },
      });
      await page.goto("/");
      await expectNoHorizontalOverflow(page);

      await startDiscussion(page, topic);
      await expectNoHorizontalOverflow(page);
      await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
      await expectNoHorizontalOverflow(page);
      await expect(transcriptMessages(page)).toHaveCount(4);
    });
  });
}

test("reflows without horizontal scrolling at 200% text zoom", async ({
  page,
  request,
}) => {
  // A near-limit Topic and long unbroken model words stress the reflow
  // surface at enlarged text.
  const nearLimitTopic =
    "Should cities spend more on public parks and libraries even when transit, housing, schools, and healthcare budgets are tight and residents disagree about priorities, costs, fairness, and long-term benefits? ".repeat(2)
      .slice(0, 240);
  const unbrokenWords = `Here is one very long word: ${"xylophone".repeat(60)}. And another: ${"antidisestablishmentarianism".repeat(40)}.`;
  await setScenario(request, {
    turns: [
      { outcome: "success", content: `First paragraph of a long reply.\n\n${unbrokenWords}` },
    ],
    fallback: { outcome: "success" },
  });

  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectNoHorizontalOverflow(page);

  await startDiscussion(page, nearLimitTopic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expectNoHorizontalOverflow(page);

  // The near-limit Topic wraps inside its heading instead of overflowing.
  await expect(
    page.getByRole("heading", { name: nearLimitTopic, exact: true }),
  ).toBeVisible();
  // The long model output wraps inside its Message container.
  await expect
    .poll(() =>
      transcriptMessages(page)
        .first()
        .locator("p")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`renders visible text and a visible focus indicator in the ${colorScheme} theme`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme });
    await setScenario(request, { turns: [], fallback: { outcome: "success" } });
    await page.goto("/");

    // The theme tokens actually drive the rendered page.
    const background = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(background).toBe(
      colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(10, 10, 10)",
    );

    // The focus indicator uses the theme's focus token.
    await page.keyboard.press("Tab");
    await expect(discussionTopicInput(page)).toBeFocused();
    await expectVisibleFocus(page);
    const outlineColor = await page.evaluate(
      () => getComputedStyle(document.activeElement!).outlineColor,
    );
    expect(outlineColor).toBe(
      colorScheme === "light" ? "rgb(29, 78, 216)" : "rgb(147, 197, 253)",
    );

    // The empty state and a completed journey remain visible in this theme.
    await expect(lifecycleStatus(page)).toHaveText(
      "No active Discussion. Enter a Topic and choose Start Discussion.",
    );
    await startDiscussion(page, topic);
    await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
    await expect(startButton(page)).toBeVisible();
  });
}

test.describe("touch viewport", () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

  test("keeps Start, Stop, and the new-Discussion action tappable", async ({
    page,
    request,
  }) => {
    await setScenario(request, {
      turns: [{ outcome: "success", delayMs: 3_000, ignoreAbort: true }],
      fallback: { outcome: "success" },
    });
    await page.goto("/");
    await expectTouchTarget(startButton(page));
    await startDiscussion(page, topic);
    await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");
    await expectTouchTarget(stopButton(page));

    await stopButton(page).tap();
    await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");
    await expectNoHorizontalOverflow(page);

    await expectTouchTarget(newDiscussionButton(page));
    await newDiscussionButton(page).tap();
    await expect(discussionTopicInput(page)).toBeFocused();
  });
});
