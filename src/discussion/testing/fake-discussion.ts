import {
  DiscussionCancelledError,
  type Discussion,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
} from "../discussion";

interface FakeOutcomeOptions {
  delayMs?: number;
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
  private readonly outcomes: FakeDiscussionOutcome[];

  constructor(outcomes: readonly FakeDiscussionOutcome[] = []) {
    this.outcomes = [...outcomes];
  }

  enqueue(outcome: FakeDiscussionOutcome): void {
    this.outcomes.push(outcome);
  }

  async generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn> {
    this.calls.push(input);

    const outcome = this.outcomes.shift();
    if (!outcome) {
      throw new Error("No fake Discussion outcome was configured");
    }

    await wait(outcome.delayMs ?? 0, input.signal);

    if (input.signal?.aborted || outcome.type === "cancellation") {
      throw cancellationError();
    }

    if (outcome.type === "failure") {
      throw outcome.error;
    }

    return outcome.result;
  }
}
