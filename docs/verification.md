# Verification contract

One reproducible local and continuous-integration contract gates every
release. The same commands maintainers run locally are exactly what CI runs:
frozen install, lint, strict type checking, unit/integration tests, the
dependency audit gate, the production build, and the deterministic browser
suite.

## Supported runtimes

| Runtime | Pin | Where it is enforced |
| --- | --- | --- |
| Bun | `1.3.14` | `packageManager` and `engines.bun` in `package.json`; `oven-sh/setup-bun` in `.github/workflows/ci.yml` |
| Node | `>=20.9.0` | `engines.node` in `package.json` (Next.js 16 requirement; Bun supplies Node-compatible APIs) |

Bun is the only supported package manager. Install from the frozen lockfile:

```bash
bun install --frozen-lockfile
```

A frozen install fails when `package.json` and `bun.lock` disagree, so the
lockfile can never silently drift from the manifest. Keep `bun.lock`
committed and refresh it deliberately:

```bash
bun install        # refresh the lockfile after a manifest change
```

## Package scripts

| Script | What it runs | Requirement |
| --- | --- | --- |
| `bun run lint` | `eslint` | no lint errors |
| `bun run typecheck` | `tsc --noEmit` (strict) | no type errors |
| `bun run test` | `vitest run` | unit and integration tests pass |
| `bun run test:browser` | Playwright suite (`e2e/`) | deterministic browser journeys pass |
| `bun run test:browser:install` | downloads Chromium | one-time prerequisite for `test:browser` |
| `bun run audit` | dependency audit gate | no unexpected advisories |
| `bun run build` | `next build` | production build succeeds |
| `bun run verify` | lint + typecheck + test + audit + build | the aggregate local gate |
| `bun run verify:full` | `verify` + `test:browser` | the complete gate CI runs |
| `bun run dev` / `bun run start` | Next.js dev server / production server | — |

`verify` is the aggregate command for day-to-day work; it needs no browsers
and no credentials. `verify:full` additionally proves the critical browser
journeys and mirrors what continuous integration runs. The browser suite
needs **no provider credentials and makes no network model calls** — it runs
the real application against a scripted, deterministic generation adapter
(see `docs/browser-tests.md`).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request:

1. `bun install --frozen-lockfile` — reproducible, lockfile-consistent
   install with the pinned Bun runtime.
2. `bun run verify` — lint, strict types, unit/integration tests, the
   dependency audit gate, and the production build.
3. `bunx playwright install --with-deps chromium` — browser install.
4. `bun run test:browser` — the deterministic credential-free browser suite.

CI fails on any lint, type, test, build, lockfile, or unexpected audit
regression. No CI step requires production credentials or makes live
provider calls.

## Dependency audit gate

`bun run audit` runs `bun audit --json` against the frozen lockfile and
classifies every advisory against the recorded exceptions in
`scripts/dependency-audit-exceptions.json`. It exits non-zero when:

- an advisory has **no** recorded exception (a new or reintroduced
  regression), or
- a recorded exception has **passed its expiry** (maintainers must re-review
  and either re-record with a new expiry or fix the advisory).

Exceptions are strict records, never a blanket ignore. Each entry states:

| Field | Meaning |
| --- | --- |
| `package` | package name exactly as reported by `bun audit` |
| `advisory` | GHSA identifier (e.g. `GHSA-866g-f22w-33x8`) |
| `impact` | why the advisory does not affect this product |
| `owner` | who is accountable for the re-review before expiry |
| `mitigation` | the concrete upgrade/action that removes the exception |
| `expires` | `YYYY-MM-DD`; the gate fails after this day |

`package.json` pins the transitive `compression` dependency to patched
`1.8.2` for the advisory
[`GHSA-vc2v-76pw-4v95`](https://github.com/advisories/GHSA-vc2v-76pw-4v95).
`serve@14.2.6` requires exact `1.8.1` and has no patched parent release;
the upstream patch preserves the middleware API, and local HTTP checks
confirmed gzip, identity, and HEAD behavior. This is a real dependency
upgrade, not an audit exception. Remove the override once `serve` uses a
patched `compression` release.

### Current exceptions

There are no active exceptions. The former
[`GHSA-866g-f22w-33x8`](https://github.com/advisories/GHSA-866g-f22w-33x8)
entry was stale: the lockfile maps Mastra's `provider-utils-v5` alias to the
npm package `@ai-sdk/provider-utils@3.0.30`. The advisory affects the v3
package below `3.0.28`, so `3.0.30` is outside the affected range. The alias
suffix identifies the provider protocol generation, not the package's major
version. Do not override Mastra's alias.
