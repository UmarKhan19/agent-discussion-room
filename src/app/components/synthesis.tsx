"use client";

import type { Synthesis } from "@/discussion/contracts";

/** Participant copy for the closed set of synthesis failure kinds. */
function synthesisFailureCopy(failure: {
  kind: string;
  retryable?: boolean;
}): string {
  switch (failure.kind) {
    case "output_blocked":
      return "The synthesis was blocked by the output policy. The completed discussion remains available below.";
    case "invalid_response":
      return "The synthesis output was malformed and could not be used. The completed discussion remains available below.";
    case "output_limit_exceeded":
      return "The synthesis exceeded the output limit and could not be used. The completed discussion remains available below.";
    case "timeout":
      return "The synthesis timed out before completing. The completed discussion remains available below.";
    case "generation_failed":
      return failure.retryable
        ? "The synthesis could not be generated. You can retry it; the completed discussion below is not affected."
        : "The synthesis failed to generate. The completed discussion remains available below.";
    default:
      return "The synthesis could not be completed. The completed discussion remains available below.";
  }
}

function sectionClass(): string {
  return "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4";
}

/**
 * The server-owned completion synthesis, rendered OUTSIDE the Transcript
 * (never a Speaker message) and never counted as a Turn. The completed
 * debate stays fully visible in every synthesis state: missing (crash
 * window / legacy), generating, failed, or committed.
 */
export function DiscussionSynthesis({
  synthesis,
  retrying,
  canRetry,
  onRetry,
}: {
  synthesis: Synthesis | null;
  retrying: boolean;
  canRetry: boolean;
  onRetry: () => void;
}) {
  if (synthesis === null) {
    // A completed Discussion whose synthesis was never claimed (a crash or
    // storage outage in the commit-to-claim window, or a legacy pre-synthesis
    // Discussion). The retry is a server-owned, durable-state-driven action:
    // no browser request identity is involved.
    return (
      <section aria-labelledby="synthesis-heading" className={sectionClass()}>
        <h3
          id="synthesis-heading"
          className="text-lg font-semibold"
        >
          Synthesis not generated
        </h3>
        <p className="text-sm text-muted">
          The discussion finished before its synthesis could be generated.
          You can generate it now; the completed discussion below is not
          affected.
        </p>
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="control control-block w-fit rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
          >
            {retrying ? "Generating synthesis…" : "Generate Synthesis"}
          </button>
        ) : null}
      </section>
    );
  }

  if (synthesis.status === "generating") {
    return (
      <section aria-labelledby="synthesis-heading" className={sectionClass()}>
        <h3
          id="synthesis-heading"
          className="text-lg font-semibold"
        >
          Preparing synthesis…
        </h3>
        <p className="text-sm text-muted">
          The discussion finished. A neutral summary of the strongest cases
          for and against is being prepared.
        </p>
      </section>
    );
  }

  if (synthesis.status === "failed") {
    return (
      <section aria-labelledby="synthesis-heading" className={sectionClass()}>
        <h3
          id="synthesis-heading"
          className="text-lg font-semibold"
        >
          Synthesis unavailable
        </h3>
        <p className="text-sm text-muted">
          {synthesisFailureCopy(synthesis.failure)}
        </p>
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="control control-block w-fit rounded-lg bg-accent px-5 py-2 font-semibold text-accent-foreground disabled:opacity-60"
          >
            {retrying ? "Retrying synthesis…" : "Retry Synthesis"}
          </button>
        ) : null}
      </section>
    );
  }

  const content = synthesis.content;
  return (
    <section aria-labelledby="synthesis-heading" className={sectionClass()}>
      <h3
        id="synthesis-heading"
        className="text-lg font-semibold"
      >
        Discussion synthesis
      </h3>
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <h4 className="font-semibold">Strongest case for</h4>
          <p className="text-muted">{content.strongestSupport}</p>
        </div>
        <div>
          <h4 className="font-semibold">Strongest case against</h4>
          <p className="text-muted">{content.strongestOpposition}</p>
        </div>
        {content.agreements.length > 0 ? (
          <div>
            <h4 className="font-semibold">Agreements</h4>
            <ul className="list-disc ps-5 text-muted">
              {content.agreements.map((agreement, index) => (
                <li key={index}>{agreement}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <h4 className="font-semibold">Unresolved tradeoffs</h4>
          <p className="text-muted">{content.unresolved}</p>
        </div>
        {content.claimsToVerify.length > 0 ? (
          <div>
            <h4 className="font-semibold">Claims worth verifying</h4>
            <ul className="list-disc ps-5 text-muted">
              {content.claimsToVerify.map((claim, index) => (
                <li key={index}>{claim}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <h4 className="font-semibold">Takeaway</h4>
          <p className="text-muted">{content.takeaway}</p>
        </div>
      </div>
    </section>
  );
}
