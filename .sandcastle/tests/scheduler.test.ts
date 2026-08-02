import { describe, expect, test } from "bun:test";
import { planExecutionWaves, selectReadyWave } from "../scheduler";
import type { Ticket } from "../tickets";

const ticket = (
  number: string,
  blockedBy: string[] = [],
  status = "ready-for-agent",
): Ticket => ({
  id: `feature/${number}`,
  feature: "feature",
  number,
  slug: `ticket-${number}`,
  title: `Ticket ${number}`,
  status,
  path: `/repo/.scratch/feature/issues/${number}-ticket.md`,
  relativePath: `.scratch/feature/issues/${number}-ticket.md`,
  parentPath: "/repo/.scratch/feature/PRD.md",
  blockedBy,
  body: `Ticket ${number}`,
});

describe("selectReadyWave", () => {
  test("selects only dependency-ready tickets in deterministic order", () => {
    const tickets = [
      ticket("03", ["feature/01", "feature/02"]),
      ticket("02"),
      ticket("01"),
    ];

    expect(
      selectReadyWave(tickets, {}, 4).map((candidate) => candidate.id),
    ).toEqual(["feature/01", "feature/02"]);
  });

  test("unlocks a dependent ticket only after every blocker is integrated", () => {
    const tickets = [
      ticket("01"),
      ticket("02"),
      ticket("03", ["feature/01", "feature/02"]),
    ];

    expect(
      selectReadyWave(
        tickets,
        { "feature/01": "integrated", "feature/02": "running" },
        4,
      ),
    ).toEqual([]);
    expect(
      selectReadyWave(
        tickets,
        { "feature/01": "integrated", "feature/02": "integrated" },
        4,
      ).map((candidate) => candidate.id),
    ).toEqual(["feature/03"]);
  });

  test("honors the configured parallelism limit", () => {
    const tickets = [ticket("03"), ticket("01"), ticket("02")];

    expect(
      selectReadyWave(tickets, {}, 2).map((candidate) => candidate.id),
    ).toEqual(["feature/01", "feature/02"]);
  });
});

describe("planExecutionWaves", () => {
  test("simulates parallel roots followed by sequential dependents", () => {
    const tickets = [
      ticket("01"),
      ticket("02"),
      ticket("03", ["feature/01"]),
      ticket("04", ["feature/01"]),
      ticket("05", ["feature/02", "feature/03", "feature/04"]),
    ];

    expect(planExecutionWaves(tickets, 3)).toEqual([
      ["feature/01", "feature/02"],
      ["feature/03", "feature/04"],
      ["feature/05"],
    ]);
  });
});
