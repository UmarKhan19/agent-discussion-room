# Continue an alternating Discussion to its Turn limit

Status: done

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Let an active Discussion continue coherently through server-controlled Supporter and Opponent Turns until it reaches a finite terminal completion state, with visible progress and bounded model context throughout.

## Acceptance criteria

- [ ] The Discussion Runner alternates Supporter and Opponent from persisted server state; the browser cannot skip, repeat, or reorder a Speaker.
- [ ] Each generation receives only the most recent eight completed Turns by default, in the correct order, with server-side character or token limits applied before generation.
- [ ] Failed, blocked, cancelled, or in-flight work is excluded from the Transcript and from subsequent model context.
- [ ] The default Discussion completes after exactly 12 persisted Turns, while a server configuration may lower—but the client may not raise—the hard limit.
- [ ] Public state and UI progress remain consistent as `current Turn / configured limit` after every response.
- [ ] Completion is explicit and terminal; another next-Turn request receives a stable product response and cannot create a thirteenth Message.
- [ ] A participant can start a fresh Discussion after completion without reusing the previous Topic, Transcript, count, request identities, or lifecycle state.
- [ ] Deterministic behavior tests prove alternation, correct recent-Transcript selection, context bounding, completion, terminal-state enforcement, and fresh-start isolation.

## Blocked by

- [04 — Generate and display the first policy-compliant Turn](./04-generate-first-turn.md)

## Comments

- Implemented and independently reviewed on `main`. Verified: `bun run lint` (exit 0), `bun run typecheck` (exit 0), `bun run test` (87 tests passed), and `bun run build` (exit 0).
