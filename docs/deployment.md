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

For current dependency audit findings and active exceptions, see the
[dependency audit gate and exception records](verification.md#dependency-audit-gate)
in the verification guide.

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

## Multi-instance deployments

Multiple application instances may serve the same remote libSQL
(`libsql:`, `http(s):`, or `ws(s):`) store. Ownership, Turn claims, retry,
and interrupted-generation recovery are enforced by the shared database
(every mutation is a `BEGIN IMMEDIATE` write transaction), so instances can
be added, removed, or restarted without coordinating among themselves:

- Startup recovery runs on **every** instance, but only reconciles attempts
  whose recovery lease has expired (or legacy rows without a lease). A
  generation actively running on another instance is never recovered.
- A crashed instance's attempts become retryable once their lease expires
  (generation timeout + 60 s); a retry with the same request identity
  reclaims the same Turn immediately (lazy recovery).
- Instances must run **reasonably synchronized clocks** (normal
  platform/NTP synchronization): each instance judges lease expiry on its
  own clock, and the 60-second margin absorbs moderate skew but not
  arbitrary skew. Substantial owner-behind skew can recover a healthy
  generation early.
- Process-local budgets (rate limits, concurrency ceiling, session quota)
  remain per-instance; see [docs/known-limitations.md](docs/known-limitations.md).

During a **rolling upgrade** from a pre-lease version, a `generating` row
written by an old-version instance has no lease and is therefore treated as
abandoned by the new version. Drain in-flight generations before upgrading,
or accept that pre-upgrade in-flight generations are recovered as
retryable (the participant can resume them with the same request identity).
