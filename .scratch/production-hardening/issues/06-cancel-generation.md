# Cancel generation on Stop, disconnect, or timeout

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Keep participants and operators in control by propagating explicit Stop, client disconnect, and hard-timeout cancellation into active model generation, with a clear terminal outcome and no late Message.

## Acceptance criteria

- [ ] The owner can stop a generating Discussion through the public interface, and Stop is unavailable or safely idempotent when no stoppable work exists.
- [ ] Stop persists a terminal stopped state and propagates an abort signal to the active generation rather than only toggling browser state.
- [ ] If the provider or fake resolves after cancellation, its output is discarded and cannot be persisted, returned as a completed Turn, or used as later context.
- [ ] Client disconnect aborts abandoned generation and prevents continued provider work where the adapter supports cancellation.
- [ ] A server-controlled hard timeout aborts generation and returns a stable, distinguishable timeout outcome rather than an opaque provider error.
- [ ] The UI confirms stopped or timed-out terminal state and permits a fresh Discussion without stale state.
- [ ] Deterministic tests prove prompt Stop, disconnect cancellation, timeout cancellation, race-safe late-result rejection, and zero additional Messages after cancellation.

## Blocked by

- [04 — Generate and display the first policy-compliant Turn](./04-generate-first-turn.md)
