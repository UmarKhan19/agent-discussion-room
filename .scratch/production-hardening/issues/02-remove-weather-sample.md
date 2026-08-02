# Remove the Weather sample from the production runtime

Status: done
## Parent

[Production hardening PRD](../PRD.md)

## What to build

Keep the production runtime focused on the Discussion Room by removing unrelated Weather sample functionality and its unnecessary network, model, storage, and dependency surface.

## Acceptance criteria

- [ ] The Weather agent, tool, and workflow are absent from the production Mastra registry and cannot be invoked through the running product.
- [ ] Weather-only source code, raw streamed-output behavior, and Open-Meteo integration are removed rather than left as dormant production resources.
- [ ] Direct dependencies used only by the removed Weather sample are removed when no approved Discussion or production-storage use remains.
- [ ] All remaining agents, workflows, tools, and scorers are registered in the central Mastra composition root.
- [ ] Lint, strict type checking, tests, and production build pass after cleanup.

## Blocked by

- None — can start immediately.

## Comments

- Sandcastle completed this ticket on branch `sandcastle/ticket/production-hardening-02/2026-08-02t12-37-43-251z-7ba6905b-a2`. Verified: `bun install --frozen-lockfile` (exit 0), `bun run lint` (exit 0), `bunx tsc --noEmit` (exit 0), `bun run test` (exit 0), `bun run build` (exit 0).
