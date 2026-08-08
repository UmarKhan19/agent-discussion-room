# Privacy-safe operational telemetry

This document is the **operational privacy contract** for the Discussion
service. It states what is recorded, where it goes, what is deliberately
impossible to record, how long it may be retained, and how to change any of
it.

## What is recorded

The service emits one JSON object per line (JSON-lines, NDJSON) to **stdout**.
Every line is validated against a strict Zod schema before emission; a line
that does not conform is replaced with a `telemetry.rejected` line that names
only the invalid field paths — never their values.

Two event families exist:

| Event | Emitted at | Fields |
| --- | --- | --- |
| `request` | The HTTP seam (every handled request) | operation (`start`, `next-turn`, `stop`, `read`), outcome (`success`, `failure`), statusCode, errorClass, retryable, category, requestId, discussionId, durationMs |
| `generation` | The Discussion runner seam (each model generation) | operation (`next-turn`, `synthesis`), turn (present only for `next-turn`), requestId, discussionId, outcome (`success`, `failure`, `cancelled`), errorClass, retryable, category, cancellationReason (`stop`, `disconnect`, `timeout`), completed, model, usage, durationMs |

A synthesis generation is a `generation` event with `operation:
"synthesis"` and **no `turn` field** — it is not a Turn, and it carries
exactly the same privacy guarantees as a Turn event: model id, usage
counters, attempt identities, and outcome classification only, never any
content or prompt.

Error classes are a **stable, closed vocabulary** of 25 values: the 24
public `ProductErrorCodes` (`TOPIC_REQUIRED`, `TOPIC_BLOCKED`,
`OUTPUT_BLOCKED`, `RATE_LIMITED`, `SESSION_QUOTA_EXCEEDED`,
`GENERATION_FAILED`, `GENERATION_TIMEOUT`, `DISCUSSION_STOPPED`, …) plus
`INTERNAL` for any unexpected condition. Provider failures are observable
only through these classifications — never through provider error text.

Mastra OTel spans are exported to the configured exporter with their
`input`/`output` fields and their free-text error content (provider
`errorInfo.message`, stack traces, and payload details) **stripped by a
conversation redaction processor before any exporter sees them**; error spans
retain only structured error fields (`name`, `id`, `domain`, `category`), so
provider failures stay observable through stable classifications in spans as
well as telemetry events. External export (the Mastra platform) is disabled by
default and only activates when `DISCUSSION_OBSERVABILITY_EXPORT_ENABLED=true`
(any value other than the exact string `"true"` fails startup, so a
half-configured deployment does not silently export). In production the
platform exporter additionally requires `MASTRA_PLATFORM_ACCESS_TOKEN`.

## What is never recorded

By construction, not by filtering:

- **Topic and Transcript content** — the schema has no field that accepts it,
  and the redaction processor strips span inputs before export. A future
  mistake that adds a content field fails the schema and becomes a
  `telemetry.rejected` line instead of leaking content.
- **Message content, provider prompts and outputs** — the runner reports
  model id and usage counters only.
- **Secrets** — the emitter double-filters its own output against the
  discussion secret policy as defense in depth.
- **Session identifiers and cookies** — request identity is a `requestId`
  supplied by the client as an idempotency key and validated to be a UUID;
  `discussionId` is a server-generated UUID. Neither is a session identifier
  or cookie value.

## Retention

- **Default**: stdout is a passthrough stream. Retention is the operator's
  log-collection policy (typically short-lived container stdout); no
  telemetry is written to durable storage by this service.
- **Structured retention**: any durable pipeline (collector, SIEM, log
  warehouse) may retain the JSON lines; because content-bearing fields are
  structurally absent, retention of the stream is equivalent to retaining
  the request/error-class metadata described above.
- **Span storage**: the local storage exporter is intended for
  operational debugging windows. Purge the local span store when the
  operational question is answered; there is no data subject identity in the
  spans to purge beyond the redacted metadata above.

## Accountability

Changes to this contract are reviewed as part of the production-hardening
issue list. The acceptance tests that guard it:

- `src/observability/telemetry.test.ts` — schema, closed error-class
  vocabulary, secret filtering, `telemetry.rejected` behavior.
- `src/observability/conversation-redaction.test.ts` — span redaction is
  independent of `SensitiveDataFilter` and covers `input`/`output`/stacks.
- `src/observability/mastra-observability.test.ts` — exporter selection and
  the opt-in gate for external export.
- `src/app/api/discussions/telemetry.test.ts` — end-to-end at the HTTP seam:
  success, validation failure, policy block, rate limit, quota exhaustion,
  provider failure, timeout, Stop, completion — and the absence of topic,
  message content, and provider detail from every emitted line.

## Operating it

```bash
# Local debugging: logs land on stdout already.
bun run dev

# Enabling platform export (only when you mean it).
DISCUSSION_OBSERVABILITY_EXPORT_ENABLED=true \
MASTRA_PLATFORM_ACCESS_TOKEN=... \
bun run start
```

There is no per-request opt-out: telemetry is a fixed part of the service
contract, and its content policy cannot be weakened through configuration.
