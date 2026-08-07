# Domain Docs

The Discussion Room domain vocabulary and architecture are defined in
[docs/architecture.md](../architecture.md) (the canonical glossary and
system design) and the safety rules in [docs/safety.md](../safety.md).

Use the domain terms — Discussion, Discussion Topic, Turn, Message, Speaker,
Supporter, Opponent, Transcript, Discussion Runner, Discussion Policy —
consistently in specs, tickets, tests, implementation plans, and UI copy
(PRD Implementation Decision 1). Surface any proposed change that
contradicts the documented architecture or safety contract instead of
silently overriding it.

There is no separate ADR directory; the production-hardening issue list
under `.scratch/production-hardening/` records the architectural decisions
and their rationale.
