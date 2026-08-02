# Start and read a safe, session-owned Discussion

Status: done

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Let a participant enter a permitted Discussion Topic and explicitly create a server-owned Discussion that only the same signed session can read. Remove the harmful fixed Topic and retire the client-authored Speaker and Transcript contract before any model generation occurs.

## Acceptance criteria

- [ ] The interface presents a labelled Topic control and never starts a Discussion without an explicit participant action.
- [ ] Empty, whitespace-only, malformed, and excessively long Topics are rejected before generation with stable validation errors that explain how to correct the request.
- [ ] Input Discussion Policy rejects configured prohibited categories, including protected-class violence advocacy, genocide advocacy, and extremist praise, with a safe actionable alternative and no model call.
- [ ] A permitted Topic creates a UUID-identified, server-owned Discussion with status, configured Turn limit, Turn count, timestamps, policy outcome, and an empty Transcript.
- [ ] The created Discussion is bound to a signed session; an unrelated session cannot read it, and ownership is not based only on possession of its identifier.
- [ ] External request, response, identifier, error, Topic, Message, and state contracts are runtime-validated with Zod, with TypeScript types inferred from those schemas.
- [ ] The participant can see the active Topic, initial empty state, and `0 / limit` progress after creation.
- [ ] The old endpoint no longer accepts browser-authored Speaker selection or Transcript history.
- [ ] Contract, input-policy, ownership, and participant-visible start behavior are covered with deterministic tests.

## Blocked by

- [01 — Prefactor generation behind a testable Discussion seam](./01-prefactor-generation-seam.md)

## Comments

- Implemented and independently reviewed on `main`. Verified: `bun install --frozen-lockfile` (exit 0), `bun run lint` (exit 0), `bun run typecheck` (exit 0), `bun run test` (57 tests passed), and `bun run build` (exit 0).
