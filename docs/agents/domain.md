# Domain Docs

This repository uses a single-context domain documentation layout.

Before exploring domain behavior, read these files when they exist:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

If either is absent, proceed silently. Domain documentation should be created lazily when terminology or architectural decisions are resolved.

Use terminology defined in `CONTEXT.md` consistently in specs, tickets, tests, and implementation plans. Surface any proposed change that contradicts an existing ADR instead of silently overriding it.
