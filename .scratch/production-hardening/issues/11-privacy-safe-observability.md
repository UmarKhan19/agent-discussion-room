# Add privacy-safe operational telemetry

Status: done

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Give operators enough structured telemetry to investigate reliability, latency, cancellation, and cost without retaining participant conversations or silently exporting them to an external observability service.

## Acceptance criteria

- [x] Structured telemetry records request identity, operation, duration, outcome, stable error class, cancellation reason, selected model identifier, and available usage metadata.
- [x] Raw Topic, Transcript, Message output, prompts, provider responses, credentials, session secrets, and authorization material are absent from default logs and spans.
- [x] Conversation redaction is enforced independently of generic secret filtering.
- [x] External trace or log export is disabled unless explicitly configured, and local behavior remains functional without platform-export credentials.
- [x] Export configuration has an explicit retention/privacy contract suitable for contributor and operator documentation.
- [x] Provider failures are observable through stable classifications without logging stack traces or raw provider payloads to participant-facing or default production channels.
- [x] Automated tests capture logs/spans for success, validation failure, policy block, rate limit, quota exhaustion, provider failure, timeout, Stop, and completion, and assert both required metadata and forbidden content.

## Blocked by

- [08 — Reject oversized and abusive endpoint traffic](./08-protect-endpoint-traffic.md)
- [09 — Enforce model-cost and concurrency budgets](./09-enforce-generation-budgets.md)
- [10 — Persist the complete Discussion lifecycle durably](./10-durable-discussion-storage.md)

## Comments

Implemented and independently reviewed on `main` (commit `81b7912`). Verified: `bun run lint` (exit 0), `bun run typecheck` (exit 0), `bun run test` (300 tests passed), and `bun run build` (exit 0, with the standard production env vars).

- Telemetry: `request` events at the HTTP seam and `generation` events at the runner seam, validated against a strict zod schema before emission; non-conforming records become `telemetry.rejected` lines naming only problem paths. Error classes are a closed 25-value vocabulary (the 24 `ProductErrorCode`s plus `INTERNAL`), guarded by a coverage test against `ProductErrorCodeSchema`.
- Privacy by construction: no schema field can carry Topic/Transcript/message/prompt/provider content; `JsonLineTelemetry` double-filters its own output against the secret policy as defense in depth; conversation content is never written to durable storage.
- Spans: `ConversationRedactionSpanProcessor` strips `input`, `output`, and free-text `errorInfo` (message/stack/details) from every exported span before any exporter, independently of `SensitiveDataFilter`; error spans retain only structured fields (`name`, `id`, `domain`, `category`).
- Export: `MastraPlatformExporter` is attached only when `DISCUSSION_OBSERVABILITY_EXPORT_ENABLED` is exactly `true` (any other value fails startup), and production additionally requires `MASTRA_PLATFORM_ACCESS_TOKEN`; local behavior never depends on export credentials. Retention/privacy contract: `docs/observability-privacy.md`.
- Two-axis review (standards + spec) found no blockers; follow-ups folded in before landing: doc-vs-schema drift on the `delete` operation, `errorInfo.message` stripped (provider messages can echo prompt fragments), forbidden-content assertions extended to blocked-topic/blocked-output strings, and an error-class coverage test for future product codes.

