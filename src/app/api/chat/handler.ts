import { ServerRequestData } from "@/app/types";
import type { Discussion } from "@/discussion/discussion";

export function createChatPostHandler(discussion: Discussion) {
  return async function POST(request: Request) {
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

      const generatedTurn = await discussion.generateTurn({
        topic: data.topic,
        speaker: data.speaker,
        transcript: data.messages,
        signal: request.signal,
      });

      return new Response(
        JSON.stringify({
          id: crypto.randomUUID(),
          content: generatedTurn.content,
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
  };
}
