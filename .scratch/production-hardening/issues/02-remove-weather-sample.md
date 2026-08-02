# Remove the Weather sample from the production runtime

Status: ready-for-agent

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
