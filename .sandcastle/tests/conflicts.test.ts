import { describe, expect, test } from "bun:test";
import { planConflictFreeIntegration } from "../conflicts";

const result = (ticketId: string, changedFiles: string[]) => ({
  ticketId,
  branch: `sandcastle/${ticketId}`,
  baseSha: "base",
  headSha: `${ticketId}-head`,
  changedFiles,
});

describe("planConflictFreeIntegration", () => {
  test("keeps non-overlapping parallel results on the direct integration path", () => {
    const plan = planConflictFreeIntegration([
      result("feature/02", ["src/b.ts"]),
      result("feature/01", ["src/a.ts"]),
    ]);

    expect(plan.direct.map((entry) => entry.ticketId)).toEqual([
      "feature/01",
      "feature/02",
    ]);
    expect(plan.rerunSequentially).toEqual([]);
  });

  test("reruns the later deterministic ticket when parallel results overlap", () => {
    const plan = planConflictFreeIntegration([
      result("feature/02", ["src/mastra/index.ts", "bun.lock"]),
      result("feature/01", ["src/mastra/index.ts"]),
      result("feature/03", ["src/app/page.tsx"]),
    ]);

    expect(plan.direct.map((entry) => entry.ticketId)).toEqual([
      "feature/01",
      "feature/03",
    ]);
    expect(plan.rerunSequentially.map((entry) => entry.ticketId)).toEqual([
      "feature/02",
    ]);
  });
});
