# Known limitations

This release is a production-hardening pass over a bounded two-agent
Discussion product. The following limitations are intentional and accurate
for the current release; treat them as product rules until they are
explicitly changed.

## Response shape

- **Complete-response JSON, no streaming.** Every next-Turn request waits for
  the full generated Turn and returns the complete `DiscussionState` as JSON
  (`200`). There is no token-by-token streaming, no partial Transcript
  updates, and no progress beyond the `generating` status while a Turn is in
  flight. This is a deliberate trade-off: correct lifecycle and cancellation
  behavior took priority over streaming complexity in the first hardening
  release.

## Sessions and accounts

- **Anonymous signed sessions.** Participants are identified by an
  `HttpOnly` cookie containing a UUID and an HMAC-SHA256 signature. There is
  no login, no password, no email, and no identity recovery; losing the
  cookie loses access to that session's Discussions.
- **No full accounts.** No user accounts, profiles, preferences, roles, or
  billing exist. Ownership is per signed session, and a stable
  `DISCUSSION_SESSION_SECRET` is what keeps ownership valid across restarts.
- **No streaming or collaboration.** No WebSocket transport and no live
  collaborative viewing; two participants cannot watch or drive the same
  Discussion.

## Correctness

- **No factual-correctness guarantee.** The Supporter and Opponent generate
  model output that is checked against the output policy, contracts,
  budgets, and limits — not for factual accuracy. Participants should not
  treat any Turn as a verified fact.

## Additional current limits

- **Rule-based policy, not a moderation model.** Input and output policy are
  deterministic, reviewable rule sets (see [docs/safety.md](docs/safety.md)).
  They reliably block the configured advocacy categories but cannot catch
  every paraphrase; they are not a learned moderation model and are not
  tuned for out-of-vocabulary harm.
- **Per-process budgets and rate limits.** The rate limiter, session
  generation quota, and concurrency ceiling are process-local and in-memory
  (hard-bounded). Counters and charge keys reset on restart; multi-instance
  deployments get per-instance budgets unless they add a shared limiting
  layer.
- **Cookie-based quota can be reset by clearing cookies.** The session
  generation quota is enforced per signed session cookie, so deleting the
  cookie (or using a fresh browser profile) yields a fresh allowance. The
  quota is an abuse-abatement measure, not a billing or identity system.
- **Quota state can be evicted under extreme session churn.** The generation
  quota is a best-effort process-local cost guard. Its in-memory session
  table is hard-bounded (10,000 sessions, the same bound as the rate
  limiter); under extreme unique-session churn it may evict an active
  session's quota state to keep the table bounded, which can restore
  allowance for that session. Expired windows are always swept before any
  live entry is evicted, and the session currently being processed is never
  evicted.
- **Single-instance local storage.** A `file:` libSQL URL supports one
  instance; horizontal scaling requires a remote libSQL endpoint. Remote
  libSQL deployments may run multiple instances against the shared store:
  interrupted-generation recovery is lease-protected, so a live instance's
  in-flight generations are never recovered by another instance, while
  abandoned attempts become retryable after their lease expires.
- **Crash recovery is deferred by the lease duration.** After a process
  disappears mid-generation, the Turn stays `generating` (and same-identity
  retries answer `REQUEST_IN_PROGRESS`) until the recovery lease expires
  (generation timeout + 60 s), then the attempt becomes retryable. This
  delay is the trade-off for never treating a slow-but-live generation as
  abandoned.
- **Clock-skew sensitivity.** Lease expiry is evaluated on each instance's
  own clock. Normal scheduling/network delay and moderate skew are absorbed
  by the 60-second recovery margin, but the lease does not protect against
  arbitrary skew: an instance whose clock lags substantially can have its
  healthy in-flight generations recovered by other instances. Instances are
  expected to run normal platform/NTP time synchronization.
- **Bounded model context.** The model sees only the recent-Transcript
  window (default 8 completed Turns / 32,000 characters), so very long
  Discussions lose early context by design.
- **Telemetry has no per-request opt-out.** NDJSON telemetry on stdout is a
  fixed part of the service contract; its content policy cannot be weakened
  through configuration (see [docs/observability-privacy.md](docs/observability-privacy.md)).
- **No data import or migration tooling.** There is no tooling to import or
  migrate historical Discussion data, and no built-in purge; retention and
  deletion are operator-managed (see [docs/operations.md](docs/operations.md)).
- **No internationalization.** The UI and error copy are English-only;
  layout avoids obvious localization barriers but no i18n pipeline exists.

## Storage-outage classification

- **Classification is code- and signature-based, with no cause traversal.** A
  libSQL failure is treated as a storage outage (`500 STORAGE_UNAVAILABLE`)
  when its own `code` is one of the recognized transport/server/storage
  codes — refused connections, HTTP 5xx (`SERVER_ERROR`), the `HRANA_*`
  protocol/socket codes, and the `SQLITE_IOERR` / `SQLITE_FULL` /
  `SQLITE_CANTOPEN` / `SQLITE_CORRUPT` / `SQLITE_NOTADB` / `SQLITE_READONLY`
  / `SQLITE_BUSY` / `SQLITE_LOCKED` / `SQLITE_NOMEM` / `SQLITE_PERM` /
  `SQLITE_AUTH` / `INTERNAL` / `UNKNOWN` family; or, for Node/undici
  transport failures, when the error matches the single exact signature
  `TypeError("fetch failed")`. Arbitrary message text is not parsed and the
  `cause` chain is **not** traversed: a *programming* `TypeError` that
  happens to carry a system error as its `cause` is classified as **not** an
  outage and surfaces through the generic error path, so genuine bugs do not
  get disguised as transient unavailability.
- **Transport-error shapes differ by runtime.** Under Node/undici the libSQL
  HTTP client surfaces transport failures as `TypeError("fetch failed")`
  (with the system `code` on `cause`, e.g. `ECONNREFUSED`; a DNS miss carries
  no cause), while Bun surfaces the system error directly as an own `code`
  (e.g. `"ConnectionRefused"`). The classifier handles both shapes; exotic
  or unrecognized transport failures fall through to the generic path.
- **In-memory/dev stores never throw it.** The in-memory test store cannot
  fail to be "unavailable," so the typed error is only ever produced by the
  real durable store boundary; test fakes propagate either the typed error
  or raw libSQL shapes naturally.
- **Filesystem fault injection is unreliable for `file:` stores.** A local
  libSQL file database keeps persistent file descriptors open (WAL mode), so
  `chmod`-based denial does **not** reliably block the native client's reads
  or writes — it is not a viable runtime-outage injection. Outage coverage is
  instead provided by classifier tests on the raw error shapes and by
  real-client boundary tests (`init()` against an unreachable host
  `http://127.0.0.1:1` and a real local HTTP 500 server, plus the
  duplicate-primary-key `SQLITE_CONSTRAINT` false branch) rather than by
  filesystem mutation.
- **Startup failures remain raw and loud.** A storage failure that occurs
  *during startup* is not wrapped — startup still fails loudly and the
  `ready` gate maps it to `STORAGE_UNAVAILABLE` at the API contract layer;
  the boundary wrapping only applies to failures *after* a successful
  startup.
