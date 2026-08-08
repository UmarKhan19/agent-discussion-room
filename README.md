# Agent Discussion Room

A bounded, server-owned debate between a Supporter and an Opponent. A
participant enters a permitted Discussion Topic, explicitly starts a
Discussion, and watches alternating Turns until a finite completion — with
Stop, Retry, and fresh-Discussion controls, durable storage, privacy-safe
telemetry, and a deterministic credential-free test path. Every Discussion
lives at a canonical, reload-safe URL (`/discussions/:id`), and the Start
action is idempotent, so a lost response never creates an orphan.

The server owns the entire Discussion lifecycle: Speaker order, Transcript,
policy, budgets, and state transitions are never trusted to the browser.
See [docs/architecture.md](docs/architecture.md) for the domain vocabulary
and system design.

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| [Bun](https://bun.sh) | `1.3.14` | **Only supported package manager.** Pinned in `package.json` (`packageManager`, `engines.bun`) and enforced in CI. |
| [Node.js](https://nodejs.org) | `>=20.9.0` | `engines.node` in `package.json` (Next.js 16 requirement; Bun supplies Node-compatible APIs). |

## Setup

Install from the frozen lockfile (fails if `package.json` and `bun.lock`
disagree):

```bash
bun install --frozen-lockfile
```

Development runs with **no credentials and no configuration**: the
environment contract (`.env.example`, also documented in
[docs/operations.md](docs/operations.md)) falls back to explicit in-memory
storage, an ephemeral session-signing secret, and no provider key. To
document a local environment, copy the example into `.env.local` (that
file is ignored by git; the example itself is tracked and contains only
safe placeholders, never real secrets):

```bash
cp .env.example .env.local
```

Do not keep the example values in a deployed environment: production
startup **fails loudly** when any required value is absent or invalid, and
never falls back to unsafe defaults. `DISCUSSION_GENERATION_MODE=deterministic`
in the example is a test-only mode (scripted Turns, no provider) and is
rejected in production.

## Development

```bash
bun run dev        # development server on http://localhost:3000
bun run build      # production build
bun run start      # serve the production build
```

Use these package scripts rather than running `mastra dev` / `mastra build`
directly.

## Tests

```bash
bun run test                  # unit and integration tests (no credentials, no network)
bun run test:browser:install  # one-time: download Chromium for the browser suite
bun run test:browser          # deterministic credential-free browser suite
bun run verify                # lint + typecheck + test + dependency audit + build
bun run verify:full           # verify + browser suite (the complete gate CI runs)
```

The browser suite needs **no provider credentials and makes no network model
calls**: it runs the real application against a scripted, deterministic
generation adapter (`DISCUSSION_GENERATION_MODE=deterministic`,
development/test only). See [docs/browser-tests.md](docs/browser-tests.md).

Live provider generation requires a real credential (`OPENCODE_API_KEY`);
that is an opt-in manual verification, never part of the automated suite
(see [docs/deployment.md](docs/deployment.md)).

## Documentation index

| Document | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Domain vocabulary (Discussion, Topic, Turn, Message, Speaker, Supporter, Opponent, Transcript, Runner, Policy), server-owned HTTP interface, signed sessions, state machine, budgets, persistence, Mastra registry |
| [docs/safety.md](docs/safety.md) | Input and output Discussion Policy: what is blocked, how enforcement works, and how participants recover |
| [docs/operations.md](docs/operations.md) | Durable storage, startup failure conditions, rate/quota/concurrency budgets, telemetry fields, export opt-in, retention, redaction |
| [docs/observability-privacy.md](docs/observability-privacy.md) | The operational privacy contract: recorded fields, impossible-to-record content, retention, accountability |
| [docs/verification.md](docs/verification.md) | The verification contract: runtimes, scripts, CI, dependency audit gate and exceptions |
| [docs/deployment.md](docs/deployment.md) | Deployment, reproducible CI, audit exceptions, provider integration testing, production Mastra registry convention |
| [docs/browser-tests.md](docs/browser-tests.md) | The deterministic credential-free browser suite: how it runs, what it covers, maintainer notes |
| [docs/responsive-ui.md](docs/responsive-ui.md) | UI contract: theme tokens, touch targets, reflow, accessibility, product identity |
| [docs/known-limitations.md](docs/known-limitations.md) | Known limitations of the current release |

## Contributing

- Register all agents, tools, workflows, and scorers in
  `src/mastra/index.ts` — the production registry must stay focused on the
  Discussion Room (the registry test `src/mastra/index.test.ts` enforces
  this).
- Use the package scripts above; do not bypass the aggregate verification
  gate.
- Follow the domain vocabulary in [docs/architecture.md](docs/architecture.md)
  in code, tests, issues, and UI copy.
- Review the contributor conventions in `docs/agents/` and `AGENTS.md`
  before starting work.
