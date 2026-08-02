# Persist the complete Discussion lifecycle durably

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Make production Discussion state survive application restarts through explicit durable storage, while keeping development and test storage intentional and failing startup clearly when production credentials or storage are unsafe or missing.

## Acceptance criteria

- [ ] Production configures an explicit durable storage adapter for both the product composition and any retained Mastra feature that requires storage; there is no silent in-memory production fallback.
- [ ] Persisted Discussion data includes signed-session ownership, Topic, ordered Messages, status, Turn count and limit, timestamps, policy outcome, request identities, and minimal generation metadata needed for lifecycle correctness.
- [ ] Raw provider traces are not used as the Discussion system of record.
- [ ] Reconstructing the application around the same durable test store preserves readable state, ordered Messages, terminal status, idempotent request outcomes, and ownership enforcement.
- [ ] In-memory storage is available only through an explicit development or test configuration.
- [ ] Required session-signing, provider, and durable-storage environment values are runtime-validated at startup; production exits with a clear non-secret error when any required value is absent or invalid.
- [ ] The selected adapter and central Mastra registration follow the installed-version documentation and types, and the production build no longer warns about implicit non-durable storage.
- [ ] Persistence tests cover restart during idle and terminal states and define safe recovery behavior for an interrupted generating state.

## Blocked by

- [05 — Continue an alternating Discussion to its Turn limit](./05-complete-bounded-discussion.md)
- [06 — Cancel generation on Stop, disconnect, or timeout](./06-cancel-generation.md)
- [07 — Make Turn requests concurrency-safe and retryable](./07-concurrency-and-retry.md)
- [09 — Enforce model-cost and concurrency budgets](./09-enforce-generation-budgets.md)
