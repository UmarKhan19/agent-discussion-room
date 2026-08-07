import { discussionHttpHandlers } from "./composition";

export async function POST(request: Request): Promise<Response> {
  return (await discussionHttpHandlers).post(request);
}
