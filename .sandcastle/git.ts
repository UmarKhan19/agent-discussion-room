import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const git = async (
  repoRoot: string,
  args: string[],
  cwd = repoRoot,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `git ${args.join(" ")} failed${detail.stderr ? `:\n${detail.stderr.trim()}` : ""}`,
      { cause: error },
    );
  }
};

export const tryGit = async (
  repoRoot: string,
  args: string[],
  cwd = repoRoot,
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: detail.stdout?.trim() ?? "",
      stderr: detail.stderr?.trim() ?? detail.message,
    };
  }
};

export const assertCleanTarget = async (
  repoRoot: string,
  targetBranch: string,
): Promise<string> => {
  const inside = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new Error(`${repoRoot} is not a Git repository`);

  const branch = await git(repoRoot, ["branch", "--show-current"]);
  if (branch !== targetBranch) {
    throw new Error(`Expected checked-out branch ${targetBranch}, found ${branch}`);
  }

  const dirty = await git(repoRoot, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error(
      `Target worktree must be clean before Sandcastle runs:\n${dirty}`,
    );
  }
  return git(repoRoot, ["rev-parse", "HEAD"]);
};

export const branchExists = async (repoRoot: string, branch: string) =>
  (
    await tryGit(repoRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])
  ).ok;

export const ensureBranch = async (
  repoRoot: string,
  branch: string,
  startPoint: string,
) => {
  if (!(await branchExists(repoRoot, branch))) {
    await git(repoRoot, ["branch", branch, startPoint]);
  }
};

export const branchSha = (repoRoot: string, branch: string) =>
  git(repoRoot, ["rev-parse", branch]);

export const isAncestor = async (
  repoRoot: string,
  ancestor: string,
  descendant: string,
) => (await tryGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant])).ok;

export const changedFiles = async (
  repoRoot: string,
  baseSha: string,
  branch: string,
): Promise<string[]> => {
  const output = await git(repoRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRD",
    `${baseSha}...${branch}`,
  ]);
  return output ? output.split("\n").filter(Boolean).sort() : [];
};

export const assertBranchClean = async (
  repoRoot: string,
  worktreePath: string,
) => {
  const dirty = await git(repoRoot, ["status", "--porcelain"], worktreePath);
  if (dirty) throw new Error(`Agent left uncommitted changes:\n${dirty}`);
};

export const mergeIntoIntegration = async (
  repoRoot: string,
  integrationBranch: string,
  ticketRef: string,
  runtimeRoot: string,
): Promise<void> => {
  const worktreePath = join(runtimeRoot, "integration-worktree");
  await mkdir(dirname(worktreePath), { recursive: true });
  await rm(worktreePath, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"]);
  await git(repoRoot, ["worktree", "add", worktreePath, integrationBranch]);

  try {
    const ancestor = await tryGit(
      repoRoot,
      ["merge-base", "--is-ancestor", ticketRef, "HEAD"],
      worktreePath,
    );
    if (ancestor.ok) return;

    const merged = await tryGit(
      repoRoot,
      ["merge", "--no-ff", "--no-edit", ticketRef],
      worktreePath,
    );
    if (!merged.ok) {
      await tryGit(repoRoot, ["merge", "--abort"], worktreePath);
      throw new Error(
        `Unable to merge ${ticketRef} into ${integrationBranch}:\n${merged.stderr}`,
      );
    }
  } finally {
    const removed = await tryGit(repoRoot, ["worktree", "remove", worktreePath]);
    if (!removed.ok) {
      const forced = await tryGit(repoRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      if (!forced.ok) {
        throw new Error(
          `Integration worktree cleanup failed at ${worktreePath}: ${forced.stderr || removed.stderr}`,
        );
      }
    }
  }
};

export const moveBranchIfUnchanged = async (
  repoRoot: string,
  branch: string,
  targetSha: string,
  expectedCurrentSha: string,
) => {
  await git(repoRoot, [
    "update-ref",
    `refs/heads/${branch}`,
    targetSha,
    expectedCurrentSha,
  ]);
};

export const reconcileFinalizedTarget = async (
  repoRoot: string,
  targetBranch: string,
  expectedOldSha: string,
  verifiedSha: string,
): Promise<boolean> => {
  const branch = await git(repoRoot, ["branch", "--show-current"]);
  if (branch !== targetBranch) return false;
  const currentSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (currentSha !== verifiedSha) return false;

  const status = await git(repoRoot, ["status", "--porcelain"]);
  if (!status) return true;

  const [expectedOldTree, indexTree, untracked] = await Promise.all([
    git(repoRoot, ["rev-parse", `${expectedOldSha}^{tree}`]),
    git(repoRoot, ["write-tree"]),
    git(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const worktreeMatchesIndex = (
    await tryGit(repoRoot, ["diff-files", "--quiet"])
  ).ok;
  if (
    indexTree !== expectedOldTree ||
    !worktreeMatchesIndex ||
    Boolean(untracked)
  ) {
    throw new Error(
      "Target ref reached the verified SHA, but index/worktree contains user changes; refusing automatic recovery",
    );
  }

  const synchronized = await tryGit(repoRoot, [
    "read-tree",
    "-u",
    "-m",
    expectedOldSha,
    verifiedSha,
  ]);
  if (!synchronized.ok) {
    throw new Error(
      `Unable to finish verified target worktree synchronization: ${synchronized.stderr}`,
    );
  }
  const finalStatus = await git(repoRoot, ["status", "--porcelain"]);
  if (finalStatus) {
    throw new Error(
      `Target recovery did not finish cleanly:\n${finalStatus}`,
    );
  }
  return true;
};

export const fastForwardTarget = async (
  repoRoot: string,
  targetBranch: string,
  expectedTargetSha: string,
  verifiedIntegrationSha: string,
) => {
  const branch = await git(repoRoot, ["branch", "--show-current"]);
  if (branch !== targetBranch) {
    throw new Error(`Target branch changed from ${targetBranch} to ${branch}`);
  }
  const currentSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (currentSha !== expectedTargetSha) {
    throw new Error(
      `Target ${targetBranch} moved from ${expectedTargetSha} to ${currentSha}; refusing to integrate`,
    );
  }
  if (!(await isAncestor(repoRoot, expectedTargetSha, verifiedIntegrationSha))) {
    throw new Error(
      `Verified integration ${verifiedIntegrationSha} is not a fast-forward of ${expectedTargetSha}`,
    );
  }
  const dirty = await git(repoRoot, ["status", "--porcelain"]);
  if (dirty) throw new Error("Target worktree became dirty; refusing to integrate");

  const updated = await tryGit(repoRoot, [
    "update-ref",
    `refs/heads/${targetBranch}`,
    verifiedIntegrationSha,
    expectedTargetSha,
  ]);
  if (!updated.ok) {
    throw new Error(
      `Atomic fast-forward of ${targetBranch} failed: ${updated.stderr}`,
    );
  }

  const synchronized = await tryGit(repoRoot, [
    "read-tree",
    "-u",
    "-m",
    expectedTargetSha,
    verifiedIntegrationSha,
  ]);
  if (!synchronized.ok) {
    const rollback = await tryGit(repoRoot, [
      "update-ref",
      `refs/heads/${targetBranch}`,
      expectedTargetSha,
      verifiedIntegrationSha,
    ]);
    throw new Error(
      `Target ref advanced but worktree synchronization failed: ${synchronized.stderr}. ` +
        (rollback.ok
          ? "The ref was rolled back safely."
          : `Automatic ref rollback also failed: ${rollback.stderr}`),
    );
  }

  const finalSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  const finalStatus = await git(repoRoot, ["status", "--porcelain"]);
  if (finalSha !== verifiedIntegrationSha || finalStatus) {
    throw new Error(
      `Target synchronization did not finish cleanly (HEAD ${finalSha}, status ${finalStatus || "clean"})`,
    );
  }
};
