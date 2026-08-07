# Make the Room responsive, high-contrast, and product-branded

Status: done

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Make the complete Discussion Room usable and legible on narrow touch screens, at enlarged text sizes, and in light or dark system themes while replacing framework boilerplate with a coherent product identity.

## Acceptance criteria

- [x] The interface is laid out narrow-screen first and keeps Topic, progress, Transcript, status, and controls usable at supported mobile viewport widths.
- [x] Start, Stop, Retry, and Jump to Latest controls have reliable touch targets and do not overlap or become unreachable.
- [x] Text zoom and content reflow do not require page-level horizontal scrolling, including with long Topics and Messages.
- [x] Semantic color tokens provide WCAG AA contrast for body text, status text, controls, focus indicators, and both Speaker treatments in supported light and dark themes.
- [x] Information remains understandable without color, and system theme changes do not make content or controls disappear.
- [x] Typography, spacing, title, description, browser/theme metadata, and participant copy consistently identify the product as the Agent Discussion Room rather than framework starter content.
- [x] Mechanically testable contrast, mobile viewport, touch-target, zoom/reflow, and overflow expectations are covered by automated checks, with any remaining visual checks documented.

## Blocked by

- [12 — Deliver clear lifecycle, error, and recovery UX](./12-lifecycle-recovery-ux.md)
