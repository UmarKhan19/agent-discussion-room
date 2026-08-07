import { expect, test } from "@playwright/test";
import {
  alertRegion,
  collectTurnRequestIds,
  discussionTopicInput,
  expectTranscriptHeadings,
  lifecycleStatus,
  newDiscussionButton,
  retryButton,
  setScenario,
  startDiscussion,
  stopButton,
  transcriptMessages,
} from "./helpers";

/**
 * Critical participant journeys against the deterministic scripted
 * generation adapter: permitted Topic entry, explicit Start, attributed
 * alternating Turns, progress, finite completion, Stop with no late
 * Message, retry of a transient failure with exactly one committed
 * Message, fresh Discussions after completion and Stop, and session
 * isolation. Tests run serially and each scripts its own scenario first.
 */
test.describe.configure({ mode: "serial" });

test("starts a permitted Topic and completes a bounded Discussion with attributed alternating Turns", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";

  const id = await startDiscussion(page, topic);

  // Active Topic is displayed after the explicit Start.
  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  // Progress and finite completion against the server-configured limit.
  await expect(page.getByLabel("Turn progress")).toHaveText("4 / 4 Turns");
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  // Attributed, alternating Turns in server order.
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  // Deterministic model outcome, never provider text.
  await expect(
    page.getByText(`Deterministic Supporter reply for Turn 1 on "${topic}".`),
  ).toBeVisible();

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({ status: "completed", turnCount: 4 });
});

test("stops an in-flight generation and commits no late Message", async ({
  page,
  request,
}) => {
  // A delayed Turn whose generation keeps running after abort, like a
  // provider that ignores its signal: only the Runner's cancellation
  // guards may keep the late result out of the Transcript.
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 4_000, ignoreAbort: true }],
    fallback: { outcome: "success" },
  });
  const topic = "Should remote work replace the office?";
  const id = await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");
  await expect(transcriptMessages(page)).toHaveCount(0);

  await stopButton(page).click();
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");
  await expect(stopButton(page)).toHaveCount(0);
  await expect(newDiscussionButton(page)).toBeVisible();

  // Past the scripted delay the late generation must still commit nothing.
  await page.waitForTimeout(5_000);
  await expect(transcriptMessages(page)).toHaveCount(0);

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({
    status: "stopped",
    terminalReason: "stop",
    turnCount: 0,
    transcript: [],
  });
});

test("retries a transient failure and commits exactly one successful Message", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [
      { outcome: "transient-failure" },
      { outcome: "success" },
      { outcome: "success", delayMs: 3_000 },
      { outcome: "success" },
    ],
    fallback: { outcome: "success" },
  });
  const topic = "Should cities invest more in public transit?";
  const id = await startDiscussion(page, topic);

  // The transient failure surfaces retryable copy and the Retry action.
  await expect(alertRegion(page)).toContainText(
    "The next Turn could not be generated safely.",
  );
  await expect(alertRegion(page)).toContainText(
    "Retry this Turn with the same request identity.",
  );
  await expect(retryButton(page)).toBeVisible();
  await expect(transcriptMessages(page)).toHaveCount(0);

  // Retrying with the same request identity commits exactly one Turn 1.
  await retryButton(page).click();
  await expect(
    page.getByRole("heading", { name: "Supporter, Turn 1" }),
  ).toHaveCount(1);
  await expect(
    page.getByText(
      `Deterministic Supporter reply for Turn 1 on "${topic}".`,
    ),
  ).toHaveCount(1);

  // The Discussion then continues to its finite completion; the retried
  // Turn is never duplicated.
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  await expect(
    page.getByRole("heading", { name: "Supporter, Turn 1" }),
  ).toHaveCount(1);

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({ status: "completed", turnCount: 4 });
  expect(state.transcript).toHaveLength(4);
  expect(state.transcript.filter((message: { turn: number }) => message.turn === 1)).toHaveLength(1);
});

test("blocks a policy-violating generated Turn without committing it", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "policy-violation" }],
    fallback: { outcome: "success" },
  });
  const topic = "Should cities create more public parks?";
  const id = await startDiscussion(page, topic);

  // The server-owned output policy blocks the Turn and explains recovery.
  await expect(alertRegion(page)).toContainText(
    "The generated Turn did not pass the Discussion output policy.",
  );
  await expect(alertRegion(page)).toContainText(
    "the blocked Turn was not added to the Transcript",
  );
  await expect(lifecycleStatus(page)).toHaveText("Discussion failed.");
  // Nothing is committed; the failure is terminal, so only a fresh
  // Discussion is offered — no Retry for a policy violation.
  await expect(transcriptMessages(page)).toHaveCount(0);
  await expect(retryButton(page)).toHaveCount(0);
  await expect(newDiscussionButton(page)).toBeVisible();

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({
    status: "failed",
    turnCount: 0,
    transcript: [],
  });
});

test("starts a fresh Discussion after completion without leaking prior state or request identity", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const firstTopic = "Should cities create more public parks?";
  const stopCollecting = collectTurnRequestIds(page);
  const firstId = await startDiscussion(page, firstTopic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  const firstRequestIds = stopCollecting();
  const firstRunCount = firstRequestIds.length;

  await newDiscussionButton(page).click();

  // Prior Topic, Transcript, and state are cleared; the Topic control is
  // focused for the next entry.
  await expect(discussionTopicInput(page)).toHaveValue("");
  await expect(discussionTopicInput(page)).toBeFocused();
  await expect(
    page.getByRole("heading", { name: firstTopic, exact: true }),
  ).toHaveCount(0);
  await expect(lifecycleStatus(page)).toHaveText(
    "No active Discussion. Enter a Topic and choose Start Discussion.",
  );

  const secondTopic = "Should every city build more bike lanes?";
  const secondId = await startDiscussion(page, secondTopic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  // The collector keeps every Turn request; the second run's identities are
  // the entries after the first run's.
  const secondRequestIds = stopCollecting().slice(firstRunCount);

  // The fresh Discussion owns a new identifier, Topic, and Transcript.
  expect(secondId).not.toBe(firstId);
  await expect(
    page.getByRole("heading", { name: secondTopic, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: firstTopic, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(firstTopic)).toHaveCount(0);
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  // No request identity from the first Discussion is reused by the second.
  for (const requestId of firstRequestIds) {
    expect(secondRequestIds).not.toContain(requestId);
  }
});

test("starts a fresh Discussion after Stop without leaking prior state", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 4_000, ignoreAbort: true }],
    fallback: { outcome: "success" },
  });
  const firstTopic = "Should remote work replace the office?";
  const firstId = await startDiscussion(page, firstTopic);
  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");
  await stopButton(page).click();
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");

  await newDiscussionButton(page).click();
  await expect(discussionTopicInput(page)).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: firstTopic, exact: true }),
  ).toHaveCount(0);

  const secondTopic = "Should schools start later in the morning?";
  const secondId = await startDiscussion(page, secondTopic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // A new Discussion with a new identifier runs to completion; the stopped
  // Discussion's abandoned generation never contributes a Message.
  expect(secondId).not.toBe(firstId);
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  await expect(transcriptMessages(page)).toHaveCount(4);
  await expect(
    page.getByRole("heading", { name: firstTopic, exact: true }),
  ).toHaveCount(0);
});

test("a separate session cannot read, advance, or stop another session's Discussion", async ({
  page,
  request,
  browser,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const id = await startDiscussion(page, "Should cities create more public parks?");
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // A second browser context is a separate signed session: every
  // browser-visible flow against the first session's Discussion must 404.
  const otherContext = await browser.newContext();
  try {
    const other = otherContext.request;
    const read = await other.get(`/api/discussions/${id}`);
    expect(read.status()).toBe(404);

    const advance = await other.post(`/api/discussions/${id}`, {
      data: { requestId: crypto.randomUUID() },
    });
    expect(advance.status()).toBe(404);

    const stop = await other.post(`/api/discussions/${id}/stop`);
    expect(stop.status()).toBe(404);

    // The owning session still reads its Discussion.
    const owner = await page.request.get(`/api/discussions/${id}`);
    expect(owner.status()).toBe(200);
  } finally {
    await otherContext.close();
  }
});
