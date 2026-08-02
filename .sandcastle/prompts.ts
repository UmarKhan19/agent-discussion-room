import type { Ticket } from "./tickets";

export const implementationPrompt = (
  ticket: Ticket,
  parentPrd: string,
  baseSha: string,
) => `You are implementing exactly one local engineering ticket in an isolated Git branch.

# Repository rules

1. Read and obey AGENTS.md and CLAUDE.md before editing.
2. For any Mastra work, load the project-local mastra skill first and verify APIs against installed docs.
3. Keep the change limited to the ticket and its acceptance criteria.
4. Do not modify .sandcastle/, ticket Status lines, or orchestration state.
5. Never read, create, or commit secrets or .env files.
6. Use Bun and the package.json scripts; do not invoke Mastra CLI commands directly.
7. Add deterministic tests for changed behavior where the ticket requires them.
8. Run relevant verification, then commit all intended changes in one or more logical commits.
9. Leave the Git worktree clean. Do not merge or change branches.
10. When complete, end with <promise>COMPLETE</promise>.

# Branch base

${baseSha}

# Ticket: ${ticket.id} — ${ticket.title}

${ticket.body}

# Parent PRD

${parentPrd}
`;

export const verificationFixPrompt = (
  ticket: Ticket,
  failure: string,
) => `Verification for ${ticket.id} failed. Diagnose the root cause, make the smallest ticket-scoped fix, rerun the relevant checks, and commit the fix. Leave the worktree clean. Do not modify .sandcastle/ or ticket status. End with <promise>COMPLETE</promise>.

Verification output:

${failure}
`;

export const reviewPrompt = (
  ticket: Ticket,
  parentPrd: string,
  baseSha: string,
) => `Review the current branch against ticket ${ticket.id} and its parent PRD. This is an independent, read-only review: do not edit files, commit, merge, or change branches.

Inspect the complete diff from ${baseSha} to HEAD. Check every acceptance criterion, correctness, tests, security, repository rules, scope control, and verification claims. A blocking finding means the ticket is not safe to integrate.

Ticket:
${ticket.body}

Parent PRD:
${parentPrd}

Return exactly one JSON object inside the following tag (the opening tag is required literally):
<review>{"decision":"approve","summary":"...","findings":[]}</review>

Each finding must have severity "blocking", "warning", or "note", a nullable file, a nullable positive line, and a concise message. Use decision "changes_requested" whenever any blocking finding exists.
`;

export const reviewFixPrompt = (
  ticket: Ticket,
  review: unknown,
) => `The independent review for ${ticket.id} requested changes. Address every blocking finding without expanding scope, run the relevant checks, commit the fixes, and leave the worktree clean. Do not modify .sandcastle/ or ticket status. End with <promise>COMPLETE</promise>.

Review result:

${JSON.stringify(review, null, 2)}
`;
