# Add privacy-safe operational telemetry

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Give operators enough structured telemetry to investigate reliability, latency, cancellation, and cost without retaining participant conversations or silently exporting them to an external observability service.

## Acceptance criteria

- [ ] Structured telemetry records request identity, operation, duration, outcome, stable error class, cancellation reason, selected model identifier, and available usage metadata.
- [ ] Raw Topic, Transcript, Message output, prompts, provider responses, credentials, session secrets, and authorization material are absent from default logs and spans.
- [ ] Conversation redaction is enforced independently of generic secret filtering.
- [ ] External trace or log export is disabled unless explicitly configured, and local behavior remains functional without platform-export credentials.
- [ ] Export configuration has an explicit retention/privacy contract suitable for contributor and operator documentation.
- [ ] Provider failures are observable through stable classifications without logging stack traces or raw provider payloads to participant-facing or default production channels.
- [ ] Automated tests capture logs/spans for success, validation failure, policy block, rate limit, quota exhaustion, provider failure, timeout, Stop, and completion, and assert both required metadata and forbidden content.

## Blocked by

- [08 — Reject oversized and abusive endpoint traffic](./08-protect-endpoint-traffic.md)
- [09 — Enforce model-cost and concurrency budgets](./09-enforce-generation-budgets.md)
- [10 — Persist the complete Discussion lifecycle durably](./10-durable-discussion-storage.md)
