# Enforce model-cost and concurrency budgets

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Bound model cost and provider pressure with server-owned Turn, token/output, duration, quota, and concurrency budgets that cannot be raised by a participant and that fail predictably before excess work starts.

## Acceptance criteria

- [ ] Turn, recent-context, prompt/input, output-token, and duration ceilings are explicit server configuration with safe defaults and hard maximums.
- [ ] The generation adapter receives enforceable output limits and reports usage metadata when the provider makes it available.
- [ ] Per-session request or token quotas are checked before generation and updated without double charging replayed or rejected duplicate requests.
- [ ] Process/provider concurrency limits bound simultaneous generation across Discussions in addition to the one-generation-per-Discussion rule.
- [ ] Budget or quota exhaustion produces stable product errors with retryability or wait guidance and does not call the model when detected in advance.
- [ ] The client cannot submit a higher Turn, token, timeout, quota, or concurrency limit than the server allows.
- [ ] Timeout and Stop paths share the cancellation boundary and release reserved capacity even under provider failure or late completion.
- [ ] Deterministic tests prove each budget boundary, usage accounting, capacity release, client-override rejection, and no duplicate charging under retries.

## Blocked by

- [05 — Continue an alternating Discussion to its Turn limit](./05-complete-bounded-discussion.md)
- [06 — Cancel generation on Stop, disconnect, or timeout](./06-cancel-generation.md)
- [07 — Make Turn requests concurrency-safe and retryable](./07-concurrency-and-retry.md)
