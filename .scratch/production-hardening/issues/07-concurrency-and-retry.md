# Make Turn requests concurrency-safe and retryable

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Make repeated clicks, network retries, and simultaneous next-Turn requests safe so that one logical request can produce at most one ordered Message, while transient provider failures can be retried without duplication.

## Acceptance criteria

- [ ] At most one model generation may be active for a Discussion at any time.
- [ ] Repeating a completed request identity returns or reconstructs the same logical outcome without a second model call or duplicate Message.
- [ ] Competing request identities during active generation receive a stable conflict response and cannot create parallel or out-of-order Turns.
- [ ] Request identity, lifecycle transition, and Message commit are coordinated so process races cannot pass the one-Turn boundary twice.
- [ ] Provider and adapter failures are normalized into stable product errors with retryability metadata and safe participant-facing copy.
- [ ] Provider stack traces, raw responses, credentials, and unapproved model details are not returned through the public contract.
- [ ] A retry after a transient failure can complete the intended Turn once, while a retry after a committed success cannot generate another Turn.
- [ ] Deterministic concurrency tests cover duplicate requests, competing requests, late results, transient failure followed by retry, and successful-response replay.

## Blocked by

- [04 — Generate and display the first policy-compliant Turn](./04-generate-first-turn.md)
