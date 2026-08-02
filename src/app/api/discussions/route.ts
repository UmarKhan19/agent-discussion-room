import { discussionHttpHandlers } from "./composition";

export async function POST(request: Request): Promise<Response> {
  return discussionHttpHandlers.post(request);
}
