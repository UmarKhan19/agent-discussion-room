import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSandbox,
  createWorktree,
  type SandboxRunResult,
} from "@ai-hero/sandcastle";
import { preparePiAuth } from "./auth";
import { config } from "./config";
import {
  planConflictFreeIntegration,
  type TicketBranchResult,
} from "./conflicts";
import {
  assertBranchClean,
  assertCleanTarget,
  branchSha,
  changedFiles,
  ensureBranch,
  fastForwardTarget,
  isAncestor,
  mergeIntoIntegration,
  moveBranchIfUnchanged,
  reconcileFinalizedTarget,
} from "./git";
import { dockerSandbox, piAgent } from "./provider";
import {
  implementationPrompt,
  reviewFixPrompt,
  verificationFixPrompt,
} from "./prompts";
import { reviewTicket, type TicketReview } from "./reviewer";
import {
  planExecutionWaves,
  selectReadyWave,
  type RunTicketStatus,
} from "./scheduler";
import {
  createRunId,
  StateStore,
  stateStatuses,
  type RunState,
  type TicketRunRecord,
} from "./state";
import { completeTicketInBranch } from "./ticket-state";
import { loadTicketGraph, type Ticket, type TicketGraph } from "./tickets";
import {
  formatVerificationFailure,
  verifySandbox,
  type VerificationReport,
} from "./verifier";

interface TicketExecutionResult extends TicketBranchResult {
  ticket: Ticket;
  verification: VerificationReport;
  review: TicketReview;
}

interface RunFeatureOptions {
  feature: string;
  maxParallel?: number;
  resume?: boolean;
}

type Transition = (
  ticket: Ticket,
  status: RunTicketStatus,
  patch?: Partial<TicketRunRecord>,
) => Promise<void>;

const branchPart = (value: string) =>
  value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

const executionBranch = (ticket: Ticket, runId: string, attempt: number) =>
  `sandcastle/ticket/${branchPart(ticket.id)}/${branchPart(runId)}-a${attempt}`;

const logPath = (runId: string, ticket: Ticket, phase: string, attempt: number) =>
  `.sandcastle/logs/${branchPart(runId)}-${branchPart(ticket.id)}-${phase}-a${attempt}.log`;

const readParentPrd = async (ticket: Ticket) => readFile(ticket.parentPath, "utf8");

const assertAgentChangeScope = async (
  baseSha: string,
  ref: string,
  allowedTicketPath?: string,
) => {
  const files = await changedFiles(config.repoRoot, baseSha, ref);
  const forbidden = files.filter(
    (file) =>
      file.startsWith(".sandcastle/") ||
      (file.startsWith(".scratch/") && file !== allowedTicketPath) ||
      (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".env.example")),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Agent modified orchestration, tracker, or secret-bearing paths:\n${forbidden.join("\n")}`,
    );
  }
  return files;
};

const nextAgentRun = async (
  current: SandboxRunResult,
  fallback: () => Promise<SandboxRunResult>,
  prompt: string,
  name: string,
): Promise<SandboxRunResult> => {
  if (current.resume) {
    return current.resume(prompt, {
      name,
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      completionSignal: "<promise>COMPLETE</promise>",
    });
  }
  return fallback();
};

const executeTicket = async (options: {
  ticket: Ticket;
  baseSha: string;
  runId: string;
  attempt: number;
  transition: Transition;
}): Promise<TicketExecutionResult> => {
  const { ticket } = options;
  const branch = executionBranch(ticket, options.runId, options.attempt);
  const parentPrd = await readParentPrd(ticket);
  let auth: Awaited<ReturnType<typeof preparePiAuth>> | undefined;
  let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;

  try {
    await options.transition(ticket, "running", {
      attempt: options.attempt,
      branch,
      baseSha: options.baseSha,
      error: undefined,
    });

    worktree = await createWorktree({
      cwd: config.repoRoot,
      branchStrategy: {
        type: "branch",
        branch,
        baseBranch: options.baseSha,
      },
    });

    const setupSandbox = await worktree.createSandbox({
      sandbox: dockerSandbox(),
    });
    try {
      const install = await setupSandbox.exec("bun install --frozen-lockfile", {
        onLine: (line) => console.log(`[setup ${ticket.id}] ${line}`),
      });
      if (install.exitCode !== 0) {
        throw new Error(
          `Credential-free dependency setup failed for ${ticket.id}: ${install.stderr}`,
        );
      }
    } finally {
      await setupSandbox.close();
    }
    await assertBranchClean(config.repoRoot, worktree.worktreePath);

    auth = await preparePiAuth(config.model);
    sandbox = await worktree.createSandbox({
      sandbox: dockerSandbox(auth.hostPath),
    });

    let agentRun = await sandbox.run({
      name: `implement-${ticket.id}`,
      agent: piAgent(),
      prompt: implementationPrompt(ticket, parentPrd, options.baseSha),
      maxIterations: 1,
      completionSignal: "<promise>COMPLETE</promise>",
      idleTimeoutSeconds: config.idleTimeoutSeconds,
      logging: {
        type: "file",
        path: logPath(options.runId, ticket, "implement", options.attempt),
      },
    });

    if (agentRun.commits.length === 0) {
      throw new Error(`${ticket.id} produced no implementation commit`);
    }

    let lastVerification: VerificationReport | undefined;
    let lastReview: TicketReview | undefined;
    let reviewedCandidateSha: string | undefined;

    for (let round = 0; round <= config.maxFixRounds; round += 1) {
      await options.transition(ticket, "verifying");
      await assertBranchClean(config.repoRoot, sandbox.worktreePath);
      await assertAgentChangeScope(options.baseSha, branch);
      const candidateSha = await branchSha(config.repoRoot, branch);
      lastVerification = await verifyExactRef(branch, candidateSha);
      if (!lastVerification.ok) {
        if (round === config.maxFixRounds) {
          throw new Error(formatVerificationFailure(lastVerification));
        }
        await options.transition(ticket, "fixing");
        await auth.refresh();
        const prompt = verificationFixPrompt(
          ticket,
          formatVerificationFailure(lastVerification),
        );
        agentRun = await nextAgentRun(
          agentRun,
          () =>
            sandbox.run({
              name: `fix-verification-${ticket.id}`,
              agent: piAgent(),
              prompt,
              maxIterations: 1,
              completionSignal: "<promise>COMPLETE</promise>",
              idleTimeoutSeconds: config.idleTimeoutSeconds,
              logging: {
                type: "file",
                path: logPath(
                  options.runId,
                  ticket,
                  `fix-verification-${round + 1}`,
                  options.attempt,
                ),
              },
            }),
          prompt,
          `fix-verification-${ticket.id}`,
        );
        continue;
      }

      const candidateAfterVerification = await branchSha(
        config.repoRoot,
        branch,
      );
      if (candidateAfterVerification !== candidateSha) {
        throw new Error(
          `${branch} moved during verification from ${candidateSha} to ${candidateAfterVerification}`,
        );
      }
      await options.transition(ticket, "reviewing");
      await auth.refresh();
      lastReview = await reviewTicket({
        repoRoot: config.repoRoot,
        ticket,
        parentPrd,
        baseSha: options.baseSha,
        candidateSha,
        authPath: auth.hostPath,
        runId: options.runId,
        attempt: options.attempt * 10 + round,
      });

      if (lastReview.decision === "approve") {
        reviewedCandidateSha = candidateSha;
        break;
      }
      if (round === config.maxFixRounds) {
        throw new Error(
          `${ticket.id} review still requests changes: ${lastReview.summary}`,
        );
      }

      await options.transition(ticket, "fixing");
      await auth.refresh();
      const prompt = reviewFixPrompt(ticket, lastReview);
      agentRun = await nextAgentRun(
        agentRun,
        () =>
          sandbox.run({
            name: `fix-review-${ticket.id}`,
            agent: piAgent(),
            prompt,
            maxIterations: 1,
            completionSignal: "<promise>COMPLETE</promise>",
            idleTimeoutSeconds: config.idleTimeoutSeconds,
            logging: {
              type: "file",
              path: logPath(
                options.runId,
                ticket,
                `fix-review-${round + 1}`,
                options.attempt,
              ),
            },
          }),
        prompt,
        `fix-review-${ticket.id}`,
      );
    }

    if (
      !lastVerification?.ok ||
      !lastReview ||
      lastReview.decision !== "approve" ||
      !reviewedCandidateSha
    ) {
      throw new Error(`${ticket.id} did not reach verified review approval`);
    }

    const currentCandidateSha = await branchSha(config.repoRoot, branch);
    if (currentCandidateSha !== reviewedCandidateSha) {
      throw new Error(
        `${branch} moved after review from ${reviewedCandidateSha} to ${currentCandidateSha}`,
      );
    }
    await completeTicketInBranch(
      config.repoRoot,
      sandbox.worktreePath,
      ticket,
      branch,
      lastVerification,
    );
    await assertBranchClean(config.repoRoot, sandbox.worktreePath);
    const headSha = await branchSha(config.repoRoot, branch);
    await assertAgentChangeScope(
      options.baseSha,
      headSha,
      ticket.relativePath,
    );
    const files = await changedFiles(config.repoRoot, options.baseSha, headSha);
    return {
      ticket,
      ticketId: ticket.id,
      branch,
      baseSha: options.baseSha,
      headSha,
      changedFiles: files,
      verification: lastVerification,
      review: lastReview,
    };
  } catch (error) {
    await options.transition(ticket, "failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    try {
      if (sandbox) await sandbox.close();
    } finally {
      try {
        if (auth) await auth.cleanup();
      } finally {
        if (worktree) await worktree.close();
      }
    }
  }
};

const verifyExactRef = async (
  sourceRef: string,
  expectedSha: string,
): Promise<VerificationReport> => {
  const before = await branchSha(config.repoRoot, sourceRef);
  if (before !== expectedSha) {
    throw new Error(
      `Verified source ${sourceRef} moved from expected ${expectedSha} to ${before}`,
    );
  }
  const verificationBranch = `sandcastle/verify/${expectedSha}`;
  await ensureBranch(config.repoRoot, verificationBranch, expectedSha);
  const verificationBranchSha = await branchSha(
    config.repoRoot,
    verificationBranch,
  );
  if (verificationBranchSha !== expectedSha) {
    throw new Error(
      `Verification branch ${verificationBranch} moved to ${verificationBranchSha}`,
    );
  }
  const sandbox = await createSandbox({
    cwd: config.repoRoot,
    branch: verificationBranch,
    baseBranch: expectedSha,
    sandbox: dockerSandbox(),
  });
  let report: VerificationReport;
  try {
    const sandboxHead = await sandbox.exec("git rev-parse HEAD");
    if (sandboxHead.exitCode !== 0 || sandboxHead.stdout.trim() !== expectedSha) {
      throw new Error(
        `Integration sandbox checked out ${sandboxHead.stdout.trim() || "unknown"}, expected ${expectedSha}`,
      );
    }
    report = await verifySandbox(sandbox);
    await assertBranchClean(config.repoRoot, sandbox.worktreePath);
  } finally {
    await sandbox.close();
  }
  const after = await branchSha(config.repoRoot, sourceRef);
  if (after !== expectedSha) {
    throw new Error(
      `Verified source ${sourceRef} moved during verification from ${expectedSha} to ${after}`,
    );
  }
  return report;
};

const initializeState = async (
  store: StateStore,
  graph: TicketGraph,
  feature: string,
  resume: boolean,
): Promise<RunState> => {
  const existing = await store.load();
  if (
    resume &&
    existing?.verifiedIntegrationSha &&
    existing.targetBranch === config.targetBranch
  ) {
    await reconcileFinalizedTarget(
      config.repoRoot,
      config.targetBranch,
      existing.targetStartSha,
      existing.verifiedIntegrationSha,
    );
  }
  const currentTargetSha = await assertCleanTarget(
    config.repoRoot,
    config.targetBranch,
  );

  if (resume) {
    if (!existing || existing.status === "completed") {
      throw new Error(`No active ${feature} Sandcastle run to resume`);
    }
    if (existing.targetBranch !== config.targetBranch) {
      throw new Error(
        `Stored target ${existing.targetBranch} does not match configured ${config.targetBranch}`,
      );
    }
    const targetAlreadyFinalized =
      Boolean(existing.verifiedIntegrationSha) &&
      currentTargetSha === existing.verifiedIntegrationSha;
    if (
      currentTargetSha !== existing.targetStartSha &&
      !targetAlreadyFinalized
    ) {
      throw new Error(
        `Cannot resume: ${config.targetBranch} moved from ${existing.targetStartSha} to ${currentTargetSha}`,
      );
    }
    if (
      !(await isAncestor(
        config.repoRoot,
        existing.targetStartSha,
        existing.lastIntegratedSha,
      ))
    ) {
      throw new Error(
        `Recorded integration SHA ${existing.lastIntegratedSha} is not based on ${existing.targetStartSha}`,
      );
    }

    await ensureBranch(
      config.repoRoot,
      existing.integrationBranch,
      existing.lastIntegratedSha,
    );
    const integrationCurrent = await branchSha(
      config.repoRoot,
      existing.integrationBranch,
    );
    if (integrationCurrent !== existing.lastIntegratedSha) {
      await moveBranchIfUnchanged(
        config.repoRoot,
        existing.integrationBranch,
        existing.lastIntegratedSha,
        integrationCurrent,
      );
    }

    for (const record of Object.values(existing.tickets)) {
      if (record.status !== "integrated") record.status = "pending";
    }
    existing.status = targetAlreadyFinalized ? "finalizing" : "active";
    await store.save(existing, {
      type: "run-resumed",
      integrationResetFrom: integrationCurrent,
      integrationResetTo: existing.lastIntegratedSha,
      targetAlreadyFinalized,
    });
    return existing;
  }

  if (existing?.status === "active" || existing?.status === "finalizing") {
    throw new Error(
      `An active ${feature} run already exists; use --resume after inspecting ${store.statePath}`,
    );
  }

  const runId = createRunId();
  const integrationBranch = `sandcastle/integration/${branchPart(feature)}/${branchPart(runId)}`;
  await ensureBranch(config.repoRoot, integrationBranch, currentTargetSha);
  const tickets: Record<string, TicketRunRecord> = {};
  for (const ticket of graph.tickets) {
    tickets[ticket.id] = {
      status: ["done", "integrated", "completed"].includes(
        ticket.status.toLowerCase(),
      )
        ? "integrated"
        : "pending",
      attempt: 0,
    };
  }

  const state: RunState = {
    version: 1,
    runId,
    feature,
    status: "active",
    targetBranch: config.targetBranch,
    targetStartSha: currentTargetSha,
    integrationBranch,
    lastIntegratedSha: currentTargetSha,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tickets,
  };
  await store.save(state, { type: "run-started" });
  return state;
};

export const dryRunFeature = async (feature: string, maxParallel: number) => {
  const graph = await loadTicketGraph(config.repoRoot, feature);
  return {
    feature,
    tickets: graph.tickets.map((ticket) => ({
      id: ticket.id,
      status: ticket.status,
      blockedBy: ticket.blockedBy,
    })),
    waves: planExecutionWaves(graph.tickets, maxParallel),
  };
};

export const runFeature = async ({
  feature,
  maxParallel = config.maxParallel,
  resume = false,
}: RunFeatureOptions): Promise<RunState> => {
  const graph = await loadTicketGraph(config.repoRoot, feature);
  const store = new StateStore(join(config.repoRoot, ".sandcastle"), feature);
  const releaseLock = await store.acquire();
  let state: RunState | undefined;
  let saveQueue = Promise.resolve();

  const transition: Transition = (ticket, status, patch = {}) => {
    saveQueue = saveQueue.then(async () => {
      if (!state) throw new Error("Run state has not been initialized");
      const current = state.tickets[ticket.id] ?? { status: "pending", attempt: 0 };
      state.tickets[ticket.id] = { ...current, ...patch, status };
      await store.save(state, {
        type: "ticket-transition",
        ticketId: ticket.id,
        status,
        branch: state.tickets[ticket.id]?.branch,
      });
    });
    return saveQueue;
  };

  const persistIntegration = (
    ticket: Ticket,
    candidate: TicketExecutionResult,
    integrationSha: string,
  ) => {
    saveQueue = saveQueue.then(async () => {
      if (!state) throw new Error("Run state has not been initialized");
      const current = state.tickets[ticket.id] ?? { status: "pending", attempt: 0 };
      state.tickets[ticket.id] = {
        ...current,
        status: "integrated",
        branch: candidate.branch,
        baseSha: candidate.baseSha,
        headSha: candidate.headSha,
        error: undefined,
      };
      state.lastIntegratedSha = integrationSha;
      state.verifiedIntegrationSha = undefined;
      await store.save(state, {
        type: "ticket-integrated",
        ticketId: ticket.id,
        branch: candidate.branch,
        integrationSha,
      });
    });
    return saveQueue;
  };

  try {
    state = await initializeState(store, graph, feature, resume);

    while (true) {
      const statuses = stateStatuses(state);
      const remaining = graph.tickets.filter(
        (ticket) =>
          ticket.status === "ready-for-agent" &&
          statuses[ticket.id] !== "integrated",
      );
      if (remaining.length === 0) break;

      const wave = selectReadyWave(graph.tickets, statuses, maxParallel);
      if (wave.length === 0) {
        throw new Error(
          `No dependency-ready tickets remain. Blocked: ${remaining
            .map((ticket) => ticket.id)
            .sort()
            .join(", ")}`,
        );
      }

      const waveBaseSha = await branchSha(config.repoRoot, state.integrationBranch);
      if (waveBaseSha !== state.lastIntegratedSha) {
        throw new Error(
          `Integration branch moved from persisted ${state.lastIntegratedSha} to ${waveBaseSha}`,
        );
      }
      console.log(`\nWave: ${wave.map((ticket) => ticket.id).join(", ")}`);
      const settled = await Promise.allSettled(
        wave.map((ticket) => {
          const attempt = (state!.tickets[ticket.id]?.attempt ?? 0) + 1;
          return executeTicket({
            ticket,
            baseSha: waveBaseSha,
            runId: state!.runId,
            attempt,
            transition,
          });
        }),
      );
      await saveQueue;

      const successful: TicketExecutionResult[] = [];
      const failures: string[] = [];
      for (const [index, result] of settled.entries()) {
        const ticket = wave[index]!;
        if (result.status === "fulfilled") successful.push(result.value);
        else
          failures.push(
            `${ticket.id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
      }

      const integrationPlan = planConflictFreeIntegration(successful);
      const directIds = new Set(
        integrationPlan.direct.map((result) => result.ticketId),
      );
      const ordered = [...successful].sort((a, b) =>
        a.ticketId.localeCompare(b.ticketId),
      );

      for (const original of ordered) {
        let candidate = original;
        let reruns = 0;
        let requiresRerun = !directIds.has(original.ticketId);

        while (true) {
          if (requiresRerun) {
            if (reruns >= config.maxConflictReruns) {
              throw new Error(
                `${original.ticketId} exceeded conflict rerun limit`,
              );
            }
            reruns += 1;
            const latestBase = await branchSha(
              config.repoRoot,
              state.integrationBranch,
            );
            if (latestBase !== state.lastIntegratedSha) {
              throw new Error(
                `Integration branch moved from persisted ${state.lastIntegratedSha} to ${latestBase}`,
              );
            }
            candidate = await executeTicket({
              ticket: original.ticket,
              baseSha: latestBase,
              runId: state.runId,
              attempt: (state.tickets[original.ticketId]?.attempt ?? 0) + 1,
              transition,
            });
            requiresRerun = false;
          }

          const integrationBefore = await branchSha(
            config.repoRoot,
            state.integrationBranch,
          );
          if (integrationBefore !== state.lastIntegratedSha) {
            throw new Error(
              `Integration branch moved from persisted ${state.lastIntegratedSha} to ${integrationBefore}`,
            );
          }
          const currentCandidateSha = await branchSha(
            config.repoRoot,
            candidate.branch,
          );
          if (currentCandidateSha !== candidate.headSha) {
            throw new Error(
              `${candidate.branch} moved from verified ${candidate.headSha} to ${currentCandidateSha}`,
            );
          }
          try {
            await mergeIntoIntegration(
              config.repoRoot,
              state.integrationBranch,
              candidate.headSha,
              join(config.repoRoot, ".sandcastle", "runtime", state.runId),
            );
          } catch (error) {
            const integrationNow = await branchSha(
              config.repoRoot,
              state.integrationBranch,
            );
            if (integrationNow !== integrationBefore) {
              if (
                !(await isAncestor(
                  config.repoRoot,
                  candidate.headSha,
                  integrationNow,
                ))
              ) {
                throw new Error(
                  `Integration branch moved unexpectedly to ${integrationNow}`,
                  { cause: error },
                );
              }
              await moveBranchIfUnchanged(
                config.repoRoot,
                state.integrationBranch,
                integrationBefore,
                integrationNow,
              );
            }
            console.warn(
              `${original.ticketId} merge conflicted or cleanup failed; rerunning from the latest integration branch`,
            );
            if (reruns >= config.maxConflictReruns) throw error;
            requiresRerun = true;
            continue;
          }

          const integrationAfter = await branchSha(
            config.repoRoot,
            state.integrationBranch,
          );
          try {
            const integrationReport = await verifyExactRef(
              state.integrationBranch,
              integrationAfter,
            );
            if (!integrationReport.ok) {
              throw new Error(formatVerificationFailure(integrationReport));
            }
          } catch (error) {
            await moveBranchIfUnchanged(
              config.repoRoot,
              state.integrationBranch,
              integrationBefore,
              integrationAfter,
            );
            console.warn(
              `${original.ticketId} failed combined integration verification; merge rolled back and ticket will rerun sequentially`,
            );
            if (reruns >= config.maxConflictReruns) throw error;
            requiresRerun = true;
            continue;
          }

          await persistIntegration(
            original.ticket,
            candidate,
            integrationAfter,
          );
          break;
        }
      }

      if (failures.length > 0) {
        throw new Error(`Ticket execution failed:\n${failures.join("\n")}`);
      }
    }

    const verifiedIntegrationSha = await branchSha(
      config.repoRoot,
      state.integrationBranch,
    );
    if (verifiedIntegrationSha !== state.lastIntegratedSha) {
      throw new Error(
        `Integration branch ${verifiedIntegrationSha} does not match persisted ${state.lastIntegratedSha}`,
      );
    }
    const finalVerification = await verifyExactRef(
      state.integrationBranch,
      verifiedIntegrationSha,
    );
    if (!finalVerification.ok) {
      throw new Error(formatVerificationFailure(finalVerification));
    }
    state.verifiedIntegrationSha = verifiedIntegrationSha;
    state.status = "finalizing";
    await store.save(state, {
      type: "finalization-started",
      verifiedIntegrationSha,
    });

    const currentTargetSha = await branchSha(config.repoRoot, state.targetBranch);
    if (currentTargetSha !== verifiedIntegrationSha) {
      await fastForwardTarget(
        config.repoRoot,
        state.targetBranch,
        state.targetStartSha,
        verifiedIntegrationSha,
      );
    }
    state.status = "completed";
    await store.save(state, { type: "run-completed" });
    return state;
  } catch (error) {
    if (state) {
      state.status = "failed";
      await store.save(state, {
        type: "run-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    try {
      await saveQueue;
    } finally {
      await releaseLock();
    }
  }
};
