import { ServerRequestData } from "@/app/types";
import { mastra } from "@/mastra";

export async function POST(request: Request) {
  try {
    const data = (await request.json()) as ServerRequestData;

    if (!data.topic.trim()) {
      return new Response(JSON.stringify({ error: "Topic cannot be empty" }), {
        status: 400,
      });
    }

    if (
      !data.speaker ||
      (data.speaker !== "supporter" && data.speaker !== "opponent")
    ) {
      return new Response(JSON.stringify({ error: "Invalid speaker" }), {
        status: 400,
      });
    }

    const agentId =
      data.speaker === "supporter" ? "supporter-agent" : "opponent-agent";

    const agent = mastra.getAgentById(agentId);

    const recentMessages = data.messages.slice(-8);

    const transcript = recentMessages
      .map(
        (message) =>
          `${message.sender === "supporter" ? "Supporter" : "Opponent"}: ${message.content}`,
      )
      .join("\n\n");

    const isFirstTurn = data.messages.length === 0;

    const prompt = `
Topic:
${data.topic}

Conversation so far:
${transcript || "No messages yet."}

${
  isFirstTurn
    ? "Open the discussion with the strongest initial argument for your assigned position."
    : "Respond directly to the latest argument while staying within your assigned role."
}
    `.trim();

    const response = await agent.generate(prompt);

    return new Response(
      JSON.stringify({
        id: crypto.randomUUID(),
        content: response.text,
        sender: data.speaker,
      }),
      {
        status: 200,
      },
    );
  } catch (error) {
    console.error("Failed to generate discussion turn:", error);

    return Response.json(
      { error: "Failed to generate response" },
      { status: 500 },
    );
  }
}
