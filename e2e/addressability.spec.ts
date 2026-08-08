import { expect, test, type Page } from "@playwright/test";
import {
  discussionTopicInput,
  expectTranscriptHeadings,
  lifecycleStatus,
  newDiscussionButton,
  setScenario,
  startButton,
  startDiscussion,
  stopButton,
  transcriptMessages,
} from "./helpers";

/**
 * Addressability contract: every Discussion lives at a canonical URL
 * (`/discussions/:id`) that hydrates the authoritative persisted server
 * state. Reloads and direct navigation must restore exactly the persisted
 * state — never duplicating Turns, never re-claiming an in-flight
 * generation, and never leaking one session's Discussion to another's URL.
 */

function trackDiscussionPosts(page: Page): () => readonly string[] {
  const urls: string[] = [];
  const listener = (request: { url: () => string; method: () => string }) => {
    if (request.method() !== "POST") return;
    if (!/\/api\/discussions\//u.test(request.url())) return;
    urls.push(request.url());
  };
  page.on("request", listener);
  return () => {
    page.off("request", listener);
    return [...urls];
  };
}

async function openDiscussionUrl(page: Page, id: string): Promise<void> {
  await page.goto(`/discussions/${id}`);
  await expect(page).toHaveURL(new RegExp(`/discussions/${id}$`));
}

test("reloads a completed Discussion without duplicating Turns or re-claiming", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";
  const id = await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  void id;

  const afterReloadPosts = trackDiscussionPosts(page);
  await page.reload();

  // Hydration restores the persisted completed state as-is.
  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Turn progress")).toHaveText("4 / 4 Turns");
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
  // A terminal Discussion must never be advanced again on reload.
  expect(afterReloadPosts()).toEqual([]);
});

test("reloads a stopped Discussion as-is with zero Messages", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 30_000, ignoreAbort: true }],
    fallback: { outcome: "success" },
  });
  const topic = "Should remote work replace the office?";
  const id = await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");
  await stopButton(page).click();
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");

  const afterReloadPosts = trackDiscussionPosts(page);
  await page.reload();

  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");
  await expect(transcriptMessages(page)).toHaveCount(0);
  await expect(newDiscussionButton(page)).toBeVisible();
  expect(afterReloadPosts()).toEqual([]);

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({
    status: "stopped",
    terminalReason: "stop",
    turnCount: 0,
    transcript: [],
  });
});

test("hydrates a Discussion opened directly by its canonical URL", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";
  const id = await startDiscussion(page, topic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // A direct visit to the canonical URL (fresh navigation, same anonymous
  // session) restores the persisted Discussion from the server.
  await openDiscussionUrl(page, id);
  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expectTranscriptHeadings(page, [
    "Supporter, Turn 1",
    "Opponent, Turn 2",
    "Supporter, Turn 3",
    "Opponent, Turn 4",
  ]);
});

test("a different anonymous session cannot open a Discussion by URL", async ({
  page,
  browser,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";
  const id = await startDiscussion(page, topic);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // A second, credential-free session has no ownership of the first
  // session's Discussion: the URL is an address, never a credential.
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  try {
    await openDiscussionUrl(strangerPage, id);
    await expect(
      strangerPage.getByRole("heading", { name: "Discussion unavailable" }),
    ).toBeVisible();
    await expect(
      strangerPage.getByText(/the URL alone does not grant access/),
    ).toBeVisible();
    await expect(newDiscussionButton(strangerPage)).toBeVisible();
    // No Discussion content leaks through.
    await expect(
      strangerPage.getByRole("heading", { name: topic, exact: true }),
    ).toHaveCount(0);
  } finally {
    await stranger.close();
  }
});

test("recovers a Start whose commit succeeded but whose response was lost, on reload, with the same identity", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";

  // The FIRST Start POST reaches the server (route.fetch commits the
  // Discussion) but its response is dropped (the handler never fulfills):
  // COMMIT SUCCEEDED, RESPONSE LOST. The second POST — the reload
  // recovery — is fulfilled normally.
  let committedId: string | null = null;
  let dropResponse = true;
  await page.route("**/api/discussions", async (route) => {
    const response = await route.fetch();
    if (dropResponse) {
      dropResponse = false;
      const body = (await response.json()) as { id: string };
      committedId = body.id;
      // Deliberately never fulfill: the browser sees a lost response while
      // the server has already durably committed the Discussion.
      return;
    }
    await route.fulfill({ response });
  });

  await page.goto("/");
  await discussionTopicInput(page).fill(topic);
  await startButton(page).click();
  // The server committed even though the browser never got the response.
  await expect.poll(() => committedId).not.toBeNull();

  // Full reload before resolution: the pending Start identity survives in
  // sessionStorage, and the create page auto-retries it on mount with the
  // SAME creationRequestId.
  await page.reload();

  // The recovered Discussion is the ORIGINAL committed one — the replay
  // returned the same identifier, so the canonical URL is the id the server
  // committed on the first POST. A duplicate Start would have navigated to
  // a different id.
  const recoveredId = committedId!;
  await expect(page).toHaveURL(new RegExp(`/discussions/${recoveredId}$`));
  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");

  // Exactly one Discussion exists under the original identifier.
  const state = await (
    await page.request.get(`/api/discussions/${recoveredId}`)
  ).json();
  expect(state).toMatchObject({ status: "completed", topic });
});

test("a reload during generation persists a disconnect stop and hydrates zero Messages", async ({
  page,
  request,
}) => {
  // A long generation that stays in flight until the reload aborts the
  // client fetch; the server's disconnect guard then persists a stop.
  await setScenario(request, {
    turns: [{ outcome: "success", delayMs: 30_000, ignoreAbort: true }],
    fallback: { outcome: "success" },
  });
  const topic = "Should public libraries stay open later?";
  const id = await startDiscussion(page, topic);
  await expect(lifecycleStatus(page)).toHaveText("Generating Supporter Turn…");

  // Reloading aborts the in-flight Turn request; the Runner observes the
  // disconnect and persists a stopped state with no committed Messages.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: topic, exact: true }),
  ).toBeVisible();
  await expect(lifecycleStatus(page)).toHaveText("Discussion stopped.");
  await expect(transcriptMessages(page)).toHaveCount(0);
  await expect(newDiscussionButton(page)).toBeVisible();

  const state = await (await page.request.get(`/api/discussions/${id}`)).json();
  expect(state).toMatchObject({
    status: "stopped",
    terminalReason: "disconnect",
    turnCount: 0,
    transcript: [],
  });
});
