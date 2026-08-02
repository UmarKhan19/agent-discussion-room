export type Sender = "supporter" | "opponent";

export interface Message {
  id: string;
  content: string;
  sender: Sender;
}

export interface ServerRequestData {
  topic: string;
  speaker: Sender;
  messages: Message[];
}
