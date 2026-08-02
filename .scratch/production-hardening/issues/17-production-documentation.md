# Publish production operations and contributor documentation

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Replace starter guidance with an accurate operating and contribution guide for the shipped Discussion Room, including its domain language, safety and completion rules, environment contract, persistence, privacy, verification, deployment, and known limitations.

## Acceptance criteria

- [ ] Setup documentation names the supported package manager and runtimes, frozen install flow, development/build commands, test commands, and credential-free deterministic test path.
- [ ] A tracked example environment contract lists every required and optional variable with safe placeholders, production/development applicability, validation behavior, and no real secrets.
- [ ] Architecture documentation consistently defines Discussion, Discussion Topic, Turn, Message, Speaker, Supporter, Opponent, Transcript, Discussion Runner, and Discussion Policy.
- [ ] Documentation explains the server-owned HTTP interface, signed-session ownership, allowed state transitions, Speaker ordering, bounded context, Turn limit, cancellation, retry/idempotency, and fresh-Discussion rules.
- [ ] Safety documentation states that input and output policy are independent of agent instructions and describes blocked behavior and participant recovery without publishing bypass guidance.
- [ ] Operations guidance covers durable storage, startup failure conditions, rate/quota/concurrency budgets, privacy-safe telemetry fields, external-export opt-in, retention expectations, and secret/conversation redaction.
- [ ] Deployment and verification guidance covers reproducible CI, dependency-audit exceptions, provider integration tests, and the production registry convention for Mastra resources.
- [ ] Known limitations accurately include complete-response JSON, anonymous signed sessions, no full accounts, no streaming/collaboration, and no factual-correctness guarantee.
- [ ] Framework starter copy, obsolete Weather references, and inaccurate setup instructions are absent, and all documented commands and links are verified.

## Blocked by

- [02 — Remove the Weather sample from the production runtime](./02-remove-weather-sample.md)
- [10 — Persist the complete Discussion lifecycle durably](./10-durable-discussion-storage.md)
- [11 — Add privacy-safe operational telemetry](./11-privacy-safe-observability.md)
- [14 — Make the Room responsive, high-contrast, and product-branded](./14-responsive-product-ui.md)
- [16 — Gate releases with reproducible CI and dependency auditing](./16-reproducible-ci.md)
