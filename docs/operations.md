# Operations

This document is the operator-facing contract for running the Discussion
Room in production: durable storage, startup failure conditions, budgets and
limits, telemetry, retention, and redaction. The privacy contract itself is
documented in full in [docs/observability-privacy.md](docs/observability-privacy.md);
this page summarizes it and links the details.

The complete environment contract lives in the tracked example file
`.env.example` — every variable below appears there with a safe placeholder,
its production/development applicability, and its validation behavior. That
file is enforced by a contract test, so the example cannot silently drift
from the runtime variables.

## Durable storage

`DISCUSSION_STORE_URL` selects the libSQL storage adapter. Supported forms:

| Form | Example | Use |
| --- | --- | --- |
| Local file | `file:./data/discussions.db` | Single-instance deployments; a sibling `mastra.db` is used for the Mastra runtime |
| Managed remote | `libsql://your-db.turso.io` | Multi-instance deployments; `DISCUSSION_STORE_AUTH_TOKEN` authenticates |
| Remote HTTP/WebSocket | `https://…` / `wss://…` | Multi-instance deployments via libSQL HTTP/WS endpoints |

- The Discussion system of record and the Mastra runtime storage are
  separated (sibling file for local URLs; the shared URL is safe because the
  server serializes writers).
- In-memory storage exists **only** as the explicit development/test
  default. Production rejects in-memory and ephemeral URLs at startup — there
  is no implicit production fallback.
- At startup the durable store creates its schema and reconciles any
  Discussion left `generating` by a previous process into a retryable failed
  state, so a restart never strands a participant mid-Turn.
- **Retention expectations**: the store keeps Discussion rows and request
  records until deleted; the service ships no purge or migration tooling.
  Backups, archival, and deletion are the operator's responsibility (the
  local SQLite database can be backed up with standard tooling; remote
  databases follow the provider's backup contract). There is no historical
  production data import.

## Startup failure conditions

Production startup **fails loudly** with a non-secret problem list (only
environment variable names and constraints are named — never values) when:

- `DISCUSSION_STORE_URL` is missing, an in-memory URL, or not a `file:`,
  `libsql:`, `http(s):`, or `ws(s):` URL.
- `DISCUSSION_SESSION_SECRET` is missing or shorter than 32 characters.
- `OPENCODE_API_KEY` is missing (the debate agents need provider
  credentials).
- `DISCUSSION_GENERATION_MODE=deterministic` is set (a credential-free test
  mode that production rejects; any value other than exactly `deterministic`
  or unset is also a misconfiguration).
- `DISCUSSION_OBSERVABILITY_EXPORT_ENABLED` is set to anything other than
  exactly `true` (a half-configured deployment must not silently export).
- `MASTRA_PLATFORM_ACCESS_TOKEN` is missing while export is enabled (export
  would otherwise silently stay disabled).
- Any budget value is non-numeric or above its hard maximum (schema-validated
  at composition time).

After startup, a storage failure (for example the database becoming
unavailable) does not crash the process: every Discussion request returns a
stable `500 STORAGE_UNAVAILABLE` (retryable) until storage recovers.

## Rate, quota, and concurrency budgets

All ceilings are server-owned: environment configuration may lower them,
clients cannot submit any budget, and values above a hard maximum fail
startup.

### Endpoint protection (per process)

| Ceiling | Default | Env var | Notes |
| --- | --- | --- | --- |
| Request body | 4,096 bytes | `DISCUSSION_MAX_REQUEST_BODY_BYTES` | Bounded read; oversized → `413` |
| Session rate limit | 60 req / 60 s | `DISCUSSION_SESSION_RATE_LIMIT`, `DISCUSSION_SESSION_RATE_WINDOW_MS` | Fixed window per signed session → `429` + `Retry-After` |
| Network rate limit | 300 req / 60 s | `DISCUSSION_NETWORK_RATE_LIMIT`, `DISCUSSION_NETWORK_RATE_WINDOW_MS` | Fixed window per client address (`X-Forwarded-For` first hop, then `X-Real-IP`) → `429` + `Retry-After` |
| Session generation quota | 500 claims | `DISCUSSION_SESSION_GENERATION_QUOTA` | Per (Discussion, request identity), process-local → `429 SESSION_QUOTA_EXCEEDED` |

Rate-limit state is **process-local and in-memory** (hard-bounded bucket
table): counters reset on restart, and multi-instance deployments should put
rate limiting at a shared layer (proxy/gateway) or accept per-instance
budgets.

### Generation budgets (per process)

| Budget | Default | Hard maximum | Env var |
| --- | --- | --- | --- |
| Turn limit per Discussion | 12 | 12 | `DISCUSSION_TURN_LIMIT` |
| Recent-Transcript Turns in context | 8 | 32 | `DISCUSSION_RECENT_TRANSCRIPT_TURNS` |
| Recent-Transcript characters in context | 32,000 | 64,000 | `DISCUSSION_TRANSCRIPT_CHARACTER_BUDGET` |
| Output tokens (provider ceiling) | 2,000 | 8,000 | `DISCUSSION_MAX_OUTPUT_TOKENS` |
| Output characters (enforced post-generation) | 8,000 | 12,000 | `DISCUSSION_MAX_OUTPUT_CHARACTERS` |
| Generation timeout | 30,000 ms | 300,000 ms | `DISCUSSION_GENERATION_TIMEOUT_MS` |
| Simultaneous generations | 4 | 16 | `DISCUSSION_MAX_CONCURRENT_GENERATIONS` |

Concurrency ceiling exhaustion → `503 GENERATION_CAPACITY_EXCEEDED`
(retryable). Timeout → `504 GENERATION_TIMEOUT`. Budget semantics, Speaker
order, cancellation, and retry rules are in
[docs/architecture.md](docs/architecture.md).

## Telemetry

- **Default**: one JSON line per event (NDJSON) on **stdout** — a `request`
  event per handled HTTP request and a `generation` event per model
  generation. Fields are identifiers, outcome, stable error class,
  retryable flag, latency, model, and usage metadata. The error-class
  vocabulary is closed (24 product codes + `INTERNAL`); provider failures
  are observable only through these classifications.
- **Never recorded, by construction**: Topic, Transcript, Message content,
  prompts, model output, secrets, and session identifiers. The telemetry
  schema has no field that accepts conversation content; a future schema
  violation becomes a `telemetry.rejected` line naming only invalid field
  paths. The emitter additionally double-filters its own output against the
  secret policy.
- **Spans**: Mastra OTel spans are conversation-redacted (input/output and
  free-text error content stripped) before any exporter sees them. See
  [docs/observability-privacy.md](docs/observability-privacy.md) for the
  full field tables and the accountability tests that guard this contract.

## External export opt-in

External observability export is **disabled by default**. It activates only
when `DISCUSSION_OBSERVABILITY_EXPORT_ENABLED=true` (exactly; any other
value fails startup) and, in production, `MASTRA_PLATFORM_ACCESS_TOKEN` must
also be present. There is no per-request opt-out: telemetry is a fixed part
of the service contract and its content policy cannot be weakened through
configuration.

## Retention expectations

- **stdout telemetry**: retention is the operator's log-collection policy
  (typically short-lived container stdout); the service writes no telemetry
  to durable storage itself.
- **Durable pipelines** (collector/SIEM/log warehouse) may retain the JSON
  lines; because content-bearing fields are structurally absent, retaining
  the stream is equivalent to retaining request/error metadata.
- **Local span store**: intended for short operational debugging windows;
  purge it when the question is answered (there is no data-subject identity
  in the spans beyond redacted metadata).
- **Discussion data**: retained until the operator deletes it (see Durable
  storage above).

## Secret and conversation redaction

- Secrets are never logged, never returned in responses, and never named in
  startup errors (problems name only variable names).
- Conversation content is excluded from telemetry **by construction** (no
  field accepts it), not by post-hoc filtering; span redaction is a second,
  independent layer that strips `input`/`output`/error payloads before any
  exporter.
- Redaction is deliberately **not** considered sufficient conversation
  redaction: content exclusion and span stripping exist independently, so
  neither layer alone is the privacy boundary.
