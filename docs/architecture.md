# Architecture

This document is the **single reference for the Discussion domain and the
server-owned system design**. The vocabulary defined here is used
consistently across interfaces, tests, documentation, and UI copy (PRD
Implementation Decision 1). The production-hardening issues
(`.scratch/production-hardening/`) are the recorded history of the decisions
below.

## Domain vocabulary

| Term | Definition |
| --- | --- |
| **Discussion** | A server-owned resource that carries one Topic through a bounded sequence of Turns to a terminal state. A Discussion is identified by a server-generated UUID, belongs to exactly one signed session, and is never created or mutated by the browser as authoritative state. |
| **Discussion Topic** | The plain-text subject the participant submits to start a Discussion. Up to 240 characters, no control characters, must pass the input Discussion Policy. Displayed as the Active Topic for the whole Discussion. |
| **Turn** | One position in the Discussion, numbered from 1 to the configured Turn limit. Each Turn belongs to exactly one Speaker, is derived by the server from its position (`speakerForTurn`), and is only ever observed by the client. |
| **Message** | The persisted record of a completed Turn: `id` (UUID), `content` (up to 12,000 characters), `speaker`, `createdAt`, `turn`, and minimal `generation` metadata (request identity, optional token usage, output-policy outcome). Only completed Turns become Messages; a Turn that fails, is blocked, or is cancelled is never appended. |
| **Speaker** | One of the two roles, `supporter` or `opponent`. The server derives the Speaker for each Turn; the client cannot submit, reorder, or forge one. |
| **Supporter** | The Speaker who argues in support of the Topic (Turn 1, then every odd Turn). Implemented by the Supporter agent with a stable model identifier reported in telemetry. |
| **Opponent** | The Speaker who argues against the Topic (Turn 2, then every even Turn). Implemented by the Opponent agent. |
| **Transcript** | The ordered list of Messages of one Discussion, newest last. Transcript length always equals the Turn count; Turn positions are ordered without gaps (enforced by `DiscussionStateSchema`). The model never sees the whole Transcript — only the bounded recent window (see [Bounded context](#bounded-context)). |
| **Discussion Runner** | The sole authority for the next-Turn lifecycle: it owns Speaker selection, generation claims, policy checks, budget checks, cancellation, retry/idempotency, and the commit of completed Messages (`src/discussion/discussion-runner.ts`). One Discussion may have at most one active generation. |
| **Discussion Policy** | The server-owned input and output safety rules, independent of the debate agents' instructions. Input policy checks the Topic at start; output policy checks every generated Turn before commit. See [docs/safety.md](docs/safety.md). |

Supporting terms used throughout:

| Term | Definition |
| --- | --- |
| **Session** | An anonymous signed session identified by a UUID. The browser holds an `HttpOnly` cookie containing the UUID and an HMAC-SHA256 signature; every Discussion endpoint requires a valid session and enforces ownership (see [Signed-session ownership](#signed-session-ownership)). |
| **Request identity (`requestId`)** | A client-supplied UUID that makes next-Turn requests idempotent. Replaying a completed request returns the recorded outcome; retrying a transient failure with the same identity resumes the same Turn. |
| **Discussion state** | The validated public shape of a Discussion: `id`, `topic`, `status`, `terminalReason`, `turnLimit`, `turnCount`, `createdAt`, `updatedAt`, `policyOutcome`, `transcript`. Every response is parsed against `DiscussionResponseSchema` before it leaves the server. |
| **Turn failure** | A stable, closed classification of why a Turn did not complete (`generation_failed` [retryable or not], `invalid_response`, `output_blocked`, `output_limit_exceeded`, `timeout`, `stopped`). Failures are persisted per request identity and surfaced as stable product errors. |

## System overview

```
Participant (browser UI)
        │  JSON fetch (same origin)
        ▼
HTTP interface ──► DiscussionService ──► DiscussionStore (libSQL / in-memory dev)
  POST /api/discussions            │
  POST /api/discussions/:id        ▼
  POST /api/discussions/:id/stop  DiscussionRunner ──► Discussion (generation seam)
  GET  /api/discussions/:id                 │              ├─ Mastra agents (production)
        ▲                                   │              └─ scripted adapter (dev/test)
        └── telemetry: NDJSON stdout, redacted OTel spans
```

- **The server owns everything.** Speaker order, Transcript, Turn count,
  safety state, completion state, budgets, and policy are derived server-side
  and validated by Zod schemas before any response is sent. Browser code
  renders the state it is given; it never decides who speaks next, what the
  Transcript is, or whether a Turn may commit.
- **Runtime contracts generate their types.** Request, response, and error
  shapes are defined once as Zod schemas in
  `src/discussion/contracts.ts`; TypeScript types are inferred from them, so
  compile-time and wire-format definitions cannot drift independently.
- **Generation is behind a seam.** The Runner depends on a `Discussion`
  interface (`generateTurn`). Production uses `MastraDiscussion` wrapping the
  registered debate agents; tests and the browser suite use deterministic
  fakes through the same seam, so lifecycle behavior is verified without
  live provider calls.

## The server-owned HTTP interface

All endpoints are JSON, `Cache-Control: private, no-store`, `Vary: Cookie`,
and return the validated `DiscussionState` on success or a stable error
envelope on failure.

| Operation | Endpoint | Request body | Success | Notable failures |
| --- | --- | --- | --- | --- |
| Start a Discussion | `POST /api/discussions` | `{"topic": "<text>"}` | `201` + state (`idle`, empty Transcript) | `400` topic validation family, `422 TOPIC_BLOCKED` (input policy), `413`/`415` transport guards, `429` rate limited |
| Request the next Turn | `POST /api/discussions/:id` | `{"requestId": "<uuid>"}` | `200` + state (completed at the Turn limit) | `404` not owned/unknown, `409` `REQUEST_IN_PROGRESS`/`TURN_IN_PROGRESS`/`DISCUSSION_COMPLETED`/`DISCUSSION_STOPPED`/`INVALID_DISCUSSION_STATE`, `422 OUTPUT_BLOCKED`, `429 SESSION_QUOTA_EXCEEDED`, `502` `GENERATION_FAILED`/`OUTPUT_LIMIT_EXCEEDED`/`INVALID_RESPONSE`, `503 GENERATION_CAPACITY_EXCEEDED`, `504 GENERATION_TIMEOUT` |
| Stop an in-progress generation | `POST /api/discussions/:id/stop` | none (empty body) | `200` + state (`stopped`, `terminalReason: "stop"`) | `404`, `409 INVALID_DISCUSSION_STATE` when nothing is generating |
| Read a Discussion | `GET /api/discussions/:id` | none | `200` + state | `404` not owned/unknown |

Error envelope: `{"error": {"code", "message", "action", "retryable",
"category"? (policy blocks), "retryAfterSeconds"? (rate limits)}}`. `code`
is a stable, closed vocabulary (`ProductErrorCodeSchema`, 24 values);
`action` tells the participant what to change. Provider details, stack
traces, and internal model information never appear in responses.

Transport guards run before any parsing, policy work, storage, or
generation: a bounded body read (default 4096 bytes → `413`), JSON content
type when a body is present (`415`), session authentication, then
network-level and per-session fixed-window rate limits (`429` with
`Retry-After`). See [docs/operations.md](docs/operations.md) for the budget
and limit tables.

### Runtime storage outages

After a successful startup, a later libSQL/database outage is handled in
**one** place and one place only — the durable store normalizes the failure
into `DiscussionStorageUnavailableError`, which every endpoint handler maps
to the same stable envelope. There is no per-endpoint `try/catch` for
storage: the store is the normalization boundary (see `guardStorage` and
`isStorageUnavailableError` in `src/discussion/libsql-discussion-store.ts`),
and HTTP handlers never inspect libSQL error shapes. The four endpoints —
Start, Read, Next Turn, and Stop — therefore all return
`500 STORAGE_UNAVAILABLE` (retryable) when storage is unreachable, while
non-storage failures (programming, data, or invariant errors such as
constraint violations) continue to surface as their own product codes
(`INVALID_RESPONSE`/`INTERNAL`) and are never relabeled as an outage.

## Signed-session ownership

- Every request carries an `HttpOnly` cookie (`discussion_session`) holding
  `sessionId.signature` — a UUID and a base64url HMAC-SHA256 signature over
  it, using the configured `DISCUSSION_SESSION_SECRET` (ephemeral per-process
  key in development/test).
- Cookie attributes: `Path=/; HttpOnly; SameSite=Lax; Max-Age=30 days`, plus
  `Secure` on HTTPS.
- All four endpoints authenticate the session and scope every store
  operation to it (`ownerSessionId`). One session cannot read, advance, or
  stop another session's Discussion (enforced by `readOwned`/`claimTurn`/
  `stopOwned` and proven by ownership tests and a browser-context isolation
  journey).
- A stable production secret lets ownership survive restarts; without it,
  every restart invalidates existing sessions (see
  [docs/operations.md](docs/operations.md)).

## Allowed state transitions

States: `idle` → `generating` → `completed` | `stopped` | `failed`.
`failed` may return to `generating` for a retry; `completed`, `stopped`, and
timeout-`failed` are terminal.

| Transition | Trigger | Notes |
| --- | --- | --- |
| `idle` → `generating` | next-Turn request claims Turn 1 | Speaker is Supporter |
| `idle` → `generating` (retry) | same request identity retried after a retryable failure | Reclaims the failed Turn; a retry never skips or duplicates a Turn |
| `generating` → `idle` | Turn completes before the limit | Message appended, `turnCount` incremented, next request may start the next Turn |
| `generating` → `completed` | final Turn (turnCount == turnLimit) completes | `completed` requires exactly the Turn limit (`DiscussionStateSchema`) |
| `generating` → `stopped` | explicit Stop, or client disconnect | `terminalReason` `"stop"` or `"disconnect"`; terminal |
| `generating` → `failed` | provider/contract failure, output policy block, output limit, or hard timeout | `terminalReason` is `null` except timeout (`"timeout"`); only retryable failures can be retried |

The state machine is enforced twice: the store rejects invalid claims and
mutations atomically (`claimTurn`/`completeTurn`/`failTurn`/`cancelTurn`),
and the Runner's contract parses every persisted state, so a corrupt or
hand-written row cannot produce an illegal state.

## Speaker ordering

`speakerForTurn(turn)` is the single source of order: odd Turns (1, 3, …)
belong to the **Supporter**, even Turns (2, 4, …) to the **Opponent**. The
server derives the Speaker at claim time from the persisted Turn position;
the client sends only `requestId`. The browser suite proves attributed,
alternating Turns end-to-end.

## Bounded context

The model never receives the full Transcript. Before each generation the
Runner selects the most recent completed Messages up to
`recentTranscriptTurns` (default **8**, hard maximum 32) while respecting a
character budget (default **32,000**, hard maximum 64,000). Output is
bounded by a provider token ceiling (default 2,000, hard maximum 8,000) and
a post-generation character ceiling (default 8,000, hard maximum 12,000 —
the persisted Message limit). All ceilings are server-owned; clients cannot
submit any budget.

## Turn limit

Discussions default to a finite **12-Turn** limit (`turnCount` 1–12). The
limit is server-controlled: environment configuration may lower it
(`DISCUSSION_TURN_LIMIT`), the client cannot raise it, and the hard maximum
is 12 (`HARD_DISCUSSION_TURN_LIMIT`). A Discussion at its limit is
`completed` and rejects further next-Turn requests with
`DISCUSSION_COMPLETED`; participants start a fresh Discussion to continue.

## Cancellation

Three independent cancellation paths abort an in-flight generation, and a
cancelled Turn never produces a Message:

1. **Explicit Stop** — `POST /api/discussions/:id/stop` persists a `stopped`
   state and aborts the generation's AbortController.
2. **Client disconnect** — the request's abort signal is wired to the
   generation; a disconnect persists `stopped` with `terminalReason:
   "disconnect"`.
3. **Hard timeout** — the configured generation ceiling (default 30 s, hard
   maximum 300 s) persists `failed` with `terminalReason: "timeout"`.

Cancellation is reported as `stopped` or `GENERATION_TIMEOUT` — never as an
opaque provider failure. A provider that ignores its abort signal cannot
persist a late result: the store accepts a completion only for the exact
persisted attempt (`isCurrentAttempt`), and a stale completion is discarded
(proven by the `ignoreAbort` browser journey).

## Retry and idempotency

Each next-Turn request carries a client-generated `requestId` (UUID),
making the operation idempotent per (Discussion, request identity):

- **Replay** — a repeated request after success returns the recorded state
  without generating anything.
- **In-flight duplicate** — the same identity is answered `409
  REQUEST_IN_PROGRESS`; a different identity while a generation is active is
  `409 TURN_IN_PROGRESS`. Simultaneous requests cannot produce duplicate or
  out-of-order Messages.
- **Retry** — after a retryable failure the participant retries with the
  same identity; the store reclaims the same Turn and commits exactly one
  Message. Non-retryable failures are terminal for that identity.
- **Quota accounting** — a session generation quota is charged once per
  (Discussion, request identity); replays, conflicts, and rejected
  duplicates never charge twice. The quota is time-windowed: a session may
  charge at most `DISCUSSION_SESSION_GENERATION_QUOTA` unique generations
  per `DISCUSSION_SESSION_GENERATION_QUOTA_WINDOW_MS` (default 24 h). When
  the window elapses the charge keys are discarded and the allowance is
  restored, so "try again later" is truthful — an exhausted session recovers
  automatically after the configured window. The quota is never charged
  for a request rejected solely because the server lacks generation
  capacity.

  Precise "charged once" semantics across windows and retries:

  - Within one active window, repeated execution of the same logical
    request (a retry of a retryable failure, or an already-charged key) is
    never double-charged.
  - A successful persisted replay never triggers another provider
    generation or quota charge, even after the window elapses — the
    persisted outcome is authoritative regardless of in-memory charge keys.
  - A retryable failure retried in a later quota window is a fresh provider
    execution in a fresh cost window and consumes quota from that later
    window.
  - The final charge is an atomic, authoritative mutation executed only
    after generation capacity is acquired: two concurrent unique requests
    that both passed an earlier advisory check can never over-commit the
    last remaining quota slot, and the request that loses the race is
    answered with `SESSION_QUOTA_EXCEEDED` while its persisted Turn claim
    is reconciled into a retryable failure.

## Fresh-Discussion rules

- Starting a Discussion always creates a **new server-owned resource with a
  new UUID**; no Topic, Transcript, state, or request identity carries over
  from a previous Discussion.
- The UI's fresh-Discussion action clears participant-facing state, aborts
  any in-flight client work, and focuses the Topic control; the server
  independently rejects requests against a completed/stopped Discussion.
- Reusing a request identity across Discussions is legal but charges each
  Discussion separately against the session quota.

## Persistence and data model

The production system of record is a **libSQL** database
(`DISCUSSION_STORE_URL`), with two tables created at startup:

- `discussion` — `id` (PK), `owner_session_id`, `state` (validated
  `DiscussionState` JSON), `updated_at`.
- `discussion_request` — `discussion_id` + `request_id` (PK), `turn`,
  `attempt_id`, `status` (`generating`/`succeeded`/`failed`), `failure`,
  `lease_owner_id`, `lease_expires_at`. This table is what makes retry,
  replay, one-attempt commit, and abandoned-generation recovery reliable
  across restarts and multiple application instances.

Ownership, Topic, ordered Messages, status, Turn counts, timestamps, policy
outcomes, and request identities are all persisted; raw provider traces are
never the system of record. The central Mastra runtime gets its own storage
(a sibling `mastra.db` for local files; the shared remote URL when the
Discussion store is remote) so the two never contend on one SQLite file.

### Generation leases

Every claimed attempt writes a **recovery lease** onto its request record:

- `lease_owner_id` — the application instance that claimed the attempt (a
  server-generated random UUID per process; not authentication, never
  exposed to clients, useful only for operational diagnosis).
- `lease_expires_at` — claim time plus the lease duration. The lease
  duration is **derived from the generation timeout** the store is
  constructed with (`deriveLeaseDurationMs` in `src/discussion/budgets.ts`,
  the single derivation for every construction site): the configured
  generation timeout (`DISCUSSION_GENERATION_TIMEOUT_MS`) plus a fixed
  60-second safety margin (`RECOVERY_LEASE_GRACE_MS`). Because the durable
  store takes the same generation-timeout value the Runner enforces, a
  live instance's own hard timeout always fires before its lease expires.

Each instance evaluates lease expiry on its own clock. The 60-second
margin absorbs normal scheduling and network delays and **moderate** clock
skew; it is not a guarantee against arbitrary skew. Production instances
are expected to run reasonably synchronized clocks (normal
platform/NTP synchronization); substantial owner-behind skew can cause a
healthy generation to be recovered early.

The hard server-side generation timeout is what makes heartbeats
unnecessary: a healthy attempt either completes or is cancelled well within
its lease, so an unexpired lease is proof that the owning instance is still
responsible for the attempt.

### Interrupted-generation recovery

Recovery reconciles only attempts that are actually eligible:

- **Startup recovery** — every instance runs `recoverInterrupted()` during
  startup readiness. It flips a `generating` attempt to a retryable failed
  state (and its Discussion to `failed` with a null terminal reason) **only**
  when the attempt's lease has expired or is absent. An attempt whose lease
  is still valid is owned by a live instance and is never touched, so one
  instance starting up cannot invalidate a generation running on another.
- **Lazy recovery** — a next-Turn claim for a request identity whose
  generating attempt has an expired lease recovers it inside the same
  transaction before reclaiming the Turn, so participants are not stranded
  waiting for a restart. A recovered Discussion may also be reclaimed by a
  fresh request identity (the participant may have lost the original
  identity); either way the abandoned Turn is reclaimed at the same
  position — nothing is skipped or duplicated.
- **Legacy rows** — request records written before leasing existed have
  `NULL` leases and are treated as expired, so upgrading an existing
  database never strands a `generating` row. The columns are added by an
  idempotent migration safe to run concurrently from several instances.

A consequence of leasing is that crash recovery is **deferred**: after the
owning process disappears, the attempt stays `generating` (and retries
answer `REQUEST_IN_PROGRESS`) until the lease expires, then becomes
retryable. That deferral is the price of never mistaking a slow-but-live
generation for an abandoned one. `stopped` and timeout-`failed` Discussions
are terminal and are never recovered; explicit Stop and the product timeout
remain authoritative.

All recovery and claim mutations run in `BEGIN IMMEDIATE` write
transactions, so concurrent completion, cancellation, retry, and recovery
from different instances serialize at the database: whichever commits
first wins, and the loser observes the winner's state (a late provider
result is rejected as stale by `isCurrentAttempt`).

Development and test use an explicit in-memory store; production refuses
in-memory URLs and fails startup instead of falling back (see
[docs/operations.md](docs/operations.md)).

## Mastra production registry

Mastra resources are registered in the central composition root
`src/mastra/index.ts`, which exposes the Mastra instance and the
`MastraDiscussion` generation adapter:

- **Agents:** `supporterAgent` and `opponentAgent` only — the production
  registry contains exactly these two agents and **no** tools, workflows, or
  scorers. `src/mastra/index.test.ts` asserts this focus so unrelated sample
  resources cannot return.
- The composition resolves its own environment (storage, logger,
  observability) from the same environment contract, with explicit storage —
  never an implicit in-memory fallback.
- The deterministic mode does **not** import the Mastra composition at all,
  so no agent, storage, or observability code that could touch a provider
  runs in the credential-free test path.

See [docs/deployment.md](docs/deployment.md) for the registration
convention, and `AGENTS.md` for the repository rules (use the `dev`/`build`
package scripts; register all resources in `src/mastra/index.ts`).
