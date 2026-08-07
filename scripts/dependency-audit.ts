#!/usr/bin/env bun
/**
 * Dependency audit gate (`bun run audit`).
 *
 * Runs `bun audit --json` against the frozen lockfile and classifies every
 * advisory against the recorded exceptions in
 * `scripts/dependency-audit-exceptions.json`. Exits non-zero when:
 *
 * - any advisory has no recorded exception (a new or previously fixed
 *   regression), or
 * - a recorded exception has expired (maintainers must re-review and either
 *   re-record with a new expiry or fix the advisory).
 *
 * Accepted advisories and stale exceptions are printed so the state stays
 * visible in local runs and CI logs. See docs/verification.md.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyAdvisories,
  parseBunAuditJson,
  type DependencyAuditException,
} from "../src/verification/dependency-audit";

const exceptionsPath = resolve(
  process.cwd(),
  "scripts/dependency-audit-exceptions.json",
);

function loadExceptions(): DependencyAuditException[] {
  const raw = readFileSync(exceptionsPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${exceptionsPath} must contain a JSON array`);
  }
  return parsed as DependencyAuditException[];
}

// `bun audit` exits non-zero when advisories exist; that is expected here —
// the report on stdout is what we classify. Only a failure to run the audit
// at all (signal, no stdout) is fatal.
const audit = spawnSync("bun", ["audit", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (audit.error !== undefined) {
  throw audit.error;
}
if (audit.status === null || audit.stdout.length === 0) {
  throw new Error("bun audit --json failed to produce a report");
}
const report = parseBunAuditJson(audit.stdout);
const exceptions = loadExceptions();
const decision = classifyAdvisories(report, exceptions);

for (const finding of decision.accepted) {
  const exception = finding.exception as DependencyAuditException;
  console.log(
    `ACCEPTED  ${finding.package} ${exception.advisory} ` +
      `(${finding.advisory.severity}, expires ${exception.expires}, ` +
      `owner: ${exception.owner})`,
  );
}

for (const finding of decision.unexpected) {
  if (finding.expired) {
    console.error(
      `EXPIRED   ${finding.package} ${finding.advisory.url} ` +
        `(recorded exception passed its expiry; re-review and re-record or fix)`,
    );
  } else {
    console.error(
      `UNEXPECTED ${finding.package} ${finding.advisory.url} ` +
        `(${finding.advisory.severity}: ${finding.advisory.title})`,
    );
  }
}

for (const exception of decision.staleExceptions) {
  console.log(
    `STALE     ${exception.package} ${exception.advisory} ` +
      `(no longer reported; remove the exception record)`,
  );
}

const total =
  decision.accepted.length +
  decision.unexpected.length +
  decision.staleExceptions.length;
console.log(
  `Dependency audit: ${decision.accepted.length} accepted, ` +
    `${decision.unexpected.length} unexpected, ` +
    `${decision.staleExceptions.length} stale (${total} total findings).`,
);

if (decision.unexpected.length > 0) {
  console.error(
    "Dependency audit FAILED: unexpected or expired advisories must be fixed " +
      "or recorded with an explicit exception before release.",
  );
  process.exit(1);
}
