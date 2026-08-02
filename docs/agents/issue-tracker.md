# Issue tracker: Local Markdown

Issues and PRDs for this repo live as Markdown files in `.scratch/`. This repository currently has no configured git remote, so local Markdown is the default tracker. Pull requests are not a request surface.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file
- Dependencies are Markdown links under a required `## Blocked by` heading; use `- None — ...` when there are none
- Comments and conversation history append under a `## Comments` heading
- Sandcastle changes `ready-for-agent` to `done` only on a verified ticket branch; the status reaches `main` with the integration fast-forward

## Publishing

When a skill says “publish to the issue tracker,” create the relevant Markdown file under `.scratch/<feature-slug>/`, creating the directory if needed.

## Fetching

When a skill says “fetch the relevant ticket,” read the referenced file directly.
