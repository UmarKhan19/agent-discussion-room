# Enforce model-cost and concurrency budgets

Status: done

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Bound model cost and provider pressure with server-owned Turn, token/output, duration, quota, and concurrency budgets that cannot be raised by a participant and that fail predictably before excess work starts.

## Acceptance criteria

- [x] Turn, recent-context, prompt/input, output-token, and duration ceilings are explicit server configuration with safe defaults and hard maximums.
- [x] The generation adapter receives enforceable output limits and reports usage metadata when the provider makes it available.
- [x] Per-session request or token quotas are checked before generation and updated without double charging replayed or rejected duplicate requests.
- [x] Process/provider concurrency limits bound simultaneous generation across Discussions in addition to the one-generation-per-Discussion rule.
- [x] Budget or quota exhaustion produces stable product errors with retryability or wait guidance and does not call the model when detected in advance.
- [x] The client cannot submit a higher Turn, token, timeout, quota, or concurrency limit than the server allows.
- [x] Timeout and Stop paths share the cancellation boundary and release reserved capacity even under provider failure or late completion.
- [x] Deterministic tests prove each budget boundary, usage accounting, capacity release, client-override rejection, and no duplicate charging under retries.

## Blocked by

- [05 — Continue an alternating Discussion to its Turn limit](./05-complete-bounded-discussion.md)
- [06 — Cancel generation on Stop, disconnect, or timeout](./06-cancel-generation.md)
- [07 — Make Turn requests concurrency-safe and retryable](./07-concurrency-and-retry.md)

## Comments

- Implemented on `main`. Added `src/discussion/budgets.ts` (safe defaults + hard maximums, `DiscussionBudgetSchema`), wired every ceiling through environment configuration in `composition.ts` with loud startup failure for out-of-range values, and enforced them in `DiscussionRunner` (recent-context window and character budget, duration timeout, process-wide capacity semaphore, per-session generation quota charged once per logical request identity) and `MastraDiscussion` (provider `modelSettings.maxOutputTokens`, adapter-enforced output-character ceiling). New stable product errors: `OUTPUT_LIMIT_EXCEEDED` (502), `GENERATION_CAPACITY_EXCEEDED` (503, retryable), `SESSION_QUOTA_EXCEEDED` (429). Verified: `bun run lint` (exit 0), `bun run typecheck` (exit 0), `bun run test` (196 tests passed), and `bun run build` (exit 0).
