# Reject oversized and abusive endpoint traffic

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Protect every public Discussion operation from oversized payloads and abusive request rates using both signed-session and network-level controls, while returning stable guidance before model work or state mutation occurs.

## Acceptance criteria

- [ ] Request body, string, array, identifier, and content-type limits are enforced before expensive parsing, policy checks, storage work, or model generation wherever practical.
- [ ] Oversized or malformed traffic receives a stable 400-series response and cannot create or mutate a Discussion.
- [ ] Per-signed-session rate limits prevent one participant from exhausting endpoint or provider capacity.
- [ ] A separately keyed network-level rate limit provides protection when callers create or discard sessions repeatedly.
- [ ] Rate-limit responses use a stable product error, identify that waiting is appropriate, and expose retry timing when available.
- [ ] Ownership checks remain enforced and rate-limit keys do not expose session secrets or treat a guessable Discussion identifier as authorization.
- [ ] Deterministic tests with a controlled clock prove limits, reset behavior, independent callers, malformed requests, and that blocked traffic never invokes the generator.

## Blocked by

- [03 — Start and read a safe, session-owned Discussion](./03-start-session-owned-discussion.md)
