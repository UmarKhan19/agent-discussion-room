import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTicketGraph } from "../tickets";

const tempRoots: string[] = [];

const makeRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-tickets-"));
  tempRoots.push(root);
  await mkdir(join(root, ".scratch", "feature", "issues"), {
    recursive: true,
  });
  await writeFile(join(root, ".scratch", "feature", "PRD.md"), "# Feature PRD\n");
  return root;
};

const writeIssue = async (root: string, name: string, content: string) => {
  await writeFile(
    join(root, ".scratch", "feature", "issues", name),
    content,
  );
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("loadTicketGraph", () => {
  test("parses local Markdown tickets and resolves relative blockers", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-foundation.md",
      `# Build the foundation\n\nStatus: ready-for-agent\n\n## Parent\n\n[Feature PRD](../PRD.md)\n\n## What to build\n\nFoundation.\n\n## Blocked by\n\n- None — can start immediately.\n`,
    );
    await writeIssue(
      root,
      "02-dependent.md",
      `# Build the dependent slice\n\nStatus: ready-for-agent\n\n## Parent\n\n[Feature PRD](../PRD.md)\n\n## What to build\n\nDependent.\n\n## Blocked by\n\n- [01 — Build the foundation](./01-foundation.md)\n`,
    );

    const graph = await loadTicketGraph(root, "feature");

    expect(graph.tickets.map((ticket) => ticket.id)).toEqual([
      "feature/01",
      "feature/02",
    ]);
    expect(graph.byId.get("feature/02")?.blockedBy).toEqual(["feature/01"]);
    expect(graph.byId.get("feature/01")?.relativePath).toBe(
      ".scratch/feature/issues/01-foundation.md",
    );
  });

  test("rejects a blocker that does not exist", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-broken.md",
      `# Broken ticket\n\nStatus: ready-for-agent\n\n## Blocked by\n\n- [99 — Missing](./99-missing.md)\n`,
    );

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "unknown blocker",
    );
  });

  test("rejects an empty Blocked by section", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-empty.md",
      `# Empty blockers\n\nStatus: ready-for-agent\n\n## Blocked by\n\n## Comments\n`,
    );

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "must declare either None or at least one blocker",
    );
  });

  test("rejects a parent PRD link outside the selected feature", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-parent.md",
      `# Escaping parent\n\nStatus: ready-for-agent\n\n## Parent\n\n[Outside](../../../outside.md)\n\n## Blocked by\n\n- None — ready.\n`,
    );

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "escapes .scratch/feature",
    );
  });

  test("rejects a symlinked feature directory", async () => {
    const root = await makeRepo();
    const external = await mkdtemp(join(tmpdir(), "sandcastle-external-"));
    tempRoots.push(external);
    await mkdir(join(external, "issues"), { recursive: true });
    await writeFile(join(external, "PRD.md"), "# External\n");
    await rm(join(root, ".scratch", "feature"), { recursive: true });
    await symlink(external, join(root, ".scratch", "feature"));

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "Feature directory must not be a symlink",
    );
  });

  test("rejects feature slugs that could escape the tracker directory", async () => {
    const root = await makeRepo();

    await expect(loadTicketGraph(root, "../feature")).rejects.toThrow(
      "Invalid feature slug",
    );
  });

  test("rejects a completed ticket whose blocker is not completed", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-open.md",
      `# Open blocker\n\nStatus: ready-for-agent\n\n## Blocked by\n\n- None — ready.\n`,
    );
    await writeIssue(
      root,
      "02-done.md",
      `# Invalid completion\n\nStatus: done\n\n## Blocked by\n\n- [01 — Open](./01-open.md)\n`,
    );

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "is done while blocker feature/01 is ready-for-agent",
    );
  });

  test("rejects dependency cycles with a deterministic cycle path", async () => {
    const root = await makeRepo();
    await writeIssue(
      root,
      "01-first.md",
      `# First\n\nStatus: ready-for-agent\n\n## Blocked by\n\n- [02 — Second](./02-second.md)\n`,
    );
    await writeIssue(
      root,
      "02-second.md",
      `# Second\n\nStatus: ready-for-agent\n\n## Blocked by\n\n- [01 — First](./01-first.md)\n`,
    );

    await expect(loadTicketGraph(root, "feature")).rejects.toThrow(
      "feature/01 -> feature/02 -> feature/01",
    );
  });
});
