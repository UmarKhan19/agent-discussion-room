import { expect, test } from "@playwright/test";
import {
  lifecycleStatus,
  setScenario,
  startDiscussion,
  transcriptMessages,
} from "./helpers";

/**
 * The server-owned completion synthesis: a neutral, bounded summary that
 * appears after every naturally completed Discussion, rendered OUTSIDE the
 * Transcript and never counted as a Turn. Deterministic content and
 * failures come from the scripted adapter so assertions never depend on
 * provider text.
 */
test.describe.configure({ mode: "serial" });

test("shows the committed synthesis outside the Transcript on completion", async ({
  page,
  request,
}) => {
  await setScenario(request, { turns: [], fallback: { outcome: "success" } });
  const topic = "Should cities create more public parks?";
  const id = await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expect(
    page.getByRole("heading", { name: "Discussion synthesis" }),
  ).toBeVisible();

  // Deterministic synthesis fields, never provider text.
  await expect(
    page.getByText(`Deterministic strongest case for "${topic}".`),
  ).toBeVisible();
  await expect(
    page.getByText(`Deterministic strongest case against "${topic}".`),
  ).toBeVisible();
  await expect(
    page.getByText("Deterministic takeaway after 4 turns."),
  ).toBeVisible();

  // The synthesis is NOT a Turn: the Transcript keeps exactly four
  // Messages and none of them carries synthesis text.
  await expect(transcriptMessages(page)).toHaveCount(4);
  await expect(
    page.locator('ol[aria-label="Discussion Transcript"] li', {
      hasText: "Deterministic strongest case",
    }),
  ).toHaveCount(0);
  // The section lives outside the ordered Transcript list.
  const synthesisHeading = page.getByRole("heading", {
    name: "Discussion synthesis",
  });
  await expect(synthesisHeading).toBeVisible();
  const inTranscript = await synthesisHeading.evaluate((element) =>
    element.closest('ol[aria-label="Discussion Transcript"]'),
  );
  expect(inTranscript).toBeNull();

  // The persisted state carries the committed synthesis and no extra Turn.
  const state = await (
    await page.request.get(`/api/discussions/${id}`)
  ).json();
  expect(state).toMatchObject({
    status: "completed",
    turnCount: 4,
    synthesis: { status: "completed" },
  });
  expect(state.transcript).toHaveLength(4);
});

test("recovers a transiently failed synthesis with Retry and never regenerates a Turn", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [],
    fallback: { outcome: "success" },
    synthesis: {
      syntheses: [{ outcome: "transient-failure" }],
      // Generations beyond the scripted list (the retry) succeed.
      synthesisFallback: { outcome: "success" },
    },
  });
  const topic = "Should every city build more bike lanes?";
  await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  // The failed synthesis card offers the retry; the debate stays visible.
  await expect(
    page.getByRole("heading", { name: "Synthesis unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Synthesis" }),
  ).toBeVisible();
  await expect(transcriptMessages(page)).toHaveCount(4);

  await page.getByRole("button", { name: "Retry Synthesis" }).click();
  await expect(
    page.getByRole("heading", { name: "Discussion synthesis" }),
  ).toBeVisible();
  await expect(
    page.getByText(`Deterministic strongest case for "${topic}".`),
  ).toBeVisible();
  // The retry resumed only the synthesis: the Turn count is untouched.
  await expect(transcriptMessages(page)).toHaveCount(4);
  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
});

test("retries a failed synthesis from a fresh tab using only the canonical URL and the ownership cookie", async ({
  page,
  context,
  request,
}) => {
  await setScenario(request, {
    turns: [],
    fallback: { outcome: "success" },
    synthesis: {
      syntheses: [{ outcome: "transient-failure" }],
      // Generations beyond the scripted list (the retry) succeed.
      synthesisFallback: { outcome: "success" },
    },
  });
  const topic = "Should every city build more bike lanes?";
  const id = await startDiscussion(page, topic);

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expect(
    page.getByRole("heading", { name: "Synthesis unavailable" }),
  ).toBeVisible();
  await expect(transcriptMessages(page)).toHaveCount(4);

  // A fresh tab shares the signed ownership cookie but has NO page-local
  // state: no sessionStorage, no retained final-Turn request identity.
  const freshTab = await context.newPage();
  await freshTab.goto(`/discussions/${id}`);

  // Hydration from durable state alone surfaces the retryable synthesis.
  await expect(freshTab.getByRole("heading", { name: "Synthesis unavailable" })).toBeVisible();
  await expect(
    freshTab.getByRole("button", { name: "Retry Synthesis" }),
  ).toBeVisible();
  await expect(transcriptMessages(freshTab)).toHaveCount(4);

  // The retry resumes ONLY the synthesis through the server-owned seam.
  await freshTab.getByRole("button", { name: "Retry Synthesis" }).click();
  await expect(
    freshTab.getByRole("heading", { name: "Discussion synthesis" }),
  ).toBeVisible();
  await expect(
    freshTab.getByText(`Deterministic strongest case for "${topic}".`),
  ).toBeVisible();
  await expect(transcriptMessages(freshTab)).toHaveCount(4);
  await expect(lifecycleStatus(freshTab)).toHaveText("Discussion completed.");
  await freshTab.close();
});

test("keeps the completed discussion visible when the synthesis is blocked, with no retry", async ({
  page,
  request,
}) => {
  await setScenario(request, {
    turns: [],
    fallback: { outcome: "success" },
    synthesis: { syntheses: [{ outcome: "policy-violation" }] },
  });
  await startDiscussion(page, "Should cities build more public parks?");

  await expect(lifecycleStatus(page)).toHaveText("Discussion completed.");
  await expect(
    page.getByRole("heading", { name: "Synthesis unavailable" }),
  ).toBeVisible();
  await expect(page.getByText(/blocked by the output policy/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry Synthesis" }),
  ).toHaveCount(0);
  // The four committed Messages remain readable under the failed synthesis.
  await expect(transcriptMessages(page)).toHaveCount(4);
});
