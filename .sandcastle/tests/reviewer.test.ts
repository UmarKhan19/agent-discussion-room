import { describe, expect, test } from "bun:test";
import { ReviewSchema } from "../reviewer";

describe("ReviewSchema", () => {
  test("rejects approval when any blocking finding remains", () => {
    const parsed = ReviewSchema.safeParse({
      decision: "approve",
      summary: "Looks good except for a blocker",
      findings: [
        {
          severity: "blocking",
          file: "src/app/page.tsx",
          line: 1,
          message: "Blocking correctness issue",
        },
      ],
    });

    expect(parsed.success).toBeFalse();
  });

  test("allows approval with warnings and notes", () => {
    const parsed = ReviewSchema.safeParse({
      decision: "approve",
      summary: "Safe to integrate",
      findings: [
        {
          severity: "warning",
          file: null,
          line: null,
          message: "Follow-up improvement",
        },
      ],
    });

    expect(parsed.success).toBeTrue();
  });
});
