import {
  DiscussionCancelledError,
  type Discussion,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
  type GenerateSynthesisInput,
  type GeneratedSynthesis,
} from "../discussion";

interface FakeOutcomeOptions {
  delayMs?: number;
  /** Simulates a provider that accepts a signal but still resolves after abort. */
  ignoreAbort?: boolean;
}

export type FakeDiscussionOutcome =
  | (FakeOutcomeOptions & {
      type: "success";
      result: GeneratedDiscussionTurn;
    })
  | (FakeOutcomeOptions & {
      type: "failure";
      error: Error;
    })
  | (FakeOutcomeOptions & {
      type: "cancellation";
    });

export type FakeSynthesisOutcome =
  | (FakeOutcomeOptions & {
      type: "success";
      result: GeneratedSynthesis;
    })
  | (FakeOutcomeOptions & {
      type: "failure";
      error: Error;
    })
  | (FakeOutcomeOptions & {
      type: "cancellation";
    });

function cancellationError(): DiscussionCancelledError {
  return new DiscussionCancelledError();
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(cancellationError());
  }

  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);

    const abort = () => {
      clearTimeout(timeout);
      reject(cancellationError());
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Scriptable, credential-free Discussion implementation for deterministic tests. */
export class FakeDiscussion implements Discussion {
  readonly calls: GenerateDiscussionTurnInput[] = [];
  readonly synthesisCalls: GenerateSynthesisInput[] = [];
  private readonly outcomes: FakeDiscussionOutcome[];
  private readonly synthesisOutcomes: FakeSynthesisOutcome[];

  constructor(
    outcomes: readonly FakeDiscussionOutcome[] = [],
    synthesisOutcomes: readonly FakeSynthesisOutcome[] = [],
  ) {
    this.outcomes = [...outcomes];
    this.synthesisOutcomes = [...synthesisOutcomes];
  }

  enqueue(outcome: FakeDiscussionOutcome): void {
    this.outcomes.push(outcome);
  }

  enqueueSynthesis(outcome: FakeSynthesisOutcome): void {
    this.synthesisOutcomes.push(outcome);
  }

  async generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn> {
    this.calls.push(input);

    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error("No fake Discussion outcome was configured");
    }

    await wait(
      outcome.delayMs ?? 0,
      outcome.ignoreAbort ? undefined : input.signal,
    );

    if (
      (!outcome.ignoreAbort && input.signal?.aborted) ||
      outcome.type === "cancellation"
    ) {
      throw cancellationError();
    }

    if (outcome.type === "failure") {
      throw outcome.error;
    }

    return outcome.result;
  }

  async generateSynthesis(
    input: GenerateSynthesisInput,
  ): Promise<GeneratedSynthesis> {
    this.synthesisCalls.push(input);

    const outcome = this.synthesisOutcomes.shift();
    if (!outcome) {
      throw new Error("No fake synthesis outcome was configured");
    }

    await wait(
      outcome.delayMs ?? 0,
      outcome.ignoreAbort ? undefined : input.signal,
    );

    if (
      (!outcome.ignoreAbort && input.signal?.aborted) ||
      outcome.type === "cancellation"
    ) {
      throw cancellationError();
    }

    if (outcome.type === "failure") {
      throw outcome.error;
    }

    return outcome.result;
  }
}
