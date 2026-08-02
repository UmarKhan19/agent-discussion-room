import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fastForwardTarget,
  git,
  mergeIntoIntegration,
  reconcileFinalizedTarget,
  tryGit,
} from "../git";

const roots: string[] = [];

const makeRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-git-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Sandcastle Test"]);
  await git(root, ["config", "user.email", "sandcastle@example.com"]);
  await writeFile(join(root, "file.txt"), "base\n");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "Base"]);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("mergeIntoIntegration", () => {
  test("merges the captured verified commit rather than a moved branch ref", async () => {
    const root = await makeRepo();
    const base = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["branch", "integration", base]);
    await git(root, ["checkout", "-b", "ticket"]);
    await writeFile(join(root, "verified.txt"), "verified\n");
    await git(root, ["add", "verified.txt"]);
    await git(root, ["commit", "-m", "Verified ticket"]);
    const verified = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "unreviewed.txt"), "unreviewed\n");
    await git(root, ["add", "unreviewed.txt"]);
    await git(root, ["commit", "-m", "Unreviewed movement"]);
    await git(root, ["checkout", "main"]);

    await mergeIntoIntegration(
      root,
      "integration",
      verified,
      join(root, "runtime"),
    );

    expect(await git(root, ["show", "integration:verified.txt"])).toBe(
      "verified",
    );
    expect(
      (await tryGit(root, ["show", "integration:unreviewed.txt"])).ok,
    ).toBeFalse();
  });
});

describe("reconcileFinalizedTarget", () => {
  test("finishes the safe ref-updated/worktree-old crash window", async () => {
    const root = await makeRepo();
    const base = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "-b", "integration"]);
    await writeFile(join(root, "file.txt"), "integrated\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "Integrated"]);
    const integrated = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "main"]);

    await git(root, [
      "update-ref",
      "refs/heads/main",
      integrated,
      base,
    ]);
    expect(await git(root, ["status", "--porcelain"])).not.toBe("");

    expect(
      await reconcileFinalizedTarget(root, "main", base, integrated),
    ).toBeTrue();
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("integrated\n");
    expect(await git(root, ["status", "--porcelain"])).toBe("");
  });

  test("refuses recovery when the old worktree contains actual user changes", async () => {
    const root = await makeRepo();
    const base = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "-b", "integration"]);
    await writeFile(join(root, "file.txt"), "integrated\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "Integrated"]);
    const integrated = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "main"]);

    await git(root, ["update-ref", "refs/heads/main", integrated, base]);
    await writeFile(join(root, "file.txt"), "user change\n");

    await expect(
      reconcileFinalizedTarget(root, "main", base, integrated),
    ).rejects.toThrow("contains user changes");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("user change\n");
  });
});

describe("fastForwardTarget", () => {
  test("atomically advances the expected ref and synchronizes its clean worktree", async () => {
    const root = await makeRepo();
    const base = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "-b", "integration"]);
    await writeFile(join(root, "file.txt"), "integrated\n");
    await git(root, ["add", "file.txt"]);
    await git(root, ["commit", "-m", "Integrated"]);
    const integrated = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", "main"]);

    await fastForwardTarget(root, "main", base, integrated);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(integrated);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("integrated\n");
    expect(await git(root, ["status", "--porcelain"])).toBe("");
  });

  test("refuses to advance when the target has moved", async () => {
    const root = await makeRepo();
    const base = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["branch", "integration", base]);
    await writeFile(join(root, "other.txt"), "external\n");
    await git(root, ["add", "other.txt"]);
    await git(root, ["commit", "-m", "External"]);
    const moved = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      fastForwardTarget(root, "main", base, base),
    ).rejects.toThrow("moved");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(moved);
  });
});
