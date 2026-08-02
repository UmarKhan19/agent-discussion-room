import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../state";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("StateStore lock", () => {
  test("allows only one owner and releases by ownership token", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-state-"));
    roots.push(root);
    const first = new StateStore(root, "feature");
    const second = new StateStore(root, "feature");

    const release = await first.acquire();
    await expect(second.acquire()).rejects.toThrow("already exists");

    const ownerPath = join(first.lockPath, "owner.json");
    const owner = await readFile(ownerPath, "utf8");
    await writeFile(ownerPath, '{"token":"different-owner"}\n');
    await expect(release()).rejects.toThrow("owned by another process");
    await writeFile(ownerPath, owner);
    await release();

    const releaseAgain = await second.acquire();
    await releaseAgain();
  });
});
