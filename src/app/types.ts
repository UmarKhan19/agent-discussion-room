import type {
  DiscussionMessage,
  Speaker,
} from "@/discussion/discussion";

export type Sender = Speaker;
export type Message = DiscussionMessage;

export interface ServerRequestData {
  topic: string;
  speaker: Sender;
  messages: Message[];
}
