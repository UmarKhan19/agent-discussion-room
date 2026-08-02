"use client";

import { useEffect, useState } from "react";
import type { ServerRequestData, Message, Sender } from "./types";
import { MessageList } from "./components/message-list";

const TOPIC = "Remote work is better than working from an office";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isActive, setIsActive] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [speaker, setSpeaker] = useState<Sender>("supporter");

  useEffect(() => {
    const generateMessage = async () => {
      setIsGenerating(true);

      const requestPayload: ServerRequestData = {
        messages,
        topic: TOPIC,
        speaker,
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        });

        if (!response.ok) {
          throw new Error(`Error: ${response.statusText}`);
        }

        const newMessage: Message = await response.json();

        setMessages((prevMessages) => [...prevMessages, newMessage]);

        setSpeaker((prevSpeaker) =>
          prevSpeaker === "supporter" ? "opponent" : "supporter",
        );
      } catch (error) {
        console.error("Failed to generate message:", error);
        setIsActive(false);
      } finally {
        setIsGenerating(false);
      }
    };

    if (isActive && !isGenerating) {
      void generateMessage();
    }
  }, [isActive, isGenerating, messages, speaker]);

  return (
    <main className="flex min-h-screen flex-col items-center p-24 bg-neutral-900">
      <h1 className="text-2xl">Welcome to the Agents Discussion Room</h1>
      <div>
        <button onClick={() => setIsActive((prev) => !prev)} className="mt-4">
          {isActive ? (
            <span className="bg-red-500 text-white px-4 py-2 rounded-lg mt-4">
              Stop Discussion
            </span>
          ) : (
            <span className="bg-green-500 text-white px-4 py-2 rounded-lg mt-4">
              Start Discussion
            </span>
          )}
        </button>
      </div>
      <h2 className="text-xl mt-4">{TOPIC}</h2>
      <div className="flex-1 max-h-180 overflow-auto flex flex-col items-center mt-8 max-w-4xl w-full bg-neutral-700 p-6 rounded-lg shadow-md">
        <MessageList messages={messages} />
      </div>
    </main>
  );
}
