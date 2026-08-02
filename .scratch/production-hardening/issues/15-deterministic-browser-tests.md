# Prove critical paths in deterministic browser tests

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Provide a credential-free browser suite that proves the participant's critical Discussion journeys and key accessibility behaviors against deterministic model outcomes instead of live provider availability.

## Acceptance criteria

- [ ] Playwright can run the application with deterministic success, delayed, transient-failure, policy-violating, and cancellation-aware generation behavior without provider credentials or network model calls.
- [ ] The suite covers entering a permitted Topic, explicit Start, active Topic display, attributed alternating Turns, progress, and finite completion.
- [ ] The suite stops during an in-flight generation and proves terminal stopped state with no late Message.
- [ ] The suite retries a transient failure and proves exactly one successful Message is committed.
- [ ] The suite starts a fresh Discussion after both completion and Stop and proves prior Topic, Transcript, state, and request identity do not leak.
- [ ] A separate session cannot read, advance, or stop another session's Discussion through browser-visible flows.
- [ ] Keyboard operation, focus visibility, targeted status announcements, semantic Transcript structure, Jump to Latest, mobile viewport, text zoom/reflow, and long-content rendering are covered at the highest practical seam.
- [ ] Required browser tests are stable, bounded in duration, and leave no live-provider or durable-production data behind.

## Blocked by

- [10 — Persist the complete Discussion lifecycle durably](./10-durable-discussion-storage.md)
- [13 — Make the Transcript accessible and respectful of reading position](./13-accessible-transcript.md)
- [14 — Make the Room responsive, high-contrast, and product-branded](./14-responsive-product-ui.md)
