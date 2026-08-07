# Responsive, high-contrast, product-branded interface

This document is the **UI contract** for the Discussion Room interface: the
semantic theme tokens, the touch-target and reflow rules, the product
identity metadata, what is verified mechanically, and which visual checks
remain for the browser suite.

## Theme tokens

All colors are **semantic tokens** defined in `src/app/globals.css` as
`light-dark(light, dark)` pairs on `:root` with `color-scheme: light dark`.
There are no per-scheme media queries, so a system theme change re-themes
the whole interface through the tokens and cannot leave content or controls
unstyled. The tokens map into Tailwind utilities (`bg-accent`,
`text-muted`, `border-border`, `bg-surface`, `bg-supporter`, `bg-opponent`,
`text-success`, `text-warning`, `text-error`, …) via `@theme inline`.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `background` | `#ffffff` | `#0a0a0a` | Page background (also `themeColor` metadata) |
| `foreground` | `#18181b` | `#f4f4f5` | Body text |
| `muted` | `#52525b` | `#d4d4d8` | Secondary text, help copy, progress |
| `border` | `#737373` | `#71717a` | Control and panel boundaries |
| `surface` | `#f4f4f5` | `#1c1c1f` | Panels, secondary controls, Transcript |
| `accent` / `accent-foreground` | `#166534` / `#ffffff` | `#22c55e` / `#052e16` | Start and Retry controls |
| `danger` / `danger-foreground` | `#b91c1c` / `#ffffff` | `#f87171` / `#450a0a` | Stop control |
| `supporter` / `supporter-foreground` | `#1d4ed8` / `#ffffff` | `#1e40af` / `#ffffff` | Supporter Messages |
| `opponent` / `opponent-foreground` | `#15803d` / `#ffffff` | `#166534` / `#ffffff` | Opponent Messages |
| `success` | `#15803d` | `#86efac` | Completed status |
| `warning` | `#b45309` | `#fcd34d` | Stopped status |
| `error` | `#b91c1c` | `#fca5a5` | Failure status and alerts |
| `focus` | `#1d4ed8` | `#93c5fd` | Focus indicator outline |

Contrast targets: 4.5:1 for text and filled-control text, 3:1 for
boundaries and the focus indicator, in **both** themes. Speaker identity is
carried by the explicit `Supporter` / `Opponent` headings, never by color
alone.

## Layout and touch rules

- The page shell (`.page-shell`) is `width: 100%` bounded by `max-width:
  56rem` with no minimum width, so content never exceeds the viewport.
- Every primary control (Start, Stop, Retry, Jump to Latest) rides the
  `.control` surface: `min-height: 44px; min-width: 44px`.
- Start, Stop, Retry, and the new-Discussion action also ride
  `.control-block`: full viewport width below the `sm` breakpoint
  (40rem) so they are large and cannot overlap, and content width above it.
- Jump to Latest is an in-scroll overlay; the Transcript adds bottom padding
  (`pb-20`) while it is visible so the newest Message never sits under it.
- Long Topics and Messages ride the `.reflow` surface (`overflow-wrap:
  anywhere`); model output keeps `whitespace-pre-wrap` so paragraph breaks
  survive. Messages are full width on narrow screens and `w-3/4` with
  Speaker alignment from `sm` up.

## Product identity

`src/app/metadata.ts` is the single source of the page identity: title and
application name **Agent Discussion Room**, a product description, light/dark
`themeColor` matching the background tokens, and a `viewport` of
`width=device-width, initial-scale=1, color-scheme: light dark`.
`src/app/icon.svg` is the product icon (replacing the framework favicon),
the unused `create-next-app` assets under `public/` were removed, and the
interface uses a system font stack (`--font-body`) with no framework starter
fonts.

## Automated coverage

| Check | Where |
| --- | --- |
| Token presence and WCAG AA contrast math for every pair, both themes | `src/app/theme.test.ts` |
| No per-scheme media queries; theme handling is token-driven | `src/app/theme.test.ts` |
| `themeColor` metadata stays in sync with the background tokens | `src/app/theme.test.ts` |
| `.control` 44px minimum, `.control-block` narrow/full-width switch, `.reflow` wrapping, `.page-shell` bounds, 2px focus outline | `src/app/theme.test.ts` |
| Title, description, application name, viewport, theme metadata | `src/app/metadata.test.ts` |
| Start, Stop, Retry, and Jump to Latest render on the touch-target surfaces; long Topics ride the reflow surface; page shell is bounded and stacked | `src/app/responsive-ui.test.tsx` |
| Long model output wraps inside the Message container | `src/app/components/transcript.test.tsx` |
| Semantics, labels, announcements, focus, Jump to Latest behavior | `src/app/components/transcript.test.tsx`, `src/app/page.test.tsx` |

## Remaining visual checks (browser suite)

These checks need a real layout engine and belong to the deterministic
browser suite ([issue 15](../.scratch/production-hardening/issues/15-deterministic-browser-tests.md)),
which is blocked on this issue:

- [ ] Render the complete journey at 320px, 375px, and 768px viewport widths
      and assert no page-level horizontal scrollbar appears.
- [ ] At 200% browser zoom, Topics, Messages, status, and controls reflow
      without horizontal scrolling, including a near-limit Topic and long
      unbroken model words.
- [ ] Start, Stop, Retry, and Jump to Latest are tappable within their
      44px minimum target at a touch emulation viewport.
- [ ] Both system themes render every state (empty, ready, generating,
      completed, stopped, failed) with visible text and controls.
- [ ] The focus indicator is visible on every interactive control in both
      themes.
- [ ] Jump to Latest does not cover the newest Message at narrow widths.
