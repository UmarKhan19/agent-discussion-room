# Gate releases with reproducible CI and dependency auditing

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Give maintainers one reproducible local and continuous-integration verification contract that catches lint, type, behavior, browser, build, and dependency-security regressions before release.

## Acceptance criteria

- [ ] Documented Bun package scripts provide lint, strict type checking, unit/integration tests, critical browser tests, production build, dependency audit, and an aggregate verification command.
- [ ] The repository's supported development and build scripts remain the only documented way to invoke Mastra-integrated application workflows.
- [ ] CI installs with the frozen Bun lockfile and runs the same verification scripts used locally.
- [ ] Required tests make no live provider calls and require no production credentials.
- [ ] Direct dependencies not imported or deliberately selected for Discussion, storage, testing, build, or operations are removed, and the lockfile is refreshed reproducibly.
- [ ] Current dependency advisories are fixed where possible; any temporary exception records affected package/advisory, impact analysis, owner, mitigation, and expiry instead of using a blanket ignore.
- [ ] Supported Bun and Node/runtime expectations are pinned consistently for local and CI use.
- [ ] A clean checkout passes the complete verification command and CI fails on any required lint, type, test, build, lockfile, or unexcepted audit regression.

## Blocked by

- [02 — Remove the Weather sample from the production runtime](./02-remove-weather-sample.md)
- [11 — Add privacy-safe operational telemetry](./11-privacy-safe-observability.md)
- [15 — Prove critical paths in deterministic browser tests](./15-deterministic-browser-tests.md)
