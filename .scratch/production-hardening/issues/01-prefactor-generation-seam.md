# Prefactor generation behind a testable Discussion seam

Status: done
## Parent

[Production hardening PRD](../PRD.md)

## What to build

Give maintainers one testable Discussion-generation seam before changing product behavior. Production generation should use a Mastra-backed adapter, deterministic tests should use a fake through the same interface, and transport/UI callers should not construct model prompts or depend on provider details.

## Acceptance criteria

- [ ] Model generation is injected through one product-owned interface rather than constructed inside transport code.
- [ ] Production behavior uses the existing Supporter and Opponent Mastra agents through an adapter registered from the central composition root.
- [ ] Prompt construction and provider-specific response handling are hidden behind the Discussion interface.
- [ ] A deterministic fake can produce controlled success, failure, delay, cancellation, and usage outcomes without credentials or network access.
- [ ] Vitest is established with at least one behavior test proving the production and fake implementations satisfy the same generation contract.
- [ ] The refactor does not intentionally change participant-visible behavior, and lint, strict type checking, tests, and production build remain green.

## Blocked by

- None — can start immediately.

## Comments

- Sandcastle completed this ticket on branch `sandcastle/ticket/production-hardening-01/2026-08-02t12-37-43-251z-7ba6905b-a1`. Verified: `bun install --frozen-lockfile` (exit 0), `bun run lint` (exit 0), `bunx tsc --noEmit` (exit 0), `bun run test` (exit 0), `bun run build` (exit 0).
