# Generate and display the first policy-compliant Turn

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Advance an owned Discussion through its first complete Turn while the server chooses the Speaker, constructs context and instructions, enforces policy, and persists the resulting Message. The participant should see a clearly attributed Supporter Turn without being able to forge Speaker or Transcript state.

## Acceptance criteria

- [ ] A next-Turn request identifies only the owned Discussion and a stable request identity; it cannot supply the Speaker, Transcript, Turn count, prompt, or safety outcome.
- [ ] The Discussion Runner is the only authority that transitions the Discussion into and out of generating state and chooses Supporter for the first Turn.
- [ ] The Runner uses the injected generation seam and keeps prompt construction hidden from transport and UI callers.
- [ ] Independent output Discussion Policy blocks disallowed generated advocacy even when the deterministic fake deliberately violates policy.
- [ ] A blocked, failed, cancelled, or incomplete generation never enters the Transcript.
- [ ] A successful Turn persists one UUID-string Message with its Speaker, content, timestamp, Turn position, and minimal generation metadata.
- [ ] The response and subsequent read expose runtime-validated public state without provider stack traces, credentials, or internal prompt details.
- [ ] The interface shows a generation indicator followed by the first Message with a visible Supporter label that does not rely only on color or alignment.
- [ ] HTTP behavior tests cover successful generation, output-policy rejection, ownership denial, invalid state, and response-contract validation using the deterministic fake.

## Blocked by

- [03 — Start and read a safe, session-owned Discussion](./03-start-session-owned-discussion.md)
