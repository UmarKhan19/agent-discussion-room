import { describe, expect, it } from "vitest";
import {
  classifyAdvisories,
  ghsaIdOf,
  isExceptionExpired,
  parseBunAuditJson,
  type BunAuditReport,
  type BunAuditAdvisory,
  type DependencyAuditException,
} from "./dependency-audit";

const LOW_PROVIDER_ADVISORY: BunAuditAdvisory = {
  id: 1119676,
  url: "https://github.com/advisories/GHSA-866g-f22w-33x8",
  title: "@ai-sdk/provider-utils has an Uncontrolled Resource Consumption issue",
  severity: "low",
  vulnerable_versions: "<=3.0.97",
  cwe: ["CWE-400"],
  cvss: { score: 4.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L" },
};

const exception: DependencyAuditException = {
  package: "@ai-sdk/provider-utils",
  advisory: "GHSA-866g-f22w-33x8",
  impact: "impact analysis",
  owner: "Discussion Room maintainers",
  mitigation: "upgrade @mastra/core when it ships a patched alias",
  expires: "2099-01-01",
};

describe("parseBunAuditJson", () => {
  it("parses the package-keyed report shape emitted by bun audit --json", () => {
    const raw = JSON.stringify({
      "@ai-sdk/provider-utils": [LOW_PROVIDER_ADVISORY],
    });
    expect(parseBunAuditJson(raw)).toEqual({
      "@ai-sdk/provider-utils": [LOW_PROVIDER_ADVISORY],
    });
  });

  it("rejects reports that are not objects", () => {
    expect(() => parseBunAuditJson("[]")).toThrow();
    expect(() => parseBunAuditJson("not json")).toThrow();
  });

  it("rejects a changed report shape instead of silently dropping findings", () => {
    // A non-array value would previously be skipped; the gate must fail
    // loudly so a changed `bun audit --json` shape cannot pass on
    // degraded data.
    expect(() =>
      parseBunAuditJson(JSON.stringify({ "some-package": { nope: true } })),
    ).toThrow(/unexpected shape/);
  });
});

describe("ghsaIdOf", () => {
  it("extracts the GHSA identifier from an advisory URL", () => {
    expect(
      ghsaIdOf("https://github.com/advisories/GHSA-866g-f22w-33x8"),
    ).toBe("GHSA-866g-f22w-33x8");
  });

  it("returns null when the URL carries no GHSA identifier", () => {
    expect(ghsaIdOf("https://example.com/advisory/123")).toBeNull();
  });
});

describe("isExceptionExpired", () => {
  it("treats an exception whose expiry day has passed as expired", () => {
    expect(
      isExceptionExpired(
        { ...exception, expires: "2000-01-01" },
        new Date("2026-01-02T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("treats an exception as valid through the end of its expiry day", () => {
    expect(
      isExceptionExpired(exception, new Date("2098-12-31T23:59:59Z")),
    ).toBe(false);
  });
});

describe("classifyAdvisories", () => {
  it("accepts a flagged advisory that matches a recorded, unexpired exception", () => {
    const report: BunAuditReport = {
      "@ai-sdk/provider-utils": [LOW_PROVIDER_ADVISORY],
    };
    const decision = classifyAdvisories(
      report,
      [exception],
      new Date("2026-08-07T00:00:00Z"),
    );
    expect(decision.accepted).toHaveLength(1);
    expect(decision.accepted[0].exception).toEqual(exception);
    expect(decision.unexpected).toHaveLength(0);
    expect(decision.staleExceptions).toHaveLength(0);
  });

  it("flags an advisory without a recorded exception as unexpected", () => {
    const report: BunAuditReport = {
      "fresh-package": [LOW_PROVIDER_ADVISORY],
    };
    const decision = classifyAdvisories(report, [exception]);
    expect(decision.unexpected).toHaveLength(1);
    expect(decision.unexpected[0]).toMatchObject({
      package: "fresh-package",
      expired: false,
    });
    expect(decision.accepted).toHaveLength(0);
  });

  it("flags a matching exception that has expired as unexpected", () => {
    const report: BunAuditReport = {
      "@ai-sdk/provider-utils": [LOW_PROVIDER_ADVISORY],
    };
    const expired = { ...exception, expires: "2000-01-01" };
    const decision = classifyAdvisories(
      report,
      [expired],
      new Date("2026-01-02T00:00:00Z"),
    );
    expect(decision.unexpected).toHaveLength(1);
    expect(decision.unexpected[0].expired).toBe(true);
    expect(decision.accepted).toHaveLength(0);
  });

  it("does not accept an exception whose advisory id differs even for the same package", () => {
    const report: BunAuditReport = {
      "@ai-sdk/provider-utils": [
        {
          ...LOW_PROVIDER_ADVISORY,
          url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
        },
      ],
    };
    const decision = classifyAdvisories(report, [exception]);
    expect(decision.unexpected).toHaveLength(1);
    expect(decision.accepted).toHaveLength(0);
  });

  it("reports recorded exceptions that no longer match any advisory as stale", () => {
    const decision = classifyAdvisories({}, [exception]);
    expect(decision.staleExceptions).toEqual([exception]);
    expect(decision.unexpected).toHaveLength(0);
  });
});
