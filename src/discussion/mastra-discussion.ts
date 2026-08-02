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

const RECENT_TRANSCRIPT_LIMIT = 8;

function buildPrompt(input: GenerateDiscussionTurnInput): string {
  const transcript = input.transcript
    .slice(-RECENT_TRANSCRIPT_LIMIT)
    .map(
      (message) =>
        `${message.sender === "supporter" ? "Supporter" : "Opponent"}: ${message.content}`,
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

      throw new DiscussionGenerationError(error);
    }
  }
}
