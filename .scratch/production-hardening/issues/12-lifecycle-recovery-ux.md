# Deliver clear lifecycle, error, and recovery UX

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Make every Discussion lifecycle and recovery state understandable and actionable so participants know when work is happening, when it has ended, and whether they should retry, edit the Topic, wait, stop, or start fresh.

## Acceptance criteria

- [ ] Empty, ready, generating, completed, stopped, and failed states have distinct visible status and appropriate available actions.
- [ ] Start, Stop, and Retry controls reflect the authoritative server state and prevent accidental duplicate actions while a request is pending.
- [ ] Turn progress and the active Topic remain visible throughout the Discussion.
- [ ] Validation and policy errors direct the participant to edit the Topic; rate-limit and quota errors explain when waiting is appropriate; transient provider errors expose a safe Retry action.
- [ ] Retry preserves the current Discussion and cannot duplicate a successfully committed Turn.
- [ ] Completion and Stop offer a clear fresh-Discussion action that resets Topic, Transcript, progress, errors, and stale request identities.
- [ ] Network loss, malformed server data, ownership loss, conflict, timeout, and non-retryable provider failure use stable fallback copy without leaking internals.
- [ ] Participant-visible component and integration tests cover all states, control availability, double-click protection, retry, and fresh reset.

## Blocked by

- [05 — Continue an alternating Discussion to its Turn limit](./05-complete-bounded-discussion.md)
- [06 — Cancel generation on Stop, disconnect, or timeout](./06-cancel-generation.md)
- [07 — Make Turn requests concurrency-safe and retryable](./07-concurrency-and-retry.md)
- [08 — Reject oversized and abusive endpoint traffic](./08-protect-endpoint-traffic.md)
- [09 — Enforce model-cost and concurrency budgets](./09-enforce-generation-budgets.md)
