# Harden Agent Discussion Room for Safe, Bounded, Production-Ready Discussions

Status: ready-for-agent

## Problem Statement

The Agent Discussion Room demonstrates a simple two-agent discussion, but a participant or operator cannot currently trust it as a safe, reliable, accessible, or production-ready product. The application contains a harmful fixed Discussion Topic, can instruct a Speaker to advocate disallowed violence, trusts client-authored Transcript data, and can generate Turns indefinitely without a limit, timeout, cancellation path, quota, or effective Stop behavior.

The transport contract is not runtime-validated, the client and server disagree about Message identity, recent Transcript selection is incorrect, durable storage is not configured, and operational telemetry does not yet have a clear privacy or retention policy. A participant receives no useful loading, completion, or recovery feedback, while keyboard, screen-reader, low-vision, and mobile users encounter significant usability barriers.

Maintainers also lack automated tests, continuous integration, accurate setup documentation, an explicit environment contract, and a focused production registry. Unrelated Weather sample resources increase the runtime and dependency surface without contributing to the Discussion Room product.

## Solution

Deliver a production-hardening pass centered on a single server-owned Discussion interface. A participant will submit a permitted Discussion Topic, start a bounded Discussion, observe clearly identified Supporter and Opponent Turns, stop an in-progress generation promptly, recover from actionable errors, and receive an explicit completion state.

The server will own the Discussion state, Speaker order, Transcript, context window, safety policy, budgets, concurrency rules, and lifecycle. Runtime schemas will validate every external request and response. Input and output policy enforcement will prevent disallowed advocacy, while rate limits, payload limits, generation timeouts, cancellation, and quotas will control abuse and cost.

The implementation will use explicit production storage, privacy-safe structured observability, an accessible responsive interface, automated behavior-focused tests, continuous integration, reproducible dependency management, and accurate operational documentation. Unrelated Weather sample functionality will be removed from the production registry and dependency graph.

## User Stories

1. As a discussion participant, I want to enter a Discussion Topic, so that I can choose what the agents discuss.
2. As a discussion participant, I want empty or excessively long Topics rejected before generation, so that mistakes are easy to correct.
3. As a discussion participant, I want prohibited Topics rejected safely, so that the product does not generate advocacy for protected-class violence or other disallowed harm.
4. As a discussion participant, I want a blocked Topic response to explain what I can change, so that I can submit an acceptable alternative.
5. As a discussion participant, I want to start a Discussion explicitly, so that generation never begins without my action.
6. As a discussion participant, I want the active Topic displayed clearly, so that I always know what the agents are discussing.
7. As a discussion participant, I want each Turn visibly attributed to the Supporter or Opponent, so that I can follow the exchange without relying on color or alignment.
8. As a discussion participant, I want the server to choose the next Speaker, so that the Discussion order cannot be forged or corrupted by the browser.
9. As a discussion participant, I want each Speaker to respond to recent relevant Turns, so that the Discussion remains coherent.
10. As a discussion participant, I want the Discussion to have a finite Turn limit, so that it reaches a predictable completion state.
11. As a discussion participant, I want to see the current Turn count and configured limit, so that I understand the remaining scope.
12. As a discussion participant, I want to stop an active Discussion, so that I remain in control of model generation and cost.
13. As a discussion participant, I want Stop to cancel the in-flight generation, so that no additional Message appears after I stop.
14. As a discussion participant, I want a stopped Discussion to show a clear terminal state, so that I know the action succeeded.
15. As a discussion participant, I want to start a fresh Discussion after stopping or completing one, so that stale state does not leak into the next Topic.
16. As a discussion participant, I want a visible generation indicator, so that I know the system is working.
17. As a discussion participant, I want actionable error messages, so that I know whether to retry, edit the Topic, or wait.
18. As a discussion participant, I want a safe Retry action for transient failures, so that I can recover without duplicating a successful Turn.
19. As a discussion participant, I want duplicate requests handled idempotently or rejected safely, so that repeated clicks do not create duplicate Messages.
20. As a discussion participant, I want long model output to wrap and preserve paragraph breaks, so that it remains readable.
21. As a discussion participant, I want new Messages to follow my reading position respectfully, so that automatic scrolling does not pull me away from earlier Turns.
22. As a discussion participant, I want a “Jump to Latest” affordance when I am reading older Turns, so that I can return to the active exchange intentionally.
23. As a mobile participant, I want the full Discussion usable on a narrow screen, so that controls and Messages are not crushed by desktop spacing.
24. As a touch user, I want controls with sufficiently large targets, so that starting, stopping, and retrying are reliable.
25. As a keyboard user, I want all controls reachable with visible focus, so that I can operate the Discussion without a pointer.
26. As a screen-reader user, I want new Turns and lifecycle status changes announced appropriately, so that asynchronous updates are understandable.
27. As a screen-reader user, I want the Transcript represented as a semantic conversation log, so that Speaker and Message relationships are clear.
28. As a low-vision participant, I want text and controls to meet WCAG AA contrast, so that the interface remains legible in light and dark system themes.
29. As a participant using text zoom, I want the layout and content to reflow without horizontal scrolling, so that enlarged text remains usable.
30. As a privacy-conscious participant, I want my Topic and Transcript excluded from unnecessary logs and exports, so that discussion content is not retained without purpose.
31. As an anonymous participant, I want my Discussion inaccessible to unrelated sessions, so that an unguessable identifier alone does not become the only authorization control.
32. As an application operator, I want per-session and network-level rate limits, so that one caller cannot exhaust provider capacity.
33. As an application operator, I want maximum Turn, token, payload, duration, and concurrency budgets, so that model cost is bounded.
34. As an application operator, I want generation to stop when the client disconnects or the timeout expires, so that abandoned work does not continue consuming resources.
35. As an application operator, I want production startup to fail clearly when required credentials or durable storage are missing, so that unsafe fallback behavior is not deployed silently.
36. As an application operator, I want structured request identifiers, latency, result, model, and usage metadata, so that failures and cost can be investigated without logging raw conversations.
37. As an application operator, I want an explicit trace retention and export policy, so that observability does not create an undocumented privacy risk.
38. As an application operator, I want dependency vulnerability checks in continuous integration, so that known advisories are surfaced before release.
39. As a maintainer, I want runtime contracts to generate their TypeScript types, so that compile-time and wire-format definitions cannot drift independently.
40. As a maintainer, I want one Discussion Runner to own ordering, policy, budgets, and state transitions, so that core invariants are not duplicated between browser and route code.
41. As a maintainer, I want prompt construction hidden behind the Discussion interface, so that transport and UI callers do not need to understand model instructions.
42. As a maintainer, I want a bounded recent Transcript window, so that coherence is maintained without unbounded token growth.
43. As a maintainer, I want provider and model failures translated into stable product errors, so that provider-specific details do not leak through the interface.
44. As a maintainer, I want model generation replaceable by a deterministic fake in tests, so that lifecycle behavior can be verified without live provider calls.
45. As a maintainer, I want input and output policy enforcement tested independently of model compliance, so that safety does not rely only on instructions.
46. As a maintainer, I want persisted Discussion state to survive an application restart, so that production behavior matches the durability claim.
47. As a maintainer, I want only product-relevant agents and resources in the production registry, so that startup and configuration remain focused.
48. As a maintainer, I want unrelated Weather sample resources removed from the production dependency graph, so that unused models, storage, tools, and network integrations do not increase risk.
49. As a maintainer, I want lint, type checking, tests, build, and security audit available through documented package scripts, so that local and CI verification are consistent.
50. As a maintainer, I want a frozen lockfile install in CI, so that dependency resolution is reproducible.
51. As a new contributor, I want accurate setup and environment documentation, so that I can run the product without reverse-engineering provider requirements.
52. As a new contributor, I want the product architecture and domain terms documented, so that Discussion, Topic, Turn, Speaker, Transcript, and Discussion Runner have consistent meanings.
53. As a new contributor, I want repository instructions and resource-registration conventions enforced, so that new Mastra resources remain discoverable.
54. As a product owner, I want the interface metadata and copy to describe the Discussion Room instead of framework boilerplate, so that the product presents a coherent identity.
55. As a product owner, I want completion and safety behavior documented as product rules, so that future changes do not accidentally restore unbounded or harmful generation.

## Implementation Decisions

1. The domain vocabulary for this effort is Discussion, Discussion Topic, Turn, Message, Speaker, Supporter, Opponent, Transcript, Discussion Runner, and Discussion Policy. These terms will be used consistently across interfaces, tests, documentation, and UI copy.
2. The primary product seam will be a server-owned Discussion HTTP interface. Browser code will not be authoritative for Speaker selection, Transcript history, Turn count, safety state, or completion state.
3. Starting a Discussion will create a server-owned Discussion resource associated with the current signed session and return its identifier, current status, configured Turn limit, and initial empty Transcript.
4. Requesting the next Turn will identify only the Discussion and request identity. The server will derive the Speaker, recent Transcript, model instructions, policy checks, and budget checks.
5. Reading a Discussion will return its public state and ordered Messages only to the session that owns it.
6. Stopping a Discussion will persist a terminal stopped state and propagate cancellation to an active model generation.
7. A Discussion will support the states idle, generating, completed, stopped, and failed. Only transitions defined by the Discussion Runner will be permitted.
8. One generation may be active for a Discussion at a time. Concurrent next-Turn requests will be made idempotent where a stable request key is available or rejected with a stable conflict response.
9. A Discussion will default to a finite 12-Turn budget. The hard maximum will remain server-controlled and may be lowered through environment configuration; the client may not raise it beyond the server maximum.
10. Model context will use a bounded recent Transcript window. The current default will retain the most recent eight completed Turns, with server-side character or token limits applied before generation.
11. Runtime contracts will be defined with Zod and TypeScript types will be inferred from those schemas. Message identifiers will be UUID strings.
12. Topic, Message, array, and request-body limits will be enforced before model generation. Validation failures will use stable 400-series error responses rather than generic internal errors.
13. Input Discussion Policy and output Discussion Policy checks will be independent of the debate agents. Agent instructions will reinforce policy but will not be treated as the enforcement mechanism.
14. Discussion Policy will reject advocacy of protected-class violence, genocide, extremist praise, and other configured disallowed categories while returning a safe, actionable explanation.
15. The Supporter and Opponent roles will remain available only for permitted Topics. Neither role may override Discussion Policy to satisfy its assigned position.
16. Generation will combine client-disconnect cancellation, explicit Stop cancellation, and a server-controlled hard timeout. Cancellation will be reported as stopped or timed out rather than as an opaque provider failure.
17. The public endpoint will use signed session ownership, payload limits, per-session and network-level rate limits, bounded concurrency, and configurable request or token quotas. A full user-account system is not required.
18. Provider errors will be normalized into stable product errors with retryability metadata. Provider stack traces, credentials, and internal model details will not be returned to participants.
19. The first hardening release will retain complete-response JSON generation rather than introducing token-by-token streaming. Correct lifecycle and cancellation behavior take priority over streaming complexity.
20. The Discussion Runner will accept model generation as a dependency rather than constructing it internally. Production will use a Mastra adapter; tests will use deterministic fakes through the same seam.
21. Mastra agents, workflows, tools, and scorers that remain part of the product will continue to be registered in the central Mastra composition root.
22. Production will configure an explicit durable storage adapter. In-memory storage may be used only in development and must not be an implicit production fallback.
23. Discussion persistence will store ownership, Topic, ordered Messages, status, Turn count, timestamps, policy outcome, and minimal generation metadata. Raw provider traces will not be the system of record.
24. Structured observability will capture request identity, duration, outcome, selected model, usage metadata when available, cancellation reason, and error classification. Raw Topics, Transcripts, and model output will not be logged by default.
25. External observability export will be conditional on explicit configuration and documented retention/privacy behavior. Secret redaction remains required but is not considered sufficient conversation redaction.
26. The interface will provide a labelled Topic control, explicit Start and Stop actions, Turn progress, empty, generating, completed, stopped, error, and retry states.
27. The Transcript will use semantic ordered log structure with visible Speaker labels. New status and Message additions will be announced without causing the entire Transcript to be re-read.
28. Responsive styles will begin from narrow screens, maintain minimum touch-target sizes, allow text reflow and long-content wrapping, and add larger spacing only at wider breakpoints.
29. Theme colors will use coherent semantic tokens and meet WCAG AA contrast. Product metadata, browser theme metadata, typography, and framework boilerplate will be aligned with the Discussion Room identity.
30. Automatic scrolling will occur only when the participant is already near the newest Message. Otherwise the interface will expose an explicit Jump to Latest action.
31. The unrelated Weather agent, tool, workflow, raw output logging, and unused Weather-specific production dependencies will be removed from the production registry and runtime. Building a production Weather feature is not part of this effort.
32. Required environment variables will be validated at startup and documented in a tracked example environment file. Package-manager and supported runtime versions will be pinned.
33. Package scripts will provide lint, type checking, tests, build, and an aggregate verification command. Existing project scripts remain the supported way to run development and production builds.
34. Continuous integration will use a frozen Bun lockfile and run lint, type checking, tests, production build, and dependency audit. Unfixable transitive advisories require an explicit time-bounded exception rather than a blanket ignore.
35. Direct dependencies that are neither imported nor selected for durable storage will be removed. Mastra upgrades will be validated against the installed-version documentation and the complete verification pipeline.
36. Contributor documentation will describe product behavior, architecture, environment variables, safety rules, storage, observability/privacy, development commands, testing, deployment, and known limitations.

## Testing Decisions

1. A good test will exercise externally visible behavior and domain invariants through the highest useful seam. Tests will not assert private helper calls, internal prompt formatting, CSS implementation details, or Mastra internals.
2. The primary test seam will be the server-owned Discussion HTTP interface backed by a deterministic fake model-generation adapter. This single seam will cover validation, policy, Speaker ordering, context limits, lifecycle, persistence, errors, concurrency, cancellation, and completion wherever practical.
3. Contract tests will verify accepted and rejected Topic, identifier, payload, ownership, and state-transition cases, including stable HTTP status and error envelopes.
4. Discussion behavior tests will verify that Supporter and Opponent alternate under server control, only completed Turns enter the Transcript, the recent context remains bounded, and the 12-Turn default reaches completed state.
5. Safety tests will use a table of permitted and prohibited Topics and model outputs. They will prove that enforcement succeeds even when the fake model attempts to violate policy.
6. Cancellation tests will prove that explicit Stop, client disconnect, and timeout abort active generation and prevent a late Message from being persisted or returned.
7. Concurrency tests will prove that simultaneous next-Turn requests cannot generate duplicate or out-of-order Messages.
8. Ownership tests will prove that one signed session cannot read, advance, or stop another session’s Discussion.
9. Persistence tests will create a Discussion, reconstruct the application composition around the same durable test store, and verify that state and ordered Messages survive restart.
10. Observability tests will verify structured metadata and confirm that Topic, Transcript, output, and credentials are absent from default logs and exported spans.
11. Browser-level tests will cover entering a Topic, starting, observing attributed Turns, stopping during generation, retrying a transient failure, reaching completion, and starting a fresh Discussion.
12. Accessibility tests will verify labelled controls, keyboard operation, focus visibility, status announcements, semantic Transcript structure, contrast rules where mechanically testable, zoom/reflow, and mobile viewport usability.
13. Component tests may cover rendering edge cases such as empty state, long content, paragraph preservation, error copy, and Jump to Latest behavior, but they will assert participant-visible behavior rather than utility-class strings.
14. Provider integration tests will be opt-in and credential-gated. The required CI suite will not make live model calls or depend on provider availability.
15. The repository has no existing automated test prior art. The new suite will establish conventions using Vitest for domain and HTTP behavior, React Testing Library for focused UI behavior, and Playwright for a minimal critical-path browser suite.
16. Continuous integration will run the same package scripts documented for local development and will fail on lint, type, test, or build regressions.
17. Dependency audit results will be recorded by CI. A failing advisory may be temporarily excepted only with documented impact analysis, owner, and expiry.

## Out of Scope

- Adding additional debate roles, arbitrary agent teams, voting, judging, or consensus workflows.
- Token-by-token streaming, WebSocket transport, or live collaborative viewing.
- A full user-account, subscription, billing, or payment system.
- Building Weather into a production product feature; Weather sample resources are removed or isolated instead.
- Model fine-tuning or building a custom moderation model.
- A complete visual rebrand or marketing-site redesign beyond coherent product metadata, responsive behavior, accessibility, and UI-state hardening.
- Long-term analytics dashboards, experimentation infrastructure, or sentiment analysis.
- Internationalization beyond ensuring the implementation does not introduce avoidable layout barriers to future localization.
- Importing or migrating historical Discussion data; no durable production history currently exists.
- Guaranteeing that every model response is factually correct. The scope covers policy, reliability, limits, and transparent failure behavior.

## Further Notes

- The current baseline passes lint, strict TypeScript checking, and a production build. These checks are necessary but do not cover the confirmed runtime and product risks.
- The production build currently reports that Mastra falls back to non-durable in-memory storage. Production completion requires removing that warning through explicit configuration.
- The current dependency audit reports five transitive advisories: three high, one moderate, and one low. Upgrades or documented temporary mitigations are required before release.
- No existing test suite or continuous-integration configuration is available as prior art.
- No domain glossary or ADR currently defines the Discussion domain, so this spec establishes the initial vocabulary without creating a separate architectural decision record.
- The effort should be delivered incrementally in this order: safety and contracts; lifecycle and endpoint protection; Discussion Runner and persistence; tests and CI; accessible UI; observability, dependency, documentation, and sample cleanup.
- Mastra APIs must be verified against the installed package documentation and types immediately before implementation because framework APIs change frequently.
