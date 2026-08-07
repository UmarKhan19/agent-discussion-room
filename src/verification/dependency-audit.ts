/**
 * Dependency audit verification.
 *
 * `bun audit --json` reports every advisory in the frozen lockfile. This
 * module classifies those advisories against a small, tracked allowlist of
 * temporary exceptions (see `scripts/dependency-audit-exceptions.json`).
 * The policy is strict by design:
 *
 * - An advisory with a matching, unexpired exception is accepted but still
 *   printed, so it stays visible.
 * - An advisory without an exception — or whose exception has expired — is
 *   an unexpected regression and fails verification.
 * - An exception that no longer matches any advisory is stale and reported,
 *   so maintainers remove it once the upstream fix lands.
 *
 * Exceptions are keyed by package name plus GHSA identifier, never by
 * severity or a blanket package ignore.
 */

/** One advisory as emitted by `bun audit --json`. */
export interface BunAuditAdvisory {
  id: number;
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
  cwe?: string[];
  cvss?: { score: number; vectorString: string | null };
}

/** `bun audit --json` emits a record keyed by package name. */
export type BunAuditReport = Record<string, BunAuditAdvisory[]>;

/**
 * A recorded, time-boxed exception. Every field is required so that a
 * reviewer must state the impact, the owner, the mitigation, and the expiry
 * instead of blanket-ignoring an advisory.
 */
export interface DependencyAuditException {
  /** Package name exactly as reported by `bun audit --json`. */
  package: string;
  /** GHSA identifier from the advisory URL, e.g. GHSA-866g-f22w-33x8. */
  advisory: string;
  /** Impact analysis: why the advisory does not affect this product. */
  impact: string;
  /** Owner accountable for re-reviewing before the expiry date. */
  owner: string;
  /** The concrete mitigation that removes the need for the exception. */
  mitigation: string;
  /** YYYY-MM-DD expiry; the exception fails verification after this day. */
  expires: string;
}

export interface AdvisoryFinding {
  package: string;
  advisory: BunAuditAdvisory;
  exception?: DependencyAuditException;
  /** True when the finding matched an exception whose expiry has passed. */
  expired: boolean;
}

export interface AuditDecision {
  /** Advisories covered by a recorded, unexpired exception. */
  accepted: AdvisoryFinding[];
  /** Advisories with no exception, or with an expired exception. */
  unexpected: AdvisoryFinding[];
  /** Recorded exceptions that no longer match any advisory. */
  staleExceptions: DependencyAuditException[];
}

/**
 * Parses the JSON document emitted by `bun audit --json`. Throws when the
 * document is not the expected package-keyed record.
 */
export function parseBunAuditJson(raw: string): BunAuditReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("bun audit --json did not produce valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("bun audit --json did not return the expected report shape");
  }
  const report: BunAuditReport = {};
  for (const [packageName, advisories] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!Array.isArray(advisories)) {
      // A changed `bun audit --json` shape must fail loudly: silently
      // dropping findings could let the gate pass on degraded data.
      throw new Error(
        `bun audit --json reported an unexpected shape for ${packageName}`,
      );
    }
    report[packageName] = advisories as BunAuditAdvisory[];
  }
  return report;
}

/** Extracts the GHSA identifier from an advisory URL, or null. */
export function ghsaIdOf(url: string): string | null {
  const match = /GHSA-[A-Za-z0-9-]+/u.exec(url);
  return match === null ? null : match[0];
}

/**
 * An exception is valid through the end of its expiry day (interpreted as
 * UTC). Comparing against a fixed end-of-day makes the expiry day itself a
 * deadline rather than an instant.
 */
export function isExceptionExpired(
  exception: DependencyAuditException,
  now: Date = new Date(),
): boolean {
  const expiry = Date.parse(`${exception.expires}T23:59:59Z`);
  if (Number.isNaN(expiry)) return true;
  return now.getTime() > expiry;
}

function exceptionKey(exception: DependencyAuditException): string {
  return `${exception.package}\u0000${exception.advisory}`;
}

/**
 * Classifies every advisory in the report against the recorded exceptions.
 * Matching requires both the package name and the GHSA identifier; an
 * exception never covers another advisory in the same package.
 */
export function classifyAdvisories(
  report: BunAuditReport,
  exceptions: readonly DependencyAuditException[],
  now: Date = new Date(),
): AuditDecision {
  const accepted: AdvisoryFinding[] = [];
  const unexpected: AdvisoryFinding[] = [];
  const matchedExceptions = new Set<string>();

  for (const [packageName, advisories] of Object.entries(report)) {
    for (const advisory of advisories) {
      const ghsaId = ghsaIdOf(advisory.url);
      const exception = exceptions.find(
        (candidate) =>
          candidate.package === packageName &&
          ghsaId !== null &&
          candidate.advisory === ghsaId,
      );
      if (exception === undefined) {
        unexpected.push({ package: packageName, advisory, expired: false });
        continue;
      }
      matchedExceptions.add(exceptionKey(exception));
      const expired = isExceptionExpired(exception, now);
      const finding: AdvisoryFinding = {
        package: packageName,
        advisory,
        exception,
        expired,
      };
      if (expired) {
        unexpected.push(finding);
      } else {
        accepted.push(finding);
      }
    }
  }

  const staleExceptions = exceptions.filter(
    (exception) => !matchedExceptions.has(exceptionKey(exception)),
  );

  return { accepted, unexpected, staleExceptions };
}
