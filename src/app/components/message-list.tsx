import { type Message } from "../types";

export const MessageList: React.FC<{ messages: Message[] }> = ({
  messages,
}) => {
  return (
    <div className="flex flex-col space-y-4 w-full">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`p-4 rounded-lg w-3/4 ${
            message.sender === "supporter"
              ? "bg-blue-500 text-white self-start"
              : "bg-green-500 text-white self-end"
          }`}
        >
          {message.content}
        </div>
      ))}
    </div>
  );
};
