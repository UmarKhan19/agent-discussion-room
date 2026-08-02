import { discussion } from "@/mastra";
import { createChatPostHandler } from "./handler";

export const POST = createChatPostHandler(discussion);
