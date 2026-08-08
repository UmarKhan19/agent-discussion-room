# Deterministic browser suite

The browser suite proves the participant's critical Discussion journeys and
the key accessibility behaviors **against deterministic model outcomes**
instead of live provider availability. It runs the real application — real
HTTP routes, real signed sessions, real policy and budgets, real layout
engine — with a scripted, credential-free generation adapter.

## How to run

```bash
bun run test:browser          # run the whole suite
bun run test:browser:install  # one-time: download the Chromium browser
bun run test:browser -- --grep "stops an in-flight"   # one test
```

The suite (`e2e/*.spec.ts`, config `playwright.config.ts`) boots its own
`next dev` server on port 3100. It needs **no provider credentials** and
makes **no network model calls**.

## How determinism works

`DISCUSSION_GENERATION_MODE=deterministic` (development/test only; the
environment contract rejects it in production) selects a scripted generation
adapter (`src/discussion/scripted-discussion.ts`) in the server composition
instead of the Mastra debate agents — the Mastra composition is not even
imported, so no agent, storage, or observability code that could touch a
provider runs.

Each test scripts the adapter's behavior through the test-harness endpoint
before exercising the UI:

| Scripted outcome | What it proves in the browser |
| --- | --- |
| `success` (+ optional `content`, `delayMs`) | deterministic Turns, delays for in-flight assertions |
| `transient-failure` | the Retry flow commits exactly one Message |
| `policy-violation` | server-owned output policy blocks before commit |
| `ignoreAbort` | a provider that ignores its signal cannot produce a late Message after Stop |

`POST /api/test-harness/scenario` (and `GET` to read it) is guarded: it 404s
in every configuration except the deterministic mode, which production
cannot enable. The scenario is process state, so tests set their own
scenario first and run **serially on one worker** — a shared server cannot
serve two different scripts concurrently.

## What the suite covers

- **Journeys** (`e2e/discussion-journeys.spec.ts`): permitted Topic entry,
  explicit Start, Active Topic display, attributed alternating Turns,
  progress, finite completion; Stop during an in-flight generation with no
  late Message; retry of a transient failure with exactly one committed
  Message; fresh Discussions after both completion and Stop with no Topic,
  Transcript, state, or request-identity leakage; session isolation (a
  second browser context cannot read, advance, or stop another session's
  Discussion).
- **Addressability** (`e2e/addressability.spec.ts`): reload of a completed
  Discussion restores the exact persisted state with no duplicated Turns
  and no re-claiming; reload of a stopped Discussion renders as-is with
  zero Messages; direct navigation to the canonical URL (`/discussions/:id`)
  hydrates from the server; a second anonymous session opening the same URL
  sees the “Discussion unavailable” card (the URL is an address, never a
  credential); a Start whose commit succeeded but whose response was lost
  (server committed, response dropped) is recovered on reload with the same
  creation identity and navigates to the original Discussion identifier;
  reload during generation aborts the client fetch, the server
  persists a `stopped`/`disconnect` state, and the reloaded page hydrates
  zero Messages.
- **Accessibility** (`e2e/accessibility.spec.ts`): full keyboard operation
  with a visible focus indicator in both themes, targeted status and
  announcement regions, semantic ordered Transcript structure, Jump to
  Latest, 320/375/768px viewports without horizontal scrolling, 200% text
  zoom reflow (near-limit Topic and long unbroken model words), long-content
  wrapping with preserved paragraph breaks, touch targets, and light/dark
  theme rendering.

## Determinism and hygiene guarantees

- One worker, serial tests: the scripted scenario is process-wide.
- `DISCUSSION_STORE_URL` is forced empty, so the suite uses the explicit
  in-memory store and leaves **no durable data behind**.
- The suite sets `DISCUSSION_TURN_LIMIT=4` and caps scripted delays at a few
  seconds, keeping every test bounded.
- Every test scripts its own scenario first, so a failed test cannot leak
  its script into the next test.
- The suite is **credential-free by construction**: the provider key is
  never set, read, or required.

## Notes for maintainers

- The suite runs against `next dev` (development mode) so the deterministic
  mode is legal; production builds never include it.
- Do not raise `workers` in `playwright.config.ts` without keying scenarios
  per session or discussion — the script is process-global.
- The test-harness route lives in `src/app/api/test-harness/scenario/` and
  is covered by unit tests that assert it 404s outside the deterministic
  mode.
