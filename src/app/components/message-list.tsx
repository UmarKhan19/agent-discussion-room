import type { DiscussionMessage } from "@/discussion/contracts";

export function MessageList({
  messages,
}: {
  messages: readonly DiscussionMessage[];
}) {
  if (messages.length === 0) {
    return <p>No Turns yet. The Transcript is empty.</p>;
  }

  return (
    <ol className="flex flex-col gap-4 w-full">
      {messages.map((message) => (
        <li
          key={message.id}
          className={`p-4 rounded-lg w-3/4 ${
            message.speaker === "supporter"
              ? "bg-blue-700 text-white self-start"
              : "bg-green-700 text-white self-end"
          }`}
        >
          <strong>
            {message.speaker === "supporter" ? "Supporter" : "Opponent"}
          </strong>
          <p>{message.content}</p>
        </li>
      ))}
    </ol>
  );
}
