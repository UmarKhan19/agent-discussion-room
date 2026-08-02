# Sandcastle ticket automation

This directory contains the project-local harness for implementing `.scratch/<feature>/issues/*.md` tickets with `@ai-hero/sandcastle`.

## Guarantees

- Only `Status: ready-for-agent` tickets are scheduled.
- `## Blocked by` links form a validated acyclic dependency graph.
- Dependency-ready tickets run concurrently up to `SANDCASTLE_MAX_PARALLEL` (default `2`).
- Every ticket uses a distinct named Git branch and Docker worktree; agents never edit host `HEAD` directly.
- Each branch must pass deterministic Bun verification and an independent structured review.
- Parallel branches that changed the same file are rerun sequentially from the latest integration branch.
- Verified branches merge into a temporary integration branch. `main` is fast-forwarded only after full integration verification and only if it has not moved.
- Merge conflicts, failed checks, failed reviews, dirty worktrees, or target movement stop the run without changing `main`.

## Prerequisites

1. Docker must be running.
2. The Sandcastle image must be built.
3. Pi must have an `openai-codex` login in `~/.pi/agent/auth.json`. Run `pi`, then `/login openai-codex` if needed.
4. The checked-out `main` worktree must be clean.

The harness exports a short-lived `openai-codex` bearer token into a temporary `0600`, read-only auth mount for each ticket and removes it after the sandbox closes. It never copies the OAuth refresh token, complete Pi configuration, or project `.env` files. Dependency setup and all deterministic verification run in separate auth-free containers.

The repository and its maintainer-authored tickets remain part of the trust boundary: a coding agent necessarily has model access while editing the repository. Do not run this harness on untrusted forks or unreviewed third-party package scripts. Docker reduces host blast radius, but it is not a credential or network-exfiltration guarantee.

## Commands

```bash
# Build the pinned Bun + Pi image
bun run sandcastle:build

# Validate tickets and print dependency waves; no Docker/model calls
bun run sandcastle:plan

# Implement, verify, review, integrate, and fast-forward main
bun run sandcastle:run

# Resume a failed/aborted run after inspecting its state
bun run sandcastle:resume

# Test parser, scheduler, and conflict planning
bun run test:sandcastle
```

Pass `--feature <slug>` or `--max-parallel <n>` after `--` to override defaults.

## Recovery

Ignored state and event journals live in `.sandcastle/state/`. Ticket and integration branches are deliberately retained as recovery evidence. A resume resets the integration ref to its last persisted verified SHA, resets non-integrated ticket phases to pending, and reruns deterministic verification/review before integration.

The feature lock is conservative: it is never stolen automatically. If an ungraceful process death leaves `.sandcastle/state/<feature>.lock/`, first confirm the recorded PID is gone and inspect the state/integration branch before manually removing that lock directory and running `sandcastle:resume`.

A completed ticket is committed on its ticket branch with `Status: done` and a verification comment. That status reaches `main` only when the verified integration commit is atomically fast-forwarded.
