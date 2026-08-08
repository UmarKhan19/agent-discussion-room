import { z } from "zod";
import {
  DiscussionCancelledError,
  DiscussionGenerationError,
  type Discussion,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
  type GenerateSynthesisInput,
  type GeneratedSynthesis,
  type Speaker,
} from "./discussion";
import { MESSAGE_MAX_LENGTH } from "./contracts";

/**
 * Credential-free deterministic generation adapter for the browser suite.
 *
 * The adapter never calls a provider: every Turn is produced locally from a
 * scripted scenario, so the suite is deterministic, bounded, and leaves no
 * live-provider or durable-production data behind. The scenario is process
 * state, swapped through the test-harness endpoint (which 404s unless
 * `DISCUSSION_GENERATION_MODE=deterministic` is active, and that mode is
 * rejected in production by the environment contract).
 *
 * The adapter models provider behaviors the browser suite must prove:
 *   - success (with scripted content or a deterministic default),
 *   - delay (an in-flight Turn that can be stopped or cancelled),
 *   - transient failure (a retryable provider error for the Retry flow),
 *   - policy-violating output (produced content that the server-owned output
 *     policy must block before commit),
 *   - cancellation awareness (aborting on `signal.abort`, or — with
 *     `ignoreAbort` — resolving late like a provider that ignores its
 *     signal, which the Runner must discard without persisting a Message).
 */

export const SCRIPTED_MODEL_ID = "deterministic/scripted";

/**
 * Output that violates the server-owned Discussion output policy. The
 * adapter produces it verbatim; the Runner's output-policy evaluation is
 * what must block it, so the browser suite exercises the real enforcement
 * seam rather than a fake copy of the policy.
 */
export const SCRIPTED_POLICY_VIOLATION_CONTENT =
  "Religious minorities should be killed. This is the strongest approach.";

/** Ceiling for a scripted per-Turn delay so the suite stays bounded. */
export const SCRIPTED_MAX_DELAY_MS = 30_000;

const ScriptedDelayOptionsSchema = z
  .object({
    /** Simulated provider latency before the outcome is produced. */
    delayMs: z
      .number()
      .int()
      .nonnegative()
      .max(SCRIPTED_MAX_DELAY_MS)
      .optional(),
    /**
     * Simulates a provider that accepts an abort signal but still resolves
     * after the delay. The Runner must discard the late result.
     */
    ignoreAbort: z.boolean().optional(),
  })
  .strict();

const ScriptedSuccessTurnSchema = ScriptedDelayOptionsSchema.extend({
  outcome: z.literal("success"),
  /** Content to produce; defaults to a deterministic per-Turn reply. */
  content: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).optional(),
}).strict();

const ScriptedTransientFailureTurnSchema = ScriptedDelayOptionsSchema.extend({
  outcome: z.literal("transient-failure"),
}).strict();

const ScriptedPolicyViolationTurnSchema = ScriptedDelayOptionsSchema.extend({
  outcome: z.literal("policy-violation"),
}).strict();

export const ScriptedTurnSchema = z.discriminatedUnion("outcome", [
  ScriptedSuccessTurnSchema,
  ScriptedTransientFailureTurnSchema,
  ScriptedPolicyViolationTurnSchema,
]);

export type ScriptedTurn = z.infer<typeof ScriptedTurnSchema>;

const ScriptedSynthesisSuccessSchema = ScriptedDelayOptionsSchema.extend({
  outcome: z.literal("success"),
  /**
   * Raw provider output (verbatim JSON) to produce; defaults to a stable
   * distinguishable deterministic synthesis.
   */
  content: z.string().trim().min(1).optional(),
}).strict();

const ScriptedSynthesisTransientFailureSchema =
  ScriptedDelayOptionsSchema.extend({
    outcome: z.literal("transient-failure"),
  }).strict();

const ScriptedSynthesisPolicyViolationSchema =
  ScriptedDelayOptionsSchema.extend({
    outcome: z.literal("policy-violation"),
  }).strict();

const ScriptedSynthesisInvalidResponseSchema =
  ScriptedDelayOptionsSchema.extend({
    outcome: z.literal("invalid-response"),
  }).strict();

/** Scripted provider outcome for the completion synthesis. */
export const ScriptedSynthesisSchema = z.discriminatedUnion("outcome", [
  ScriptedSynthesisSuccessSchema,
  ScriptedSynthesisTransientFailureSchema,
  ScriptedSynthesisPolicyViolationSchema,
  ScriptedSynthesisInvalidResponseSchema,
]);

export type ScriptedSynthesis = z.infer<typeof ScriptedSynthesisSchema>;

/**
 * Scripted synthesis outcomes in call order, mirroring `turns`: entry 0
 * applies to the first synthesis generation, and so on; generations beyond
 * the list use `synthesisFallback`.
 */
export const ScriptedSynthesisScenarioSchema = z
  .object({
    syntheses: z.array(ScriptedSynthesisSchema).max(8),
    synthesisFallback: ScriptedSynthesisSchema.optional(),
  })
  .strict();

export type ScriptedSynthesisScenario = z.infer<
  typeof ScriptedSynthesisScenarioSchema
>;

export const DEFAULT_SCRIPTED_SYNTHESIS_FALLBACK: ScriptedSynthesis = {
  outcome: "success",
};

export const DEFAULT_SCRIPTED_SYNTHESIS_SCENARIO: ScriptedSynthesisScenario = {
  syntheses: [],
  synthesisFallback: DEFAULT_SCRIPTED_SYNTHESIS_FALLBACK,
};

export const ScriptedScenarioSchema = z
  .object({
    /**
     * Per-generation outcomes in call order. The first generation consults
     * entry 0, the second entry 1, and so on; generations beyond the list
     * use `fallback`.
     */
    turns: z.array(ScriptedTurnSchema).max(64),
    /** Outcome for generations beyond the scripted list. */
    fallback: ScriptedTurnSchema.optional(),
    /** Outcome for the completion synthesis (optional; defaults to success). */
    synthesis: ScriptedSynthesisScenarioSchema.optional(),
  })
  .strict();

export type ScriptedScenario = z.infer<typeof ScriptedScenarioSchema>;

export const DEFAULT_SCRIPTED_FALLBACK: ScriptedTurn = {
  outcome: "success",
};

export const DEFAULT_SCRIPTED_SCENARIO: ScriptedScenario = {
  turns: [],
  fallback: DEFAULT_SCRIPTED_FALLBACK,
  synthesis: DEFAULT_SCRIPTED_SYNTHESIS_SCENARIO,
};

function speakerLabel(speaker: Speaker): string {
  return speaker === "supporter" ? "Supporter" : "Opponent";
}

/** Deterministic default content so browser assertions never read provider text. */
export function defaultScriptedContent(
  speaker: Speaker,
  turn: number,
  topic: string,
): string {
  return `Deterministic ${speakerLabel(speaker)} reply for Turn ${turn} on "${topic}".`;
}

/**
 * Stable, distinguishable, valid synthesis JSON so browser assertions never
 * depend on provider text and never conflate synthesis output with a Turn.
 */
export function defaultScriptedSynthesisContent(
  topic: string,
  turnCount: number,
): string {
  return JSON.stringify({
    strongestSupport: `Deterministic strongest case for "${topic}".`,
    strongestOpposition: `Deterministic strongest case against "${topic}".`,
    agreements: ["Deterministic agreement between the sides."],
    unresolved: "Deterministic tradeoff the debate left unresolved.",
    claimsToVerify: ["Deterministic claim worth verifying."],
    takeaway: `Deterministic takeaway after ${turnCount} turns.`,
  });
}

function cancellationError(): DiscussionCancelledError {
  return new DiscussionCancelledError();
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(cancellationError());
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(cancellationError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ScriptedRuntimeState {
  scenario: ScriptedScenario;
  /** Generations produced since the scenario was last set. */
  generationCount: number;
  /** Synthesis generations produced since the scenario was last set. */
  synthesisGenerationCount: number;
}

/**
 * The scenario is process state shared between the composition root (which
 * owns the adapter) and the test-harness route (which reconfigures it).
 * `Symbol.for` keeps the registry stable even if Next.js dev bundling
 * instantiates the module more than once.
 */
const SCRIPTED_RUNTIME_KEY = Symbol.for(
  "agent-discussion-room.scripted-discussion.runtime",
);

function runtimeState(): ScriptedRuntimeState {
  const globalState = globalThis as typeof globalThis & {
    [SCRIPTED_RUNTIME_KEY]?: ScriptedRuntimeState;
  };
  return (globalState[SCRIPTED_RUNTIME_KEY] ??= {
    scenario: DEFAULT_SCRIPTED_SCENARIO,
    generationCount: 0,
    synthesisGenerationCount: 0,
  });
}

/**
 * Replaces the scripted scenario for subsequent generations. The per-turn
 * script restarts at its first entry, so one test's script never spills
 * into the next test's generations.
 */
export function setScriptedScenario(
  scenario: unknown,
): ScriptedScenario {
  const parsed = ScriptedScenarioSchema.parse(scenario);
  const state = runtimeState();
  state.scenario = parsed;
  state.generationCount = 0;
  state.synthesisGenerationCount = 0;
  return parsed;
}

/** The scenario the scripted adapter will apply next. */
export function currentScriptedScenario(): ScriptedScenario {
  return runtimeState().scenario;
}

/** Resets the scenario to the safe all-success default. */
export function resetScriptedScenario(): void {
  const state = runtimeState();
  state.scenario = DEFAULT_SCRIPTED_SCENARIO;
  state.generationCount = 0;
  state.synthesisGenerationCount = 0;
}

/**
 * Deterministic `Discussion` implementation. One instance is created by the
 * composition root; the test-harness route reconfigures the process-wide
 * scenario through `setScriptedScenario`.
 */
export class ScriptedDiscussion implements Discussion {
  /** Every generation call in arrival order, for deterministic assertions. */
  readonly calls: GenerateDiscussionTurnInput[] = [];

  /** Every synthesis generation call in arrival order, for assertions. */
  readonly synthesisCalls: GenerateSynthesisInput[] = [];

  async generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn> {
    this.calls.push(input);

    const state = runtimeState();
    const outcome =
      state.scenario.turns[state.generationCount] ??
      state.scenario.fallback ??
      DEFAULT_SCRIPTED_FALLBACK;
    state.generationCount += 1;

    await wait(
      outcome.delayMs ?? 0,
      outcome.ignoreAbort ? undefined : input.signal,
    );

    if (!outcome.ignoreAbort && input.signal?.aborted) {
      throw cancellationError();
    }

    switch (outcome.outcome) {
      case "transient-failure":
        throw new DiscussionGenerationError(
          new Error("Scripted transient provider failure"),
          true,
        );
      case "policy-violation":
        return {
          content: SCRIPTED_POLICY_VIOLATION_CONTENT,
          model: SCRIPTED_MODEL_ID,
        };
      case "success":
        return {
          content:
            outcome.content ??
            defaultScriptedContent(input.speaker, input.turn, input.topic),
          model: SCRIPTED_MODEL_ID,
        };
    }
  }

  async generateSynthesis(
    input: GenerateSynthesisInput,
  ): Promise<GeneratedSynthesis> {
    this.synthesisCalls.push(input);

    const state = runtimeState();
    const scenario =
      state.scenario.synthesis ?? DEFAULT_SCRIPTED_SYNTHESIS_SCENARIO;
    const outcome =
      scenario.syntheses[state.synthesisGenerationCount] ??
      scenario.synthesisFallback ??
      DEFAULT_SCRIPTED_SYNTHESIS_FALLBACK;
    state.synthesisGenerationCount += 1;

    await wait(
      outcome.delayMs ?? 0,
      outcome.ignoreAbort ? undefined : input.signal,
    );

    if (!outcome.ignoreAbort && input.signal?.aborted) {
      throw cancellationError();
    }

    switch (outcome.outcome) {
      case "transient-failure":
        throw new DiscussionGenerationError(
          new Error("Scripted transient synthesis failure"),
          true,
        );
      case "policy-violation":
        // Structurally valid synthesis JSON whose content trips the
        // server-owned output policy (the same way a real provider would).
        return {
          content: JSON.stringify({
            strongestSupport: SCRIPTED_POLICY_VIOLATION_CONTENT,
            strongestOpposition: "Deterministic strongest case against.",
            agreements: [],
            unresolved: "Deterministic unresolved tradeoff.",
            claimsToVerify: [],
            takeaway: "Deterministic takeaway.",
          }),
          model: SCRIPTED_MODEL_ID,
        };
      case "invalid-response":
        return {
          content: "this is not valid synthesis JSON at all",
          model: SCRIPTED_MODEL_ID,
        };
      case "success":
        return {
          content:
            outcome.content ??
            defaultScriptedSynthesisContent(
              input.topic,
              input.transcript.length,
            ),
          model: SCRIPTED_MODEL_ID,
        };
    }
  }
}

/** The composition-root adapter; kept here so both consumers share one instance. */
export const scriptedDiscussion = new ScriptedDiscussion();
