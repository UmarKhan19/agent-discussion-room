# Make the Transcript accessible and respectful of reading position

Status: ready-for-agent

## Parent

[Production hardening PRD](../PRD.md)

## What to build

Let keyboard, screen-reader, and long-form readers follow the exchange without relying on color, losing focus, having the whole Transcript re-announced, or being pulled away from an older Turn.

## Acceptance criteria

- [ ] The Transcript is represented as a semantic ordered conversation log with a stable relationship between each visible Speaker label and Message.
- [ ] Supporter and Opponent remain distinguishable through explicit text, not only color, alignment, or spatial position.
- [ ] New Messages and lifecycle changes receive targeted screen-reader announcements without re-reading the entire Transcript.
- [ ] Every interactive control is keyboard reachable, has an accessible name, and shows a visible focus indicator.
- [ ] Model output preserves paragraph breaks, wraps long words and links, and does not overflow its Message container.
- [ ] Automatic scrolling occurs only when the participant is already near the newest Message.
- [ ] When the participant is reading older Turns, new content preserves the reading position and exposes an intentional, keyboard-accessible Jump to Latest action.
- [ ] Component and browser tests cover semantic structure, labels, announcements, focus, long content, near-bottom behavior, preserved reading position, and Jump to Latest.

## Blocked by

- [12 — Deliver clear lifecycle, error, and recovery UX](./12-lifecycle-recovery-ux.md)
