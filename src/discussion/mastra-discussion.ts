import {
  DiscussionCancelledError,
  DiscussionGenerationError,
  type Discussion,
  type DiscussionUsage,
  type GenerateDiscussionTurnInput,
  type GeneratedDiscussionTurn,
  type Speaker,
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
  generate(
    prompt: string,
    options: { abortSignal?: AbortSignal },
  ): Promise<MastraGenerationResponse>;
}

export type MastraDiscussionAgents = Record<Speaker, MastraDiscussionAgent>;

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

function isRetryableProviderError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  try {
    const candidate = error as Record<string, unknown>;
    if (candidate.isRetryable === true) return true;

    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;
    if (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (status !== undefined && status >= 500 && status <= 599)
    ) {
      return true;
    }

    return (
      typeof candidate.code === "string" &&
      RETRYABLE_PROVIDER_CODES.has(candidate.code)
    );
  } catch {
    return false;
  }
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
        { abortSignal: input.signal },
      );

      if (input.signal?.aborted) {
        throw new DiscussionCancelledError();
      }

      return {
        content: response.text,
        usage: normalizeUsage(response.usage),
      };
    } catch (error) {
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
