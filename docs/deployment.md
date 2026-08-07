# Deployment and verification

How a release is gated, how the dependency audit works, how provider
integration is verified, and the conventions a maintainer must follow when
adding Mastra resources.

## Reproducible continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request, and mirrors the local contract exactly: the pinned **Bun 1.3.14**
(`oven-sh/setup-bun@v2`), a frozen lockfile install, `bun run verify`
(lint, strict types, unit/integration tests, dependency audit gate,
production build), and then the deterministic credential-free browser
suite (`bunx playwright install --with-deps chromium` +
`bun run test:browser`). **No CI step requires production credentials or
makes live provider calls.** The step-by-step contract lives in
[docs/verification.md](docs/verification.md); CI fails on any lint, type,
test, build, lockfile, or unexpected audit regression, and the lockfile is
refreshed deliberately and committed (`bun install` after a manifest
change), never regenerated in CI.

## Dependency audit gate

`bun run audit` runs `bun audit --json` against the frozen lockfile and
classifies every advisory against the recorded exceptions in
`scripts/dependency-audit-exceptions.json`. The gate exits non-zero when an
advisory has **no** recorded exception (a new or reintroduced regression)
or a recorded exception has **passed its expiry**. Exceptions are strict
records — never a blanket ignore — each stating package, advisory (GHSA
id), impact, owner, mitigation, and expiry.

### Current exception

| Package | Advisory | Severity | Expires | Owner |
| --- | --- | --- | --- | --- |
| `@ai-sdk/provider-utils` | [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) | low | 2026-11-30 | Discussion Room maintainers |

The impact analysis and the mitigation contract (upgrade `@mastra/core`
as soon as it ships the patched alias, then delete the exception; do not
override the alias; re-run `bun run audit` after every upgrade) are
recorded in [docs/verification.md](docs/verification.md) — treat that file
as the source of truth when re-reviewing before the expiry.

## Provider integration testing

Live provider calls are **never** part of the automated suite, locally or in
CI (PRD Testing Decision 14):

- **Unit/integration tests** exercise the Discussion lifecycle through a
  deterministic fake generation adapter at the same seam production uses
  (`src/discussion/testing/fake-discussion.ts`), including the Mastra
  adapter's contract behavior.
- **The browser suite** runs the real application against the scripted,
  credential-free adapter (`DISCUSSION_GENERATION_MODE=deterministic`), so
  journeys, policy, cancellation, retry, and session isolation are proven
  without provider availability.
- **Live verification is an opt-in manual operation** for a maintainer:
  configure a real `OPENCODE_API_KEY` and `DISCUSSION_STORE_URL`, run
  `bun run dev` (or `build` + `start`), and start a Discussion to observe
  real Supporter/Opponent Turns and telemetry on stdout. This is the
  documented way to validate provider behavior; it is credential-gated by
  design and never required for a green CI run.

## The production Mastra registry convention

`src/mastra/index.ts` is the **central composition root** — the only place
agents, tools, workflows, and scorers are registered:

- Register every product Mastra resource there. The registry must stay
  focused on the Discussion Room: today it exposes exactly the
  `supporterAgent` and `opponentAgent` (and the `MastraDiscussion` adapter
  over them) with no tools, workflows, or scorers.
- `src/mastra/index.test.ts` asserts the registry shape (agent ids, empty
  tool/workflow/scorer maps) and explicit storage, so unrelated sample
  resources cannot creep back into the production runtime.
- The Mastra composition is imported lazily and only in the `mastra`
  generation mode; the deterministic test path never constructs it.
- The Mastra instance configures explicit durable storage from the
  environment contract (never an implicit in-memory fallback) and
  privacy-safe redacted observability.

## Deploying a release

1. `bun install --frozen-lockfile` (or `bun install` + commit the refreshed
   lockfile after a manifest change).
2. `bun run verify:full` locally — the complete gate CI runs.
3. `bun run build` produces the production build; `bun run start` serves it
   (use the package scripts, not `mastra dev`/`mastra build` directly).
4. Configure the production environment per `.env.example` and
   [docs/operations.md](docs/operations.md) — durable `DISCUSSION_STORE_URL`,
   a stable ≥32-character `DISCUSSION_SESSION_SECRET`,
   `OPENCODE_API_KEY`, and observability export only when intended. Startup
   fails loudly on any missing or invalid value, so a misconfigured release
   never serves silently degraded.
5. Put the application behind a trusted proxy that sets `X-Forwarded-For`
   (the network rate limit trusts its first entry) and terminates HTTPS
   (session cookies become `Secure` on `https:` origins).
