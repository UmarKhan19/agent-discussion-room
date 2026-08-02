import { Output, run } from "@ai-hero/sandcastle";
import { z } from "zod";
import { branchSha } from "./git";
import { dockerSandbox, piAgent } from "./provider";
import { reviewPrompt } from "./prompts";
import type { Ticket } from "./tickets";

export const ReviewSchema = z
  .object({
    decision: z.enum(["approve", "changes_requested"]),
    summary: z.string().min(1),
    findings: z.array(
      z.object({
        severity: z.enum(["blocking", "warning", "note"]),
        file: z.string().nullable(),
        line: z.number().int().positive().nullable(),
        message: z.string().min(1),
      }),
    ),
  })
  .superRefine((review, context) => {
    if (
      review.decision === "approve" &&
      review.findings.some((finding) => finding.severity === "blocking")
    ) {
      context.addIssue({
        code: "custom",
        message: "A review with blocking findings cannot approve integration",
        path: ["decision"],
      });
    }
  });

export type TicketReview = z.infer<typeof ReviewSchema>;

const branchPart = (value: string) =>
  value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

export const reviewTicket = async (options: {
  repoRoot: string;
  ticket: Ticket;
  parentPrd: string;
  baseSha: string;
  candidateSha: string;
  authPath: string;
  runId: string;
  attempt: number;
}): Promise<TicketReview> => {
  const reviewBranch = `sandcastle/review/${branchPart(options.ticket.id)}/${branchPart(options.runId)}-a${options.attempt}`;
  const result = await run({
    cwd: options.repoRoot,
    name: `review-${options.ticket.id}`,
    agent: piAgent(),
    sandbox: dockerSandbox(options.authPath),
    branchStrategy: {
      type: "branch",
      branch: reviewBranch,
      baseBranch: options.candidateSha,
    },
    prompt: reviewPrompt(options.ticket, options.parentPrd, options.baseSha),
    maxIterations: 1,
    idleTimeoutSeconds: 600,
    completionSignal: "</review>",
    logging: {
      type: "file",
      path: `.sandcastle/logs/${branchPart(options.runId)}-${branchPart(options.ticket.id)}-review.log`,
    },
    output: Output.object({
      tag: "review",
      schema: ReviewSchema,
      maxRetries: 1,
    }),
  });

  if (result.commits.length > 0 || result.preservedWorktreePath) {
    throw new Error(
      `Reviewer mutated its supposedly read-only branch ${result.branch}`,
    );
  }
  const reviewSha = await branchSha(options.repoRoot, result.branch);
  if (reviewSha !== options.candidateSha) {
    throw new Error(
      `Reviewer branch moved from candidate ${options.candidateSha} to ${reviewSha}`,
    );
  }

  return result.output;
};
