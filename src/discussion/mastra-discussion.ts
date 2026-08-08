import {
  DiscussionCancelledError,
  DiscussionGenerationError,
  DiscussionGenerationOutputLimitError,
  type Discussion,
  type DiscussionUsage,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
  type GenerateSynthesisInput,
  type GeneratedSynthesis,
} from "./discussion";

interface MastraGenerationResponse {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface MastraDiscussionAgent {
  /**
   * Stable provider/model identifier, reported through operational
   * telemetry for cost and reliability investigation.
   */
  readonly modelId: string;
  generate(
    prompt: string,
    options: {
      abortSignal?: AbortSignal;
      modelSettings?: { maxOutputTokens?: number };
    },
  ): Promise<MastraGenerationResponse>;
}

export interface MastraDiscussionAgents {
  readonly supporter: MastraDiscussionAgent;
  readonly opponent: MastraDiscussionAgent;
  /**
   * Neutral synthesis of a completed debate. Consumed only by the
   * server-owned completion step; the agent is not a "third judge" — it
   * never speaks in the debate, never enters the Transcript, and never
   * advances the Turn count.
   */
  readonly synthesizer: MastraDiscussionAgent;
}

const SYNTHESIS_OUTPUT_INSTRUCTION = `
Output STRICT JSON only, with exactly this shape and nothing else:
{
  "strongestSupport": string,
  "strongestOpposition": string,
  "agreements": string[],
  "unresolved": string,
  "claimsToVerify": string[],
  "takeaway": string
}
Rules:
- Every field must be non-empty (agreements and claimsToVerify may be empty arrays).
- strongestSupport: the strongest case FOR the topic as actually argued.
- strongestOpposition: the strongest case AGAINST the topic as actually argued.
- agreements: points both sides actually converged on (may be empty).
- unresolved: the tradeoffs or questions neither side resolved.
- claimsToVerify: factual claims from either side that deserve independent verification (may be empty).
- takeaway: one practical takeaway a neutral reader can act on.
- Be strictly neutral: argue neither side, favor neither side, and never invent arguments that did not appear.
`.trim();

/** Neutral, identity-free prompt for the completion synthesis. */
export function buildSynthesisPrompt(input: {
  topic: string;
  transcript: readonly { speaker: string; content: string }[];
}): string {
  const transcript = input.transcript
    .map(
      (message) =>
        `${message.speaker === "supporter" ? "Supporter" : "Opponent"}: ${message.content}`,
    )
    .join("\n\n");

  return `
You are a neutral synthesis assistant. Produce a balanced, bounded synthesis of the completed debate below. You are NOT a participant, a judge, or a third debater: you never take a side, never reply to either speaker, and never add new arguments.

Topic:
${input.topic}

Debate transcript:
${transcript}

${SYNTHESIS_OUTPUT_INSTRUCTION}
    `.trim();
}

function buildPrompt(input: GenerateDiscussionTurnInput): string {
  const transcript = input.transcript
    .map(
      (message) =>
        `${message.speaker === "supporter" ? "Supporter" : "Opponent"}: ${message.content}`,
    )
    .join("\n\n");

  return `
Topic:
${input.topic}

Conversation so far:
${transcript || "No messages yet."}

${
  input.transcript.length === 0
    ? "Open the discussion with the strongest initial argument for your assigned position."
    : "Respond directly to the latest argument while staying within your assigned role."
}
    `.trim();
}

const RETRYABLE_PROVIDER_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const MAX_PROVIDER_ERROR_CAUSE_DEPTH = 8;

function isRetryableProviderError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < MAX_PROVIDER_ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);

    try {
      const candidate = current as Record<string, unknown>;
      if (typeof candidate.isRetryable === "boolean") {
        return candidate.isRetryable;
      }

      const status =
        typeof candidate.status === "number"
          ? candidate.status
          : typeof candidate.statusCode === "number"
            ? candidate.statusCode
            : undefined;
      if (status !== undefined && status >= 100 && status <= 599) {
        return (
          status === 408 ||
          status === 425 ||
          status === 429 ||
          status >= 500
        );
      }

      if (
        typeof candidate.code === "string" &&
        RETRYABLE_PROVIDER_CODES.has(candidate.code)
      ) {
        return true;
      }

      current = candidate.cause;
    } catch {
      return false;
    }
  }

  return false;
}

function normalizeUsage(
  usage: MastraGenerationResponse["usage"],
): DiscussionUsage | undefined {
  if (
    !usage ||
    (usage.inputTokens === undefined &&
      usage.outputTokens === undefined &&
      usage.totalTokens === undefined)
  ) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

/** Discussion implementation backed by the registered Mastra debate agents. */
export class MastraDiscussion implements Discussion {
  constructor(private readonly agents: MastraDiscussionAgents) {}

  async generateTurn(
    input: GenerateDiscussionTurnInput,
  ): Promise<GeneratedDiscussionTurn> {
    if (input.signal?.aborted) {
      throw new DiscussionCancelledError();
    }

    try {
      const response = await this.agents[input.speaker].generate(
        buildPrompt(input),
        {
          abortSignal: input.signal,
          ...(input.maxOutputTokens !== undefined
            ? { modelSettings: { maxOutputTokens: input.maxOutputTokens } }
            : {}),
        },
      );

      if (input.signal?.aborted) {
        throw new DiscussionCancelledError();
      }
      if (
        input.maxOutputCharacters !== undefined &&
        response.text.length > input.maxOutputCharacters
      ) {
        throw new DiscussionGenerationOutputLimitError();
      }

      return {
        content: response.text,
        usage: normalizeUsage(response.usage),
        model: this.agents[input.speaker].modelId,
      };
    } catch (error) {
      if (error instanceof DiscussionGenerationOutputLimitError) {
        throw error;
      }
      if (error instanceof DiscussionCancelledError || input.signal?.aborted) {
        throw new DiscussionCancelledError();
      }

      throw new DiscussionGenerationError(
        error,
        isRetryableProviderError(error),
      );
    }
  }

  async generateSynthesis(
    input: GenerateSynthesisInput,
  ): Promise<GeneratedSynthesis> {
    if (input.signal?.aborted) {
      throw new DiscussionCancelledError();
    }

    try {
      const response = await this.agents.synthesizer.generate(
        buildSynthesisPrompt({
          topic: input.topic,
          transcript: input.transcript.map((message) => ({
            speaker: message.speaker,
            content: message.content,
          })),
        }),
        {
          abortSignal: input.signal,
          ...(input.maxOutputTokens !== undefined
            ? { modelSettings: { maxOutputTokens: input.maxOutputTokens } }
            : {}),
        },
      );

      if (input.signal?.aborted) {
        throw new DiscussionCancelledError();
      }
      if (
        input.maxOutputCharacters !== undefined &&
        response.text.length > input.maxOutputCharacters
      ) {
        throw new DiscussionGenerationOutputLimitError();
      }

      return {
        content: response.text,
        usage: normalizeUsage(response.usage),
        model: this.agents.synthesizer.modelId,
      };
    } catch (error) {
      if (error instanceof DiscussionGenerationOutputLimitError) {
        throw error;
      }
      if (error instanceof DiscussionCancelledError || input.signal?.aborted) {
        throw new DiscussionCancelledError();
      }

      throw new DiscussionGenerationError(
        error,
        isRetryableProviderError(error),
      );
    }
  }
}
