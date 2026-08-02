import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git";
import type { Ticket } from "./tickets";
import type { VerificationReport } from "./verifier";

export const completeTicketInBranch = async (
  repoRoot: string,
  worktreePath: string,
  ticket: Ticket,
  branch: string,
  verification: VerificationReport,
) => {
  const ticketPath = join(worktreePath, ticket.relativePath);
  let body = await readFile(ticketPath, "utf8");
  if (!/^Status:\s*ready-for-agent\s*$/m.test(body)) {
    throw new Error(
      `Expected ${ticket.relativePath} to remain ready-for-agent before completion`,
    );
  }
  body = body.replace(/^Status:\s*ready-for-agent\s*$/m, "Status: done");

  const commands = verification.commands
    .map((command) => `\`${command.command}\` (exit ${command.exitCode})`)
    .join(", ");
  const comment = `- Sandcastle completed this ticket on branch \`${branch}\`. Verified: ${commands}.`;
  if (/^## Comments\s*$/m.test(body)) {
    body = body.replace(/^## Comments\s*$/m, `## Comments\n\n${comment}`);
  } else {
    body = `${body.trimEnd()}\n\n## Comments\n\n${comment}\n`;
  }

  await writeFile(ticketPath, body);
  await git(repoRoot, ["add", "--", ticket.relativePath], worktreePath);
  await git(repoRoot, ["diff", "--cached", "--check"], worktreePath);
  await git(
    repoRoot,
    ["commit", "-m", `Mark ${ticket.id} as done`],
    worktreePath,
  );
};
