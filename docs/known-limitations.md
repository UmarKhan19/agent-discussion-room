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
  (hard-bounded). Counters reset on restart; multi-instance deployments get
  per-instance budgets unless they add a shared limiting layer.
- **Single-instance local storage.** A `file:` libSQL URL supports one
  instance; horizontal scaling requires a remote libSQL endpoint.
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
