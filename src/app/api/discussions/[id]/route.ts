import { discussionHttpHandlers } from "../composition";

type DiscussionRouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: DiscussionRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  return (await discussionHttpHandlers).get(request, id);
}

export async function POST(
  request: Request,
  context: DiscussionRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  return (await discussionHttpHandlers).postTurn(request, id);
}
