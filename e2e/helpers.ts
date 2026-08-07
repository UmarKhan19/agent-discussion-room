import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { ScriptedScenario } from "../src/discussion/scripted-discussion";

/**
 * Shared helpers for the deterministic browser suite. Tests script the
 * credential-free generation adapter through the test-harness endpoint and
 * then assert against the real UI and HTTP surface.
 */

export const SCENARIO_ENDPOINT = "/api/test-harness/scenario";

/**
 * Scripts the deterministic generation adapter for the next generations.
 * Every test sets its own scenario first, so tests are independent of each
 * other's leftover process state.
 */
export async function setScenario(
  request: APIRequestContext,
  scenario: ScriptedScenario,
): Promise<void> {
  const response = await request.post(SCENARIO_ENDPOINT, { data: scenario });
  expect(
    response.ok(),
    "the deterministic harness must be enabled on the test server",
  ).toBeTruthy();
}

export function discussionTopicInput(page: Page) {
  return page.getByLabel("Discussion Topic");
}

export function startButton(page: Page) {
  return page.getByRole("button", { name: "Start Discussion" });
}

export function stopButton(page: Page) {
  return page.getByRole("button", { name: "Stop Discussion" });
}

export function retryButton(page: Page) {
  return page.getByRole("button", { name: "Retry Turn" });
}

export function newDiscussionButton(page: Page) {
  return page.getByRole("button", { name: "Start a New Discussion" });
}

export function lifecycleStatus(page: Page) {
  return page.getByRole("status");
}

export function transcriptLog(page: Page) {
  return page.getByRole("log", { name: "Transcript announcements" });
}

export function transcriptList(page: Page) {
  return page.locator('ol[aria-label="Discussion Transcript"]');
}

export function transcriptMessages(page: Page) {
  return transcriptList(page).locator(":scope > li");
}

export function turnHeadings(page: Page) {
  return transcriptMessages(page).locator(":scope > h3");
}

export function alertRegion(page: Page) {
  // Scoped to main: Next.js injects its own route-announcer with role
  // "alert" outside the app content.
  return page.getByRole("main").getByRole("alert");
}

/**
 * Starts a Discussion through the real UI and returns the server-assigned
 * Discussion identifier captured from the start response.
 */
export async function startDiscussion(
  page: Page,
  topic: string,
): Promise<string> {
  // Navigate to the app unless the test already loaded it; re-loading an
  // in-progress journey would discard client state mid-test.
  if (new URL(page.url()).pathname !== "/") {
    await page.goto("/");
  }
  await discussionTopicInput(page).fill(topic);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/discussions",
    ),
    startButton(page).click(),
  ]);
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

/**
 * Registers a listener that records the request identity of every next-Turn
 * request the page sends, so tests can prove a fresh Discussion never
 * reuses a previous run's request identities.
 */
export function collectTurnRequestIds(page: Page): () => readonly string[] {
  const requestIds: string[] = [];
  const listener = (request: { url: () => string; method: () => string }) => {
    if (request.method() !== "POST") return;
    if (!/\/api\/discussions\/[0-9a-f-]{36}$/u.test(request.url())) return;
    const body = JSON.parse(
      (request as { postData?: () => string | null }).postData?.() ?? "{}",
    ) as { requestId?: string };
    if (body.requestId) requestIds.push(body.requestId);
  };
  page.on("request", listener);
  return () => {
    page.off("request", listener);
    return [...requestIds];
  };
}

/** Asserts the page never exceeds the viewport width (no horizontal scroll). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** Asserts the currently focused element shows the 2px focus outline. */
export async function expectVisibleFocus(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const element = document.activeElement;
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      }),
    )
    .toMatchObject({ outlineStyle: "solid", outlineWidth: "2px" });
}

/** Asserts an element renders at least 44px tall (touch-target contract). */
export async function expectTouchTarget(
  locator: ReturnType<Page["getByRole"]> | ReturnType<Page["locator"]>,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "control must be visible to measure").not.toBeNull();
  expect(box!.height, "control must meet the 44px touch target").toBeGreaterThanOrEqual(44);
}

export async function expectTranscriptHeadings(
  page: Page,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(() =>
      turnHeadings(page)
        .allTextContents()
        .then((texts) => texts.map((text) => text.trim())),
    )
    .toEqual([...expected]);
}
